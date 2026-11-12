use super::*;
use crate::routine_execution_fixture::{quiet_summary, Scheduler};
use milagre_owner_store::{
    chat_host::ChatHost,
    states::{ProjectStates, Timing},
};
use milagre_routines::StoreCommand;
use std::{
    ops::{Deref, DerefMut},
    sync::Mutex,
    time::Instant,
};
const NOW: i64 = 1_790_000_000_000;
struct Held<T>(Option<T>);
impl<T> Held<T> {
    fn take(&mut self) -> T {
        self.0.take().expect("fixture owns its teardown state")
    }
}
impl<T> Deref for Held<T> {
    type Target = T;
    fn deref(&self) -> &T {
        self.0.as_ref().expect("fixture state is present")
    }
}
impl<T> DerefMut for Held<T> {
    fn deref_mut(&mut self) -> &mut T {
        self.0.as_mut().expect("fixture state is present")
    }
}
struct Harness {
    host: Held<ChatHost>,
    scheduler: Held<Scheduler>,
    monitor: FixtureMonitor,
    root: Arc<DataRoot>,
    profile: Arc<IsolatedProfile>,
}
struct RetainedFixture {
    host: ChatHost,
    scheduler: Scheduler,
    monitor: FixtureMonitor,
    root: Arc<DataRoot>,
    _profile: Arc<IsolatedProfile>,
    failures: Vec<String>,
}
static RETAINED_FIXTURES: Mutex<Vec<RetainedFixture>> = Mutex::new(Vec::new());
impl RetainedFixture {
    fn cleanup(&mut self) -> bool {
        self.failures.clear();
        if let Err(error) = self.scheduler.store.close() {
            self.failures.push(error.to_string());
        }
        if let Err(error) = self.host.shutdown(true) {
            self.failures.push(error.to_string());
        }
        if !self.monitor.wait_drained(Duration::from_secs(5)) {
            self.failures
                .push("actual native cleanup is still pending".into());
        }
        self.failures.is_empty()
    }
}
fn cleanup_retained_fixture(path: &Path) -> Result<(), Vec<String>> {
    let mut retained = {
        let mut parked = RETAINED_FIXTURES.lock().unwrap_or_else(|p| p.into_inner());
        let index = parked
            .iter()
            .position(|value| value.root.isolation.root() == path)
            .expect("exact failed fixture remains retained");
        parked.remove(index)
    };
    if retained.cleanup() {
        return Ok(());
    }
    let errors = retained.failures.clone();
    RETAINED_FIXTURES
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .push(retained);
    Err(errors)
}
impl Harness {
    fn new(reply: &str, stop: bool) -> Self {
        let profile = Arc::new(IsolatedProfile::create().unwrap());
        let root = profile.path().join("data");
        let executable = std::env::current_exe().unwrap();
        let mut directory = executable.parent().unwrap();
        if directory.file_name().is_some_and(|n| n == "deps") {
            directory = directory.parent().unwrap();
        }
        let program = directory
            .join("runtime-fake-claude")
            .canonicalize()
            .unwrap();
        let bundle = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/core/src/bundled-skills")
            .canonicalize()
            .unwrap();
        let config=LaunchConfig::parse(json!({"program":program,"home":root.join("home"),"configDirectory":root.join("account"),"skillsDirectory":bundle,"model":"sonnet","path":"/usr/bin:/bin","accountId":"11111111-1111-4111-8111-111111111111","accountLabel":"Synthetic schedule account","userName":"routine-fixture"}),true).unwrap();
        let root = DataRoot::create(&root, config).unwrap();
        fs::create_dir(&root.config.home).unwrap();
        fs::create_dir(&root.config.config_directory).unwrap();
        Self::attach(root, profile, reply, stop, NOW)
    }
    fn attach(
        root: Arc<DataRoot>,
        profile: Arc<IsolatedProfile>,
        reply: &str,
        stop: bool,
        now: i64,
    ) -> Self {
        let accounts = root.config.accounts().unwrap();
        let selection = accounts.pin(root.project().to_str()).unwrap();
        assert_eq!(
            selection.account_id("claude").unwrap(),
            root.config.account_id
        );
        let script = profile.path().join("schedule-native.json");
        let mut steps = vec![
            json!({"expect":{"subtype":"initialize"}}),
            json!({"reply":{}}),
            json!({"expect":{"subtype":"set_max_thinking_tokens"}}),
            json!({"reply":{}}),
            json!({"expect":{"type":"user"}}),
            json!({"emit":{"type":"system","subtype":"init","session_id":"schedule-native-session"}}),
        ];
        if !stop {
            steps[4]["expect"]["fields"] = json!({"/message/content/0/text":"Check isolated schedule\n\nIf nothing needs doing, reply starting with \"(pass)\" and a short reason."});
        }
        if stop {
            steps.extend([
                json!({"expect":{"subtype":"interrupt"}}),
                json!({"reply":{}}),
            ]);
        } else {
            steps.extend([json!({"emit":{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":reply}}}}),json!({"emit":{"type":"result","subtype":"success","num_turns":1,"result":"done"}})]);
        }
        steps.push(json!({"wait_eof":true}));
        fs::write(&script, Value::Array(steps).to_string()).unwrap();
        let mut launch = LaunchOptions::new(&root.config.program);
        launch.cwd = Some(root.project());
        launch.env = Some(vec![
            ("HOME".into(), root.config.home.clone().into_os_string()),
            (
                "CLAUDE_CONFIG_DIR".into(),
                root.config.config_directory.clone().into_os_string(),
            ),
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("USER".into(), "routine-fixture".into()),
            ("LOGNAME".into(), "routine-fixture".into()),
            ("FAKE_CLAUDE_SCRIPT".into(), script.into_os_string()),
        ]);
        let provider = ClaudeProvider::configured(ClaudeLaunchContext {
            isolation: root.isolation.clone(),
            project: root.project(),
            launch,
            ordinary: ClaudeInstructionInputs::bundled(
                &root.config.skills_directory,
                crate::instructions::HostNetwork::default(),
                false,
            )
            .unwrap(),
            lifetime: Some(root.clone()),
        })
        .unwrap();
        let monitor = provider.monitor();
        let mut host = ChatHost::new(ProjectStates::new(
            root.isolation.clone(),
            Timing::default(),
            now,
        ));
        host.register(Box::new(provider));
        host.open_project(&root.project()).unwrap();
        let retained = root.clone();
        let scheduler = Scheduler::open(
            root.isolation.root(),
            root.project(),
            root.config.model.clone(),
            Arc::new(move || retained.check().map_err(|e| e.message)),
            now,
            None,
        )
        .unwrap();
        Self {
            host: Held(Some(host)),
            scheduler: Held(Some(scheduler)),
            monitor,
            root,
            profile,
        }
    }
    fn create(&mut self, name: &str) -> Value {
        self.scheduler.store.execute(StoreCommand::Create(json!({"name":name,"prompt":"Check isolated schedule","trigger":{"kind":"schedule","cron":"* * * * *","timezone":"UTC"},"target":{"kind":"chat","chatId":format!("{}#1",self.root.project().display())},"permissionMode":"ask","provider":"claude","model":"sonnet","maxRuns":1,"createdBy":{"kind":"user"}})),NOW).unwrap().value
    }
    fn create_new(&mut self, name: &str) -> Value {
        self.scheduler.store.execute(StoreCommand::Create(json!({"name":name,"prompt":"Check isolated schedule","trigger":{"kind":"schedule","cron":"* * * * *","timezone":"UTC"},"target":{"kind":"new-chat","projectPath":self.root.project(),"workspace":"project"},"permissionMode":"ask","provider":"claude","model":"sonnet","maxRuns":1,"createdBy":{"kind":"user"}})), NOW).unwrap().value
    }
    fn run_until_finished(&mut self, at: i64) {
        let deadline = Instant::now() + Duration::from_secs(5);
        let start = Instant::now();
        loop {
            self.scheduler
                .tick(&mut self.host, at + start.elapsed().as_millis() as i64)
                .unwrap();
            if self.scheduler.pending() == 0 {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "actual native Routine turn did not end"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    fn finish(&mut self) {
        self.scheduler.stop(&mut self.host).unwrap();
        assert_eq!(self.scheduler.pending(), 0);
        self.scheduler.close().unwrap();
        self.host.shutdown(true).unwrap();
        assert!(self.monitor.wait_drained(Duration::from_secs(5)));
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        let mut retained = RetainedFixture {
            host: self.host.take(),
            scheduler: self.scheduler.take(),
            monitor: self.monitor.clone(),
            root: self.root.clone(),
            _profile: self.profile.clone(),
            failures: Vec::new(),
        };
        let cleanup = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| retained.cleanup()));
        if !matches!(cleanup, Ok(true)) {
            if cleanup.is_err() {
                retained.failures.push("fixture cleanup panicked".into());
            }
            let _ = writeln!(
                std::io::stderr(),
                "ROUTINE_FIXTURE_CLEANUP_FAILED: {}; private owner and profile retained",
                retained.failures.join("; ")
            );
            // Keep the actual dirty host and store, not just their directory paths.
            // Explicit exact-root recovery retries these same owners after repair.
            RETAINED_FIXTURES
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(retained);
        }
    }
}
#[test]
fn actual_native_due_claim_saves_context_terminal_and_run_then_reopens_without_replay() {
    let mut f = Harness::new("Scheduled actual native reply", false);
    let row = f.create("Actual native schedule");
    let id = row["id"].as_str().unwrap().to_owned();
    let due = row["nextRunAt"].as_i64().unwrap();
    f.run_until_finished(due);
    let runs = f
        .scheduler
        .store
        .execute(StoreCommand::Runs(id.clone()), due + 1000)
        .unwrap()
        .value;
    assert_eq!(runs.as_array().unwrap().len(), 1);
    assert_eq!(runs[0]["status"], "acted");
    let run_id = runs[0]["id"].as_str().unwrap();
    assert_eq!(run_id.len(), 8);
    let state = f.host.states.whole_state(&f.root.project()).unwrap();
    assert_eq!(state["messages"][0]["context"]["runId"], run_id);
    assert_eq!(state["messages"][0]["context"]["routineId"], id);
    assert_eq!(
        state["messages"][1]["body"],
        "Scheduled actual native reply"
    );
    assert_eq!(state["messages"][1]["outcome"], "completed");
    assert!(f
        .monitor
        .pid(&format!("{}#1", f.root.project().display()))
        .is_some());
    let profile = f.profile.clone();
    let path = f.root.isolation.root().to_owned();
    f.finish();
    drop(f);
    let reopened = DataRoot::open(&path, true).unwrap();
    let mut next = Harness::attach(reopened, profile, "Unexpected replay", false, due + 2000);
    next.scheduler.tick(&mut next.host, due + 60_000).unwrap();
    assert_eq!(next.scheduler.pending(), 0);
    assert_eq!(next.monitor.workers(), 0);
    assert_eq!(
        next.scheduler
            .store
            .execute(StoreCommand::Runs(id), due + 60_000)
            .unwrap()
            .value,
        runs
    );
    assert_eq!(
        next.host.states.whole_state(&next.root.project()).unwrap()["messages"],
        state["messages"]
    );
    next.finish();
}
#[test]
fn busy_chat_is_durably_skipped_without_queuing_a_schedule_or_replacing_the_user_turn() {
    let mut f = Harness::new("unused", true);
    let row = f.create("Busy fixture");
    let due = row["nextRunAt"].as_i64().unwrap();
    f.host.send(&json!({"projectPath":f.root.project(),"sessionId":1,"worktreeId":1,"provider":"claude","model":"sonnet","permissionMode":"ask","body":"User already runs"})).unwrap();
    let before = f.host.states.whole_state(&f.root.project()).unwrap();
    f.scheduler.tick(&mut f.host, due).unwrap();
    assert_eq!(f.scheduler.pending(), 0);
    let runs = f
        .scheduler
        .store
        .execute(StoreCommand::Runs(row["id"].as_str().unwrap().into()), due)
        .unwrap()
        .value;
    assert_eq!(runs[0]["status"], "skipped-busy");
    let after = f.host.states.whole_state(&f.root.project()).unwrap();
    assert_eq!(
        after["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["role"] == "user")
            .count(),
        1
    );
    assert_eq!(
        before["sessions"]["1"].get("queued"),
        after["sessions"]["1"].get("queued")
    );
    f.host
        .interrupt(&format!("{}#1", f.root.project().display()))
        .unwrap();
    let start = Instant::now();
    while f
        .host
        .active_turn(&format!("{}#1", f.root.project().display()))
        .is_some()
    {
        assert!(start.elapsed() < Duration::from_secs(5));
        f.host.tick(due + start.elapsed().as_millis() as i64);
        std::thread::sleep(Duration::from_millis(2));
    }
    f.finish();
}
#[test]
fn stopped_scheduler_cancels_actual_native_turn_and_records_failure_without_a_second_claim() {
    let mut f = Harness::new("unused", true);
    let row = f.create("Cancelled fixture");
    let due = row["nextRunAt"].as_i64().unwrap();
    f.scheduler.tick(&mut f.host, due).unwrap();
    assert_eq!(f.scheduler.pending(), 1);
    let started = Instant::now();
    loop {
        assert!(f
            .host
            .tick(due + started.elapsed().as_millis() as i64)
            .is_empty());
        if f.host.take_notices().iter().any(|notice|matches!(notice,milagre_owner_store::chat_host::Notice::Event{event,..} if event["type"]=="session-started")) {break;}
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "native child never emitted its init frame"
        );
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(f
        .monitor
        .pid(&format!("{}#1", f.root.project().display()))
        .is_some());
    f.scheduler.stop(&mut f.host).unwrap();
    f.run_until_finished(due + 1000);
    let runs = f
        .scheduler
        .store
        .execute(
            StoreCommand::Runs(row["id"].as_str().unwrap().into()),
            due + 2000,
        )
        .unwrap()
        .value;
    assert_eq!(runs[0]["status"], "failed");
    assert_eq!(runs[0]["error"], "cancelled");
    f.scheduler.tick(&mut f.host, due + 600_000).unwrap();
    assert_eq!(
        f.scheduler
            .store
            .execute(
                StoreCommand::Runs(row["id"].as_str().unwrap().into()),
                due + 600_000
            )
            .unwrap()
            .value
            .as_array()
            .unwrap()
            .len(),
        1
    );
    f.finish();
}
#[test]
fn quiet_classification_matches_actual_node_parser() {
    let cases = vec![
        "ordinary reply".into(),
        "(PASS) CI green\nother line".into(),
        "\u{feff}**_(pass) ** fine".into(),
        "\u{85}(pass) no".into(),
        format!("(pass) {}", "word ".repeat(30)),
        format!("(pass) {}", "a".repeat(85)),
        "(pass) done\u{2028}ignored".into(),
    ];
    let source="import{parsePass}from './packages/shared/src/routines.mjs';let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify(JSON.parse(s).map(parsePass)));";
    let mut child = std::process::Command::new("node")
        .args(["--input-type=module", "-e", source])
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(&cases).unwrap().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let expected: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap();
    for (text, want) in cases.iter().zip(expected) {
        let got = quiet_summary(&milagre_owner_store::jsjson::js_string(text)).unwrap();
        assert_eq!(
            got.map_or(
                json!({"quiet":false}),
                |s| json!({"quiet":true,"summary":s})
            ),
            want,
            "{text}"
        );
    }
}

#[test]
fn durable_claim_without_a_dispatch_recovers_failed_and_never_sends_after_restart() {
    let mut f = Harness::new("Must not run", false);
    let row = f.create("Unknown prior launch");
    let id = row["id"].as_str().unwrap().to_owned();
    let due = row["nextRunAt"].as_i64().unwrap();
    let claims = f
        .scheduler
        .store
        .execute(StoreCommand::ClaimDue { at: due }, due)
        .unwrap()
        .value;
    assert_eq!(claims.as_array().unwrap().len(), 1);
    let run_id = claims[0]["run"]["id"].clone();
    assert_eq!(f.monitor.workers(), 0);
    let profile = f.profile.clone();
    let path = f.root.isolation.root().to_owned();
    f.finish();
    drop(f);
    let root = DataRoot::open(&path, true).unwrap();
    let mut next = Harness::attach(root, profile, "Unexpected replay", false, due + 1000);
    let runs = next
        .scheduler
        .store
        .execute(StoreCommand::Runs(id), due + 1000)
        .unwrap()
        .value;
    assert_eq!(runs[0]["id"], run_id);
    assert_eq!(runs[0]["status"], "failed");
    assert_eq!(runs[0]["error"], "daemon restarted");
    next.scheduler.tick(&mut next.host, due + 60_000).unwrap();
    assert_eq!(next.monitor.workers(), 0);
    assert!(
        next.host.states.whole_state(&next.root.project()).unwrap()["messages"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    next.finish();
}

#[test]
fn actual_manifest_revocation_before_claim_keeps_saved_bytes_and_starts_no_native_child() {
    let mut f = Harness::new("Must not run", false);
    let row = f.create("Revoked before claim");
    let due = row["nextRunAt"].as_i64().unwrap();
    let file = f.root.isolation.root().join("routines/routines.json");
    let before = fs::read(&file).unwrap();
    let manifest = f.root.isolation.root().join(MANIFEST);
    let saved = fs::read(&manifest).unwrap();
    fs::write(&manifest, b"{}").unwrap();
    assert!(f.scheduler.tick(&mut f.host, due).is_err());
    assert_eq!(f.monitor.workers(), 0);
    assert_eq!(fs::read(file).unwrap(), before);
    fs::write(manifest, saved).unwrap();
    assert!(
        f.scheduler.tick(&mut f.host, due).is_err(),
        "restoration does not revive a fenced scheduler"
    );
    f.finish();
}

#[test]
fn failed_store_close_or_owner_save_retains_the_full_fixture_even_after_native_drain() {
    for fault in ["store-close", "owner-save"] {
        let mut f = Harness::new("No native turn", false);
        assert_eq!(f.monitor.workers(), 0);
        assert!(f.monitor.wait_drained(Duration::from_millis(1)));
        let path = f.root.isolation.root().to_owned();
        let root = Arc::downgrade(&f.root);
        let profile = Arc::downgrade(&f.profile);
        let manifest = path.join(MANIFEST);
        let original = fs::read(&manifest).unwrap();
        let coordination = f.root.project().join(".milagre/coordination.json");
        let saved = coordination.with_extension("fixture-saved");
        if fault == "store-close" {
            fs::write(&manifest, b"{}").unwrap();
        } else {
            f.host
                .states
                .update(&path.join("project"), None, true, |state| {
                    Some(state.with_field("retainedDuringFailedShutdown", json!(true)))
                })
                .unwrap();
            fs::rename(&coordination, &saved).unwrap();
            fs::create_dir(&coordination).unwrap();
        }
        drop(f);
        assert!(
            root.upgrade().is_some(),
            "{fault}: failed close must retain the actual root lease"
        );
        let preserved_profile = profile
            .upgrade()
            .expect("failed cleanup must retain the outer TempDir owner");
        assert!(path.exists());
        assert!(manifest.exists());
        {
            let retained = RETAINED_FIXTURES.lock().unwrap();
            let exact = retained
                .iter()
                .find(|value| value.root.isolation.root() == path)
                .unwrap();
            assert!(exact.monitor.wait_drained(Duration::from_millis(1)));
            assert!(!exact.failures.is_empty());
            if fault == "owner-save" {
                assert!(exact.host.close_pending());
                assert!(coordination.is_dir());
            }
        }
        if fault == "store-close" {
            fs::write(&manifest, &original).unwrap();
        } else {
            fs::remove_dir(&coordination).unwrap();
            fs::rename(&saved, &coordination).unwrap();
        }
        assert_eq!(
            DataRoot::open(&path, true).err().unwrap().code,
            "CHAT_ROOT_BUSY"
        );
        cleanup_retained_fixture(&path).unwrap();
        assert!(
            root.upgrade().is_none(),
            "explicit successful cleanup releases the old owner"
        );
        let reopened = DataRoot::open(&path, true).unwrap();
        if fault == "owner-save" {
            let disk: Value =
                serde_json::from_slice(&read_coordination(&coordination).unwrap()).unwrap();
            assert_eq!(
                disk["retainedDuringFailedShutdown"], true,
                "the same retained dirty host retries its save"
            );
        }
        drop(reopened);
        drop(preserved_profile);
        assert!(!path.exists());
    }
}

#[test]
fn terminal_saved_before_finish_revocation_stays_running_on_disk_and_restart_never_replays() {
    let mut f = Harness::new("Native completed before routine write fault", false);
    let row = f.create("Finish uncertainty");
    let id = row["id"].as_str().unwrap().to_owned();
    let due = row["nextRunAt"].as_i64().unwrap();
    f.scheduler.tick(&mut f.host, due).unwrap();
    assert_eq!(f.scheduler.pending(), 1);
    let start = Instant::now();
    loop {
        assert!(f
            .host
            .tick(due + start.elapsed().as_millis() as i64)
            .is_empty());
        let state = f.host.states.whole_state(&f.root.project()).unwrap();
        if state["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["role"] == "assistant" && m["outcome"] == "completed")
        {
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(2));
    }
    let manifest = f.root.isolation.root().join(MANIFEST);
    let saved = fs::read(&manifest).unwrap();
    fs::write(&manifest, b"{}").unwrap();
    assert!(f.scheduler.tick(&mut f.host, due + 1000).is_err());
    let disk: Value = serde_json::from_slice(
        &fs::read(f.root.isolation.root().join("routines/routines.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        disk["runs"][&id][0]["status"], "running",
        "no unpersisted finish is acknowledged"
    );
    fs::write(manifest, saved).unwrap();
    assert!(f.scheduler.tick(&mut f.host, due + 2000).is_err());
    // Explicit recovery closes the verified store without fabricating a finish;
    // only the new lifetime's RecoverInterrupted classifies the retained running row.
    f.scheduler.store.close().unwrap();
    f.host.shutdown(true).unwrap();
    assert!(f.monitor.wait_drained(Duration::from_secs(5)));
    let profile = f.profile.clone();
    let path = f.root.isolation.root().to_owned();
    drop(f);
    let root = DataRoot::open(&path, true).unwrap();
    let mut next = Harness::attach(root, profile, "Unexpected replay", false, due + 3000);
    next.scheduler.tick(&mut next.host, due + 60_000).unwrap();
    assert_eq!(next.monitor.workers(), 0);
    let runs = next
        .scheduler
        .store
        .execute(StoreCommand::Runs(id), due + 60_000)
        .unwrap()
        .value;
    assert_eq!(runs[0]["status"], "failed");
    assert_eq!(runs[0]["error"], "daemon restarted");
    let messages = next.host.states.whole_state(&next.root.project()).unwrap()["messages"].clone();
    assert_eq!(messages.as_array().unwrap().len(), 2);
    assert_eq!(
        messages[1]["body"],
        "Native completed before routine write fault"
    );
    assert_eq!(messages[1]["outcome"], "completed");
    next.finish();
}

#[test]
fn expired_schedule_completes_without_claim_or_native_dispatch_and_quiet_turn_is_persisted() {
    let mut expired = Harness::new("Must not run", false);
    let row = expired.create("Expired fixture");
    let due = row["nextRunAt"].as_i64().unwrap();
    let id = row["id"].as_str().unwrap().to_owned();
    expired
        .scheduler
        .store
        .execute(
            StoreCommand::Update {
                id: id.clone(),
                patch: json!({"expiresAt":NOW+1}),
            },
            NOW,
        )
        .unwrap();
    expired.scheduler.tick(&mut expired.host, due).unwrap();
    assert_eq!(expired.monitor.workers(), 0);
    assert!(expired
        .scheduler
        .store
        .execute(StoreCommand::Runs(id.clone()), due)
        .unwrap()
        .value
        .as_array()
        .unwrap()
        .is_empty());
    let saved = expired
        .scheduler
        .store
        .execute(StoreCommand::Get(id), due)
        .unwrap()
        .value;
    assert_eq!(saved["enabled"], false);
    assert!(saved.get("completedAt").is_some());
    expired.finish();
    let mut quiet = Harness::new("(pass) Native fixture clean", false);
    let row = quiet.create("Quiet fixture");
    let due = row["nextRunAt"].as_i64().unwrap();
    quiet.run_until_finished(due);
    let runs = quiet
        .scheduler
        .store
        .execute(
            StoreCommand::Runs(row["id"].as_str().unwrap().into()),
            due + 1000,
        )
        .unwrap()
        .value;
    assert_eq!(runs[0]["status"], "quiet");
    assert_eq!(runs[0]["summary"], "Native fixture clean");
    quiet.finish();
}

#[test]
fn actual_native_new_chat_is_fresh_attached_named_saved_and_not_replayed() {
    let mut f = Harness::new("New scheduled actual native reply", false);
    let row = f.create_new("Fresh native schedule");
    let due = row["nextRunAt"].as_i64().unwrap();
    let id = row["id"].as_str().unwrap().to_owned();
    f.run_until_finished(due);
    let runs = f
        .scheduler
        .store
        .execute(StoreCommand::Runs(id.clone()), due + 1000)
        .unwrap()
        .value;
    assert_eq!(runs[0]["status"], "acted");
    let state = f.host.states.whole_state(&f.root.project()).unwrap();
    let sid = state["messages"][0]["session_id"].as_i64().unwrap();
    assert_ne!(sid, 1, "must not reuse the user's empty starter Chat");
    let chat = format!("{}#{sid}", f.root.project().display());
    assert_eq!(runs[0]["chatId"], chat);
    assert_eq!(runs[0]["worktreeId"], "1");
    let session = &state["sessions"][sid.to_string()];
    assert_eq!(
        session["routine"],
        json!({"routineId":id,"runId":runs[0]["id"],"hidden":true})
    );
    assert_eq!(session["generatedTitle"], "Fresh native schedule");
    assert_eq!(state["sessions"]["1"]["summary"]["count"], 0);
    assert_eq!(
        state["messages"][0]["context"]["label"],
        "Routine · Fresh native schedule"
    );
    assert_eq!(state["messages"][0]["context"]["runId"], runs[0]["id"]);
    assert_eq!(
        state["messages"][1]["body"],
        "New scheduled actual native reply"
    );
    assert_eq!(state["messages"][1]["outcome"], "completed");
    assert!(f.monitor.pid(&chat).is_some());
    let profile = f.profile.clone();
    let path = f.root.isolation.root().to_owned();
    f.finish();
    drop(f);
    let reopened = DataRoot::open(&path, true).unwrap();
    let mut next = Harness::attach(reopened, profile, "Unexpected replay", false, due + 2000);
    next.scheduler.tick(&mut next.host, due + 60_000).unwrap();
    assert_eq!(next.monitor.workers(), 0);
    assert_eq!(
        next.scheduler
            .store
            .execute(StoreCommand::Runs(id), due + 60_000)
            .unwrap()
            .value,
        runs
    );
    assert_eq!(
        next.host.states.whole_state(&next.root.project()).unwrap()["messages"],
        state["messages"]
    );
    next.finish();
}

#[test]
fn new_chat_attachment_failure_fences_before_native_dispatch_and_restart_never_replays() {
    let mut f = Harness::new("Must never dispatch", false);
    let row = f.create_new("Uncertain attachment");
    let due = row["nextRunAt"].as_i64().unwrap();
    let id = row["id"].as_str().unwrap().to_owned();
    let file = f.root.isolation.root().join("routines/routines.json");
    let backup = file.with_extension("saved");
    let fault_file = file.clone();
    let fault_backup = backup.clone();
    f.scheduler.before_attach = Some(Box::new(move || {
        fs::rename(&fault_file, &fault_backup).unwrap();
        fs::create_dir(&fault_file).unwrap();
    }));
    assert!(f.scheduler.tick(&mut f.host, due).is_err());
    assert!(f.scheduler.is_fenced());
    assert_eq!(f.monitor.workers(), 0);
    let created = f.host.states.whole_state(&f.root.project()).unwrap();
    assert_eq!(created["sessions"].as_object().unwrap().len(), 2);
    assert_eq!(created["messages"], json!([]));
    fs::remove_dir(&file).unwrap();
    fs::rename(&backup, &file).unwrap();
    let saved: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    assert_eq!(saved["runs"][&id][0]["status"], "running");
    assert!(saved["runs"][&id][0].get("chatId").is_none());
    assert!(
        f.scheduler.tick(&mut f.host, due + 1000).is_err(),
        "restoring bytes never clears fence"
    );
    let profile = f.profile.clone();
    let path = f.root.isolation.root().to_owned();
    f.finish();
    drop(f);
    let reopened = DataRoot::open(&path, true).unwrap();
    let mut next = Harness::attach(reopened, profile, "Unexpected replay", false, due + 2000);
    next.scheduler.tick(&mut next.host, due + 60_000).unwrap();
    let runs = next
        .scheduler
        .store
        .execute(StoreCommand::Runs(id), due + 60_000)
        .unwrap()
        .value;
    assert_eq!(runs[0]["status"], "failed");
    assert_eq!(runs[0]["error"], "daemon restarted");
    assert_eq!(next.monitor.workers(), 0);
    assert_eq!(
        next.host.states.whole_state(&next.root.project()).unwrap()["sessions"],
        created["sessions"]
    );
    assert_eq!(
        next.host.states.whole_state(&next.root.project()).unwrap()["messages"],
        json!([])
    );
    next.finish();
}

#[test]
fn attached_new_chat_owner_revocation_before_dispatch_keeps_claim_without_replay() {
    let mut f = Harness::new("Must never dispatch", false);
    let row = f.create_new("Revoked after attach");
    let due = row["nextRunAt"].as_i64().unwrap();
    let id = row["id"].as_str().unwrap().to_owned();
    let manifest = f.root.isolation.root().join("rust-chat-runtime.json");
    let bytes = fs::read(&manifest).unwrap();
    let fault = manifest.clone();
    f.scheduler.before_dispatch = Some(Box::new(move || {
        let mut changed = fs::read(&fault).unwrap();
        changed.push(b' ');
        fs::write(fault, changed).unwrap();
    }));
    assert!(f.scheduler.tick(&mut f.host, due).is_err());
    assert_eq!(f.monitor.workers(), 0);
    let saved: Value = serde_json::from_slice(
        &fs::read(f.root.isolation.root().join("routines/routines.json")).unwrap(),
    )
    .unwrap();
    let run = &saved["runs"][&id][0];
    assert_eq!(run["status"], "running");
    assert!(run["chatId"]
        .as_str()
        .unwrap()
        .starts_with(f.root.project().to_str().unwrap()));
    assert_eq!(run["worktreeId"], "1");
    fs::write(manifest, bytes).unwrap();
    assert!(f.scheduler.tick(&mut f.host, due + 1).is_err());
    let created = f.host.states.whole_state(&f.root.project()).unwrap();
    assert_eq!(created["messages"], json!([]));
    let profile = f.profile.clone();
    let path = f.root.isolation.root().to_owned();
    f.finish();
    drop(f);
    let root = DataRoot::open(&path, true).unwrap();
    let mut next = Harness::attach(root, profile, "Unexpected replay", false, due + 2000);
    next.scheduler.tick(&mut next.host, due + 60_000).unwrap();
    let runs = next
        .scheduler
        .store
        .execute(StoreCommand::Runs(id), due + 60_000)
        .unwrap()
        .value;
    assert_eq!(runs[0]["status"], "failed");
    assert_eq!(runs[0]["error"], "daemon restarted");
    assert_eq!(runs[0]["chatId"], run["chatId"]);
    assert_eq!(next.monitor.workers(), 0);
    assert_eq!(
        next.host.states.whole_state(&next.root.project()).unwrap()["messages"],
        json!([])
    );
    next.finish();
}

#[test]
fn quiet_fresh_chat_saves_title_context_archive_and_run_before_restart() {
    let mut f = Harness::new("(pass) All fixture checks clean", false);
    let row = f.create_new("Quiet fresh schedule");
    let due = row["nextRunAt"].as_i64().unwrap();
    f.run_until_finished(due);
    let runs = f
        .scheduler
        .store
        .execute(
            StoreCommand::Runs(row["id"].as_str().unwrap().into()),
            due + 1000,
        )
        .unwrap()
        .value;
    assert_eq!(runs[0]["status"], "quiet");
    assert_eq!(runs[0]["title"], "All fixture checks clean");
    let state = f.host.states.whole_state(&f.root.project()).unwrap();
    let sid = state["messages"][0]["session_id"]
        .as_i64()
        .unwrap()
        .to_string();
    assert_eq!(state["sessions"][&sid]["archived"], true);
    assert_eq!(state["sessions"][&sid]["generatedTitle"], runs[0]["title"]);
    assert_eq!(state["messages"][0]["context"]["quiet"], true);
    assert_eq!(
        state["messages"][0]["context"]["summary"],
        runs[0]["summary"]
    );
    let path = f.root.isolation.root().to_owned();
    let profile = f.profile.clone();
    f.finish();
    drop(f);
    let root = DataRoot::open(&path, true).unwrap();
    let mut next = Harness::attach(root, profile, "Unexpected replay", false, due + 2000);
    next.scheduler.tick(&mut next.host, due + 60_000).unwrap();
    assert_eq!(next.monitor.workers(), 0);
    let restored = next.host.states.whole_state(&next.root.project()).unwrap();
    for key in ["archived", "generatedTitle", "routine", "summary", "unread"] {
        assert_eq!(
            restored["sessions"][&sid][key], state["sessions"][&sid][key],
            "{key}"
        );
    }
    assert_eq!(restored["messages"], state["messages"]);
    next.finish();
}

#[test]
fn quiet_titles_match_actual_shared_node_short_title() {
    let inputs = vec![
        " Simple ".to_string(),
        "\u{feff}First line\r\nsecond".into(),
        "x".repeat(60),
        "x".repeat(61),
        "😀".repeat(20),
    ];
    let script = r#"const {pathToFileURL}=require('node:url');(async()=>{const {shortTitle}=await import(pathToFileURL(process.argv[1]));console.log(JSON.stringify(JSON.parse(process.argv[2]).map(s=>shortTitle(s.trim().split('\n')[0].trim())||null)))})().catch(e=>{console.error(e);process.exitCode=1});"#;
    let output = std::process::Command::new("node")
        .arg("-e")
        .arg(script)
        .arg(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../packages/shared/src/chats.mjs"),
        )
        .arg(serde_json::to_string(&inputs).unwrap())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let node: Vec<Option<String>> = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        inputs
            .iter()
            .map(|s| crate::routine_execution_fixture::quiet_title(s))
            .collect::<Vec<_>>(),
        node
    );
}
