use super::*;
use milagre_owner_store::{
    chat_host::MockProvider,
    states::{ProjectStates, Timing},
    Isolation, Policy,
};
use milagre_owner_wire::IsolatedProfile;
use std::{
    fs,
    io::Write,
    process::{Command, Stdio},
};

fn node(state: &Value, project: &str, worktree_name: &str) -> Value {
    let mut process = Command::new("node")
        .arg("fixtures/chat-bootstrap-node.cjs")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    process
        .stdin
        .take()
        .unwrap()
        .write_all(
            json!({"state":state,"project":project,"worktreeName":worktree_name})
                .to_string()
                .as_bytes(),
        )
        .unwrap();
    let output = process.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

fn legacy(project: &str) -> Value {
    json!({"next_id":10,"name":"Rust Chat",
        "worktrees":{"1":{"id":1,"name":"main","path":project}},
        "sessions":{"1":{"id":1,"worktree_id":1,"provider":"claude","permissionMode":"ask"}},
        "messages":[]})
}

#[test]
fn complete_seed_matches_actual_node_reconciliation_without_renumbering() {
    for path in ["/synthetic/project", "/synthetic/ação 😀"] {
        let mut initial = legacy(path);
        // New Chat construction in chat-host.cjs writes Created. Reconciliation
        // fills the remaining Project/Worktree/name fields without reallocating.
        initial["sessions"]["1"]["status"] = json!("Created");
        let expected = node(&initial, path, "main");
        assert_eq!(seed(path), expected);
        assert_eq!(expected["next_id"], 10);
        assert_eq!(expected["sessions"]["1"]["id"], 1);
        assert_eq!(expected["worktrees"]["1"]["project_id"], 1);
    }
}

#[test]
fn legacy_missing_only_patch_matches_node_and_preserves_actual_values() {
    let project = Path::new("/synthetic/project");
    let mut original = legacy(project.to_str().unwrap());
    original["worktrees"]["1"]["name"] = json!("explicit λ😀");
    original["messages"] = json!([{"id":10,"session_id":1,"role":"user","body":"retained"}]);
    original["sessions"]["1"]["summary"] = json!({"count":1,"firstAt":42,"lastAt":53});
    let state = ProjectState::from_value(&original);
    let next = missing_metadata(&state, project).unwrap().unwrap();
    assert!(next.same_messages(&state));
    assert_eq!(
        next.to_value(),
        node(&original, project.to_str().unwrap(), "explicit λ😀")
    );
    assert!(missing_metadata(&next, project).unwrap().is_none());
    // Missing-only repair preserves even explicit empty/null values. It never
    // performs Node's broader discovery reconciliation or discards foreign data.
    let mut retained = seed(project.to_str().unwrap());
    retained["worktrees"]["1"]["project_id"] = json!(42);
    retained["projects"] = json!({"42":{"id":42,"name":"actual saved name"}});
    retained["sessions"]["1"]["agent_name"] = Value::Null;
    retained["sessions"]["2"] = json!({"id":2,"worktree_id":7});
    retained["sessions"]["3"] = json!({"id":3,"worktree_id":1,"workspacePath":"/foreign"});
    retained["worktrees"]["7"] = json!({"id":7,"path":"/foreign","name":"other"});
    assert!(
        missing_metadata(&ProjectState::from_value(&retained), project)
            .unwrap()
            .is_none()
    );
    retained["worktrees"]["1"]["path"] = json!("/replacement");
    assert!(missing_metadata(&ProjectState::from_value(&retained), project).is_err());
}

fn fixture() -> (IsolatedProfile, Isolation, std::path::PathBuf) {
    let profile = IsolatedProfile::create().unwrap();
    let isolation = Isolation::create(profile.path(), &Policy::default()).unwrap();
    let project = isolation.project(Path::new("project")).unwrap();
    fs::create_dir(project.join(".milagre")).unwrap();
    (profile, isolation, project)
}

fn host(isolation: Isolation) -> ChatHost {
    let mut host = ChatHost::new(ProjectStates::new(isolation, Timing::default(), 1_000));
    host.register(Box::new(MockProvider::new("claude")));
    host
}

#[test]
fn acquired_writer_repairs_legacy_once_and_restart_keeps_transcript_and_activity() {
    let (_profile, isolation, project) = fixture();
    let file = project.join(".milagre/coordination.json");
    let mut original = legacy(project.to_str().unwrap());
    original["messages"] = json!([
        {"id":10,"session_id":1,"role":"user","body":"retained user"},
        {"id":11,"session_id":1,"role":"assistant","body":"retained reply","outcome":"completed"}
    ]);
    original["sessions"]["1"]["summary"] = json!({"count":2,"firstAt":42,"lastAt":53});
    fs::write(&file, original.to_string()).unwrap();
    let mut owner = host(isolation.clone());
    assert!(normalize_owned(&mut owner, &project).is_err());
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(&file).unwrap()).unwrap(),
        original
    );
    owner.open_project(&project).unwrap();
    let before = owner.states.current(&project).unwrap();
    let mut competitor = host(isolation.clone());
    assert!(competitor.open_project(&project).is_err());
    assert!(normalize_owned(&mut owner, &project).unwrap());
    let next = owner.states.current(&project).unwrap();
    assert!(next.same_messages(&before));
    assert_eq!(next.to_value()["messages"], before.to_value()["messages"]);
    assert_eq!(
        next.to_value()["sessions"]["1"]["summary"],
        before.to_value()["sessions"]["1"]["summary"]
    );
    let saved: Value = jsjson::parse_bytes(&fs::read(&file).unwrap()).unwrap();
    assert_eq!(saved["worktrees"]["1"]["project_id"], 1);
    assert_eq!(saved["sessions"]["1"]["agent_name"], "main");
    assert_eq!(saved["sessions"]["1"]["summary"]["firstAt"], 42);
    assert_eq!(saved["sessions"]["1"]["summary"]["lastAt"], 53);
    let whole = owner.states.current_whole_state(&project).unwrap().unwrap();
    owner.shutdown(true).unwrap();
    drop(owner);
    let mut reopened = host(isolation);
    reopened.open_project(&project).unwrap();
    assert!(!normalize_owned(&mut reopened, &project).unwrap());
    assert_eq!(
        reopened
            .states
            .current_whole_state(&project)
            .unwrap()
            .unwrap(),
        whole
    );
    reopened.shutdown(true).unwrap();
}

#[test]
fn failed_owner_commit_cannot_report_repair_or_change_disk() {
    let (_profile, isolation, project) = fixture();
    let file = project.join(".milagre/coordination.json");
    fs::write(&file, legacy(project.to_str().unwrap()).to_string()).unwrap();
    let mut owner = host(isolation);
    owner.open_project(&project).unwrap();
    let before = fs::read(&file).unwrap();
    owner
        .states
        .fail_next_commit("injected metadata commit refusal");
    assert!(normalize_owned(&mut owner, &project).is_err());
    assert_eq!(fs::read(&file).unwrap(), before);
    assert!(owner
        .states
        .current(&project)
        .unwrap()
        .get("projects")
        .is_none());
    assert!(project.join(".milagre/runtime.lock").exists());
    owner.shutdown(true).unwrap();
}
