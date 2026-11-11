//! Plain tests: the JSON-to-domain mapping on bodies captured from the real fixture (`tests/bodies`, generated paths
//! replaced by `/private/tmp/milagre-rust-wire-FIXTURE`), and the reducer's error surfacing.

use milagre_daemon_client::{Error, Hydration, Notice};
use milagre_gpui_spike::data::{ChatRuns, LOCAL, MessagePage, ProjectKind, SessionStatus, StateStamp};
use serde_json::{Value, json};

use crate::{Reducer, SyncError, map};

const PATH: &str = "/private/tmp/milagre-rust-wire-FIXTURE/fixture";
const EPOCH: &str = "isolated-actor:/private/tmp/milagre-rust-wire-FIXTURE/fixture";

fn body(name: &str) -> Value {
    let file = format!("{}/tests/bodies/{name}.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(&file).expect(&file)).expect("JSON")
}

fn stamped() -> StateStamp {
    StateStamp { version: Some(1), epoch: Some(EPOCH.into()) }
}

#[test]
fn project_current_maps_the_project_its_state_and_no_stamp() {
    let open = map::open_project(&body("project_current")).unwrap();
    assert_eq!(open.project.path.as_ref(), PATH);
    assert_eq!(open.project.name.as_ref(), "fixture");
    assert!(!open.project.git, "git: false is a plain folder");
    assert_eq!(open.project.kind, ProjectKind::Project);
    assert!(!open.project.hidden);
    assert_eq!((open.project.origin.clone(), open.project.opened_at.clone()), (None, None));
    assert_eq!(open.project.computer.as_ref(), LOCAL);
    assert_eq!(open.stamp, StateStamp::default(), "the fixture's project:current carries no version/epoch");
    let state = open.state.expect("state");
    assert_eq!(state.next_id, 10);
    assert!(!state.messages_in_chats);
    assert_eq!(state.persistence, None);
    let worktree = &state.worktrees[&1];
    assert_eq!((worktree.id, worktree.project_id, worktree.path.as_ref(), worktree.name.as_ref()), (1, 1, PATH, "fixture"));
    assert_eq!(state.sessions.len(), 2);
    for id in [1, 2] {
        let chat = &state.sessions[&id];
        assert_eq!((chat.id, chat.worktree_id, chat.agent_name.as_ref()), (id, 1, "fixture"));
        assert_eq!(chat.status, SessionStatus::Created, "absent status reads as the default");
        assert_eq!(chat.summary.as_ref().map(|s| s.count), Some(0));
        assert!(!chat.archived && !chat.pinned && !chat.unread);
        assert!(chat.subagents.is_empty() && chat.queued.is_empty());
    }
}

#[test]
fn open_view_and_project_read_with_state_match_project_current() {
    let current = map::open_project(&body("project_current")).unwrap();
    let opened = map::open_project(&body("open_view")).unwrap();
    assert_eq!(opened, current);
    let read = map::open_project(&body("project_read_state")).unwrap();
    assert_eq!(read.project, current.project);
    assert_eq!(read.state, current.state);
    assert_eq!(read.stamp, stamped());
}

#[test]
fn project_read_without_state_keeps_only_the_project_and_stamp() {
    let read = map::open_project(&body("project_read")).unwrap();
    assert_eq!(read.project.path.as_ref(), PATH);
    assert_eq!(read.state, None);
    assert_eq!(read.stamp, stamped());
}

#[test]
fn state_read_maps_state_and_stamp() {
    let raw = body("state_read");
    let read = map::state_read(&milagre_daemon_client::StateRead {
        state: raw["state"].clone(),
        version: raw["version"].clone(),
        epoch: raw["epoch"].clone(),
    })
    .unwrap();
    assert_eq!(read.stamp, stamped());
    assert_eq!(Some(read.state), map::open_project(&body("project_current")).unwrap().state);
}

#[test]
fn chat_runs_maps_an_empty_run_map_and_its_sequence() {
    let raw = body("chat_runs");
    let runs = map::chat_runs(&milagre_daemon_client::ChatRuns { runs: raw["runs"].clone(), seq: raw["seq"].as_u64().unwrap() }).unwrap();
    assert_eq!(runs, ChatRuns::default());
}

#[test]
fn chat_messages_maps_the_page_fields_as_sent() {
    assert_eq!(map::message_page(&body("chat_messages")).unwrap(), MessagePage { messages: vec![], has_more: false, total: 0 });
    // The client invents no cursor fields; neither does the mapping.
    assert!(map::message_page(&json!({"messages": [], "total": 0})).is_err());
}

#[test]
fn the_snapshot_applies_into_gpui_types() {
    let raw = body("snapshot");
    let projects: Vec<_> = raw["projects"].as_array().unwrap().iter().map(|p| map::open_project(p).unwrap()).collect();
    assert_eq!(projects, vec![map::open_project(&body("project_current")).unwrap()]);
    assert_eq!(raw["eventSeq"], 1);
}

#[test]
fn a_wrong_type_is_an_error_naming_its_path_never_a_default() {
    let mut raw = body("state_read")["state"].clone();
    raw["sessions"]["2"]["summary"]["count"] = json!("zero");
    let error = map::scope_state(&raw, "state").unwrap_err().to_string();
    assert_eq!(error, "state.sessions.2.summary.count: expected an unsigned integer");
    let mut raw = body("state_read")["state"].clone();
    raw["sessions"]["2"]["id"] = json!(3);
    assert!(map::scope_state(&raw, "state").unwrap_err().to_string().contains("does not match its id"));
}

#[test]
fn an_oversized_project_event_is_an_error_not_an_empty_state() {
    let mut reducer = Reducer::default();
    let event = Notice::Event { wire_seq: 2, scope: None, channel: "project:state".into(), payload: json!({}) };
    assert_eq!(reducer.apply_notice(event).unwrap_err(), SyncError::NotApplied, "no event before a snapshot");
    assert_eq!(reducer.state().unwrap_err(), SyncError::NotApplied);
    let closed = Notice::Closed(Error::StateTooLarge { hydration: Some(Hydration { scope: PATH.into(), method: "project:read".into() }) });
    let expected = SyncError::StateTooLarge { scope: Some(PATH.into()), method: Some("project:read".into()) };
    assert_eq!(reducer.apply_notice(closed).unwrap_err(), expected);
    assert_eq!(reducer.state().unwrap_err(), expected, "the reducer keeps answering the error");
    assert_eq!(expected.to_string(), format!("the Project's state is too large to stream: read {PATH} again with project:read"));
}
