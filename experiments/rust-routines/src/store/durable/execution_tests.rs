use super::*;

const AT: i64 = 1_790_000_000_000;
fn finish(run: &str, status: RunFinishStatus) -> Command {
    Command::FinishRun {
        run_id: run.into(),
        status,
        chat_id: None,
        error: None,
        summary: None,
        title: None,
    }
}
struct Trace {
    root: PathBuf,
    store: RoutineStore,
    steps: Vec<Value>,
    observations: Vec<Value>,
    ids: Vec<String>,
}
impl Trace {
    fn new() -> Self {
        let root = root();
        let store = RoutineStore::open(&root, owner(), AT).unwrap();
        let ids = (0..100).map(|i| format!("{i:08x}")).collect::<Vec<_>>();
        store
            .inner
            .as_ref()
            .unwrap()
            .ids
            .lock()
            .unwrap()
            .extend(ids.clone());
        Self {
            root,
            store,
            steps: vec![],
            observations: vec![],
            ids,
        }
    }
    fn step(&mut self, method: &str, args: Value, at: i64, command: Command) -> Value {
        let reply = self.store.execute(command, at).unwrap();
        let value = reply.value.clone();
        self.steps
            .push(json!({"method":method,"args":args,"now":at}));
        self.observations.push(json!({"result":{"ok":reply.value},"effects":reply.effects,"file":fs::read_to_string(file(&self.root)).ok()}));
        value
    }
    fn reopen(&mut self, at: i64) {
        let remaining = self
            .store
            .inner
            .as_ref()
            .unwrap()
            .ids
            .lock()
            .unwrap()
            .clone();
        self.store.close().unwrap();
        self.store = RoutineStore::open(&self.root, owner(), at).unwrap();
        self.store
            .inner
            .as_ref()
            .unwrap()
            .ids
            .lock()
            .unwrap()
            .extend(remaining);
        self.steps
            .push(json!({"method":"reopen","args":[],"now":at}));
        self.observations.push(json!({"result":{"ok":null},"effects":[],"file":fs::read_to_string(file(&self.root)).ok()}));
    }
    fn compare(mut self) {
        let remaining = self.store.inner.as_ref().unwrap().ids.lock().unwrap().len();
        self.store.close().unwrap();
        let mut node = Process::new("node")
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("scripts/durable-execution-node.cjs"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        serde_json::to_writer(
            node.stdin.as_mut().unwrap(),
            &json!({"now":AT,"ids":self.ids,"operations":self.steps}),
        )
        .unwrap();
        node.stdin.take();
        let output = node.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let expected: Value = serde_json::from_slice(&output.stdout).unwrap();
        for (i, actual) in self.observations.iter().enumerate() {
            assert_eq!(
                &expected["observations"][i], actual,
                "step {i}: {}",
                self.steps[i]
            );
        }
        assert_eq!(
            expected["observations"].as_array().unwrap().len(),
            self.observations.len()
        );
        assert_eq!(expected["idCalls"], self.ids.len() - remaining);
        assert_eq!(expected["rootRemoved"], true);
        println!(
            "DURABLE_EXECUTION_NODE {}",
            json!({"steps":self.steps.len(),"actualFileBytes":true,"effects":true,"idCalls":expected["idCalls"]})
        );
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn actual_node_schedule_transactions_match_results_effects_and_file_bytes() {
    let _serial = super::super::super::PROCESS_TEST_SERIAL.lock().unwrap();
    let mut trace = Trace::new();
    let mut one = input("Two successes");
    one["maxRuns"] = json!(2);
    let a = trace.step("create", json!([one.clone()]), AT, Command::Create(one));
    let aid = a["id"].as_str().unwrap();
    let due = a["nextRunAt"].as_i64().unwrap();
    let two = input("Cancelled by host policy");
    let b = trace.step("create", json!([two.clone()]), AT, Command::Create(two));
    let bid = b["id"].as_str().unwrap();
    assert_eq!(
        trace.step(
            "claimDue",
            json!([due - 1]),
            due - 1,
            Command::ClaimDue { at: due - 1 }
        ),
        json!([])
    );
    let claims = trace.step("claimDue", json!([due]), due, Command::ClaimDue { at: due });
    assert_eq!(claims.as_array().unwrap().len(), 2);
    let first = claims[0]["run"]["id"].as_str().unwrap();
    let second = claims[1]["run"]["id"].as_str().unwrap();
    assert_eq!(
        trace.step("claimDue", json!([due]), due, Command::ClaimDue { at: due }),
        json!([])
    );
    trace.step(
        "attachChat",
        json!([first,{"chatId":"/dedicated/project#1","worktreeId":"/dedicated/project#1"}]),
        due + 1,
        Command::AttachChat {
            run_id: first.into(),
            chat_id: "/dedicated/project#1".into(),
            worktree_id: Some("/dedicated/project#1".into()),
        },
    );
    trace.step("finishRun",json!([first,{"status":"acted","summary":"Kept λ😀","title":"First outcome","chatId":"/dedicated/project#1"}]),due+2,Command::FinishRun{run_id:first.into(),status:RunFinishStatus::Acted,chat_id:Some("/dedicated/project#1".into()),error:None,summary:Some("Kept λ😀".into()),title:Some("First outcome".into())});
    assert!(trace
        .step(
            "finishRun",
            json!([first,{"status":"failed"}]),
            due + 3,
            finish(first, RunFinishStatus::Failed)
        )
        .is_null());
    trace.step(
        "finishRun",
        json!([second,{"status":"skipped-busy"}]),
        due + 3,
        finish(second, RunFinishStatus::SkippedBusy),
    );
    let manual = trace.step(
        "startRun",
        json!([aid, due - 123]),
        due + 4,
        Command::StartRun {
            id: aid.into(),
            scheduled_for: due - 123,
        },
    );
    let mid = manual["run"]["id"].as_str().unwrap();
    assert_eq!(manual["run"]["startedAt"], due - 123);
    let complete = trace.step(
        "finishRun",
        json!([mid,{"status":"quiet"}]),
        due + 5,
        finish(mid, RunFinishStatus::Quiet),
    );
    assert_eq!(complete["runCount"], 2);
    assert_eq!(complete["enabled"], false);
    assert!(trace
        .step(
            "startRun",
            json!([aid, due + 6]),
            due + 6,
            Command::StartRun {
                id: aid.into(),
                scheduled_for: due + 6
            }
        )
        .is_null());
    let manual = trace.step(
        "startRun",
        json!([bid, due + 6]),
        due + 6,
        Command::StartRun {
            id: bid.into(),
            scheduled_for: due + 6,
        },
    );
    let run = manual["run"]["id"].as_str().unwrap();
    trace.step(
        "complete",
        json!([bid, "host cancelled"]),
        due + 7,
        Command::Complete {
            id: bid.into(),
            reason: Some("host cancelled".into()),
        },
    );
    trace.step(
        "finishRun",
        json!([run,{"status":"ended","error":"host cancelled","chatId":"/dedicated/project#1"}]),
        due + 8,
        Command::FinishRun {
            run_id: run.into(),
            status: RunFinishStatus::Ended,
            chat_id: Some("/dedicated/project#1".into()),
            error: Some("host cancelled".into()),
            summary: None,
            title: None,
        },
    );
    trace.step(
        "complete",
        json!([bid, "ignored second reason"]),
        due + 9,
        Command::Complete {
            id: bid.into(),
            reason: Some("ignored second reason".into()),
        },
    );
    let mut expiring = input("Expiry");
    expiring["expiresAt"] = json!(due + 60_000);
    let expiry = trace.step(
        "create",
        json!([expiring.clone()]),
        due + 10,
        Command::Create(expiring),
    );
    trace.step(
        "expireDue",
        json!([due + 60_000]),
        due + 60_000,
        Command::ExpireDue { at: due + 60_000 },
    );
    assert_eq!(
        trace.step(
            "get",
            json!([expiry["id"]]),
            due + 60_000,
            Command::Get(expiry["id"].as_str().unwrap().into())
        )["completedReason"],
        "expired"
    );
    assert!(trace
        .step(
            "finishRun",
            json!(["missing",{"status":"acted"}]),
            due + 60_000,
            finish("missing", RunFinishStatus::Acted)
        )
        .is_null());
    let failed = input("Three failed beats");
    let f = trace.step(
        "create",
        json!([failed.clone()]),
        due + 60_001,
        Command::Create(failed),
    );
    let fid = f["id"].as_str().unwrap();
    for i in 0..3 {
        let at = due + 60_002 + i * 2;
        let run = trace.step(
            "startRun",
            json!([fid, at]),
            at,
            Command::StartRun {
                id: fid.into(),
                scheduled_for: at,
            },
        );
        let rid = run["run"]["id"].as_str().unwrap();
        let result = trace.step(
            "finishRun",
            json!([rid,{"status":"failed","error":"cancelled turn"}]),
            at + 1,
            Command::FinishRun {
                run_id: rid.into(),
                status: RunFinishStatus::Failed,
                chat_id: None,
                error: Some("cancelled turn".into()),
                summary: None,
                title: None,
            },
        );
        assert_eq!(result["failedStreak"], i + 1);
    }
    trace.compare();
}

#[test]
fn actual_node_restart_recovery_and_missed_slots_never_redeliver_claims() {
    let _serial = super::super::super::PROCESS_TEST_SERIAL.lock().unwrap();
    let mut trace = Trace::new();
    let data = input("Restart once");
    let routine = trace.step("create", json!([data.clone()]), AT, Command::Create(data));
    let id = routine["id"].as_str().unwrap();
    let due = routine["nextRunAt"].as_i64().unwrap();
    let claims = trace.step("claimDue", json!([due]), due, Command::ClaimDue { at: due });
    assert_eq!(claims.as_array().unwrap().len(), 1);
    trace.reopen(due + 1);
    trace.step(
        "recoverInterrupted",
        json!([]),
        due + 1,
        Command::RecoverInterrupted,
    );
    trace.step(
        "recoverInterrupted",
        json!([]),
        due + 2,
        Command::RecoverInterrupted,
    );
    assert_eq!(
        trace.step(
            "claimDue",
            json!([due]),
            due + 2,
            Command::ClaimDue { at: due }
        ),
        json!([])
    );
    let runs = trace.step("runs", json!([id]), due + 2, Command::Runs(id.into()));
    assert_eq!(runs[0]["status"], "failed");
    assert_eq!(runs[0]["error"], "daemon restarted");
    let current = trace.step("get", json!([id]), due + 2, Command::Get(id.into()));
    assert_eq!(current["runCount"], 1);
    assert_eq!(current["failedStreak"], 1);
    let late = current["nextRunAt"].as_i64().unwrap() + 60_001;
    assert_eq!(
        trace.step(
            "claimDue",
            json!([late]),
            late,
            Command::ClaimDue { at: late }
        ),
        json!([])
    );
    let runs = trace.step("runs", json!([id]), late, Command::Runs(id.into()));
    assert_eq!(runs.as_array().unwrap().len(), 2);
    assert!(runs
        .as_array()
        .unwrap()
        .iter()
        .any(|run| run["status"] == "missed"));
    trace.reopen(late + 1);
    trace.step(
        "recoverInterrupted",
        json!([]),
        late + 1,
        Command::RecoverInterrupted,
    );
    assert_eq!(
        trace.step(
            "claimDue",
            json!([late]),
            late + 1,
            Command::ClaimDue { at: late }
        ),
        json!([])
    );
    trace.step(
        "complete",
        json!([id]),
        late + 2,
        Command::Complete {
            id: id.into(),
            reason: None,
        },
    );
    trace.compare();
}

#[test]
fn uncertain_claim_and_finish_withhold_results_and_never_redeliver_after_reopen() {
    let root = root();
    let mut store = RoutineStore::open(&root, owner(), AT).unwrap();
    let routine = store
        .execute(Command::Create(input("Withheld claim")), AT)
        .unwrap()
        .value;
    let id = routine["id"].as_str().unwrap();
    let due = routine["nextRunAt"].as_i64().unwrap();
    let before = fs::read(file(&root)).unwrap();
    store.inner.as_mut().unwrap().disk.fault = disk::Fault::BeforeRename;
    assert!(matches!(
        store.execute(Command::ClaimDue { at: due }, due),
        Err(Error::Io { .. })
    ));
    assert_eq!(fs::read(file(&root)).unwrap(), before);
    assert!(store.inner.as_ref().unwrap().model.data["runs"]
        .get(id)
        .is_none());
    store.inner.as_mut().unwrap().disk.fault = disk::Fault::AfterRename;
    assert!(matches!(
        store.execute(Command::ClaimDue { at: due }, due),
        Err(Error::Uncertain { .. })
    ));
    let saved: Value = serde_json::from_slice(&fs::read(file(&root)).unwrap()).unwrap();
    assert_eq!(saved["runs"][id][0]["status"], "running");
    assert!(store.inner.as_ref().unwrap().model.data["runs"]
        .get(id)
        .is_none());
    assert!(matches!(
        store.execute(Command::ClaimDue { at: due }, due),
        Err(Error::Uncertain { .. })
    ));
    assert!(matches!(
        RoutineStore::open(&root, owner(), due),
        Err(Error::Busy)
    ));
    store.close().unwrap();
    let mut store = RoutineStore::open(&root, owner(), due + 1).unwrap();
    store.execute(Command::RecoverInterrupted, due + 1).unwrap();
    assert_eq!(
        store
            .execute(Command::ClaimDue { at: due }, due + 1)
            .unwrap()
            .value,
        json!([])
    );
    let runs = store
        .execute(Command::Runs(id.into()), due + 1)
        .unwrap()
        .value;
    assert_eq!(runs.as_array().unwrap().len(), 1);
    assert_eq!(runs[0]["status"], "failed");
    let started = store
        .execute(
            Command::StartRun {
                id: id.into(),
                scheduled_for: due + 2,
            },
            due + 2,
        )
        .unwrap()
        .value;
    let run = started["run"]["id"].as_str().unwrap();
    let unacknowledged = saved["runs"][id][0]["id"].as_str().unwrap();
    assert_ne!(unacknowledged, run);
    assert_ne!(id, run);
    for generated in [id, unacknowledged, run] {
        assert_eq!(generated.len(), 8);
        assert!(generated
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    }
    let before = fs::read(file(&root)).unwrap();
    store.inner.as_mut().unwrap().disk.fault = disk::Fault::BeforeWrite;
    assert!(store
        .execute(finish(run, RunFinishStatus::Acted), due + 3)
        .is_err());
    assert_eq!(fs::read(file(&root)).unwrap(), before);
    store.inner.as_mut().unwrap().disk.fault = disk::Fault::AfterRename;
    assert!(matches!(
        store.execute(finish(run, RunFinishStatus::Acted), due + 3),
        Err(Error::Uncertain { .. })
    ));
    assert_eq!(
        store.inner.as_ref().unwrap().model.data["runs"][id][1]["status"],
        "running"
    );
    store.close().unwrap();
    let mut store = RoutineStore::open(&root, owner(), due + 4).unwrap();
    assert!(store
        .execute(finish(run, RunFinishStatus::Failed), due + 4)
        .unwrap()
        .value
        .is_null());
    assert_eq!(
        store
            .execute(Command::Get(id.into()), due + 4)
            .unwrap()
            .value["runCount"],
        2
    );
    assert_eq!(
        store
            .execute(Command::Runs(id.into()), due + 4)
            .unwrap()
            .value
            .as_array()
            .unwrap()
            .len(),
        2
    );
    store.close().unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn execution_fields_are_bounded_and_denials_do_not_write_or_claim() {
    let root = root();
    let mut store = RoutineStore::open(&root, owner(), AT).unwrap();
    let routine = store
        .execute(Command::Create(input("Bounded")), AT)
        .unwrap()
        .value;
    let id = routine["id"].as_str().unwrap();
    let saved = fs::read(file(&root)).unwrap();
    for command in [
        Command::ClaimDue { at: i64::MAX },
        Command::StartRun {
            id: id.into(),
            scheduled_for: i64::MAX,
        },
        Command::Complete {
            id: "constructor".into(),
            reason: None,
        },
        Command::FinishRun {
            run_id: "missing".into(),
            status: RunFinishStatus::Failed,
            chat_id: None,
            error: Some("x".repeat(16_385)),
            summary: None,
            title: None,
        },
    ] {
        assert!(store.execute(command, AT).is_err());
        assert_eq!(fs::read(file(&root)).unwrap(), saved);
    }
    assert_eq!(
        store
            .execute(Command::ClaimDue { at: AT }, AT)
            .unwrap()
            .value,
        json!([])
    );
    store.close().unwrap();
    fs::remove_dir_all(root).unwrap();
}

#[test]
#[ignore = "exec-only test helper launched by its exact parent"]
fn execution_process_worker() {
    let root = PathBuf::from(std::env::var_os("MILAGRE_ROUTINE_EXEC_ROOT").unwrap());
    let phase = std::env::var("MILAGRE_ROUTINE_EXEC_PHASE").unwrap();
    let mut store = RoutineStore::open(&root, owner(), AT).unwrap();
    if phase == "claim" {
        let created = store
            .execute(Command::Create(input("Across real process restart")), AT)
            .unwrap()
            .value;
        let due = created["nextRunAt"].as_i64().unwrap();
        let claim = store.execute(Command::ClaimDue { at: due }, due).unwrap();
        assert_eq!(claim.value.as_array().unwrap().len(), 1);
        let actual: Value = serde_json::from_slice(&fs::read(file(&root)).unwrap()).unwrap();
        assert_eq!(
            actual["runs"][created["id"].as_str().unwrap()][0]["status"],
            "running"
        );
    } else {
        let routine = store.execute(Command::List, AT).unwrap().value[0].clone();
        let id = routine["id"].as_str().unwrap();
        let at = routine["nextRunAt"].as_i64().unwrap() - 1;
        store.execute(Command::RecoverInterrupted, at).unwrap();
        store.execute(Command::RecoverInterrupted, at).unwrap();
        assert_eq!(
            store.execute(Command::ClaimDue { at }, at).unwrap().value,
            json!([])
        );
        let runs = store.execute(Command::Runs(id.into()), at).unwrap().value;
        assert_eq!(runs.as_array().unwrap().len(), 1);
        assert_eq!(runs[0]["status"], "failed");
        assert_eq!(
            store.execute(Command::Get(id.into()), at).unwrap().value["runCount"],
            1
        );
    }
    store.close().unwrap();
}

#[test]
fn claimed_run_is_recovered_once_across_two_real_process_lifetimes() {
    let _serial = super::super::super::PROCESS_TEST_SERIAL.lock().unwrap();
    let root = root();
    let home = super::root();
    let exe = std::env::current_exe().unwrap();
    for phase in ["claim", "recover"] {
        let output = Process::new(&exe)
            .args([
                "--exact",
                "store::durable::tests::execution::execution_process_worker",
                "--ignored",
                "--nocapture",
            ])
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", &home)
            .env("MILAGRE_ROUTINE_EXEC_ROOT", &root)
            .env("MILAGRE_ROUTINE_EXEC_PHASE", phase)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(home).unwrap();
}
