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

#[test]
fn released_events_are_counted_but_only_a_bounded_tail_is_kept() {
    // The default bounds are the client's own notification bounds.
    let client = milagre_daemon_client::ClientOptions::default();
    let mut reducer = Reducer::default();
    reducer.apply_body(&body("snapshot"), 1).unwrap();
    for seq in 2..2 + client.max_notification_events as u64 + 5 {
        reducer.apply_notice(Notice::Event { wire_seq: seq, scope: None, channel: "x".into(), payload: json!({}) }).unwrap();
    }
    assert_eq!(reducer.released().count(), client.max_notification_events as u64 + 5);
    assert_eq!(reducer.released().tail().len(), client.max_notification_events);
    assert_eq!(reducer.released().tail().next().unwrap().wire_seq, 7, "the oldest five were dropped from the tail");

    // Small bounds: three events, or 20 payload bytes, whichever is reached first.
    let mut reducer = Reducer::with_bounds(3, 20);
    reducer.apply_body(&body("snapshot"), 1).unwrap();
    let event = |seq: u64, text: &str| Notice::Event { wire_seq: seq, scope: None, channel: "x".into(), payload: json!(text) };
    for seq in 2..7 {
        reducer.apply_notice(event(seq, "ab")).unwrap(); // `"ab"`: 4 bytes
    }
    assert_eq!(reducer.released().tail().map(|e| e.wire_seq).collect::<Vec<_>>(), vec![4, 5, 6]);
    assert_eq!(reducer.released().bytes(), 12);
    reducer.apply_notice(event(7, "0123456789abcdef")).unwrap(); // 18 bytes: only it fits
    assert_eq!(reducer.released().tail().map(|e| e.wire_seq).collect::<Vec<_>>(), vec![7]);
    assert_eq!((reducer.released().count(), reducer.released().bytes()), (6, 18));
    // An event at or below the watermark is refused, not recorded.
    assert_eq!(reducer.apply_notice(event(1, "")).unwrap_err(), SyncError::StaleEvent { wire_seq: 1, watermark: 1 });
    assert_eq!(reducer.released().count(), 6);
}

#[test]
fn populated_state_maps_both_chats_with_their_owner_summaries() {
    use milagre_gpui_spike::data::Outcome;
    let raw = body("populated_state_read");
    let read = map::state_read(&milagre_daemon_client::StateRead {
        state: raw["state"].clone(),
        version: raw["version"].clone(),
        epoch: raw["epoch"].clone(),
    })
    .unwrap();
    assert_eq!(read.stamp.version, raw["version"].as_u64());
    assert_eq!(read.stamp.epoch.as_deref(), raw["epoch"].as_str());
    let sessions = &read.state.sessions;
    assert_eq!(sessions.keys().copied().collect::<Vec<_>>(), vec![1, 2]);
    for (id, count, first, last, title) in [(1, 4, 10, 13, "Fixture history: first turn"), (2, 2, 14, 15, "Fixture history: another Chat")]
    {
        let summary = sessions[&id].summary.as_ref().unwrap();
        let wire = &raw["state"]["sessions"][id.to_string()]["summary"];
        assert_eq!((summary.count, summary.first_id, summary.last_id), (count, Some(first), Some(last)));
        assert_eq!(summary.title_line.as_deref(), Some(title));
        assert_eq!(summary.last_model.as_deref(), Some("scripted"));
        assert_eq!(summary.last_outcome, Some(Outcome::Completed));
        assert_eq!((summary.first_at, summary.last_at), (wire["firstAt"].as_i64(), wire["lastAt"].as_i64()));
    }
    let (one, two) = (sessions[&1].summary.as_ref().unwrap(), sessions[&2].summary.as_ref().unwrap());
    assert!(two.first_at > one.first_at && two.last_at > one.last_at, "Chat 2 started and ended later");
}

#[test]
fn populated_transcripts_and_a_one_turn_page_map_in_order() {
    let ids = |page: &MessagePage| page.messages.iter().map(|m| m.id).collect::<Vec<_>>();
    let chat1 = map::message_page(&body("populated_chat1_open")).unwrap();
    assert_eq!((ids(&chat1), chat1.total, chat1.has_more), (vec![10, 11, 12, 13], 4, false));
    let bodies: Vec<_> = chat1.messages.iter().map(|m| (m.role, m.body.as_ref())).collect();
    use milagre_gpui_spike::data::Role::{Assistant, User};
    assert_eq!(
        bodies,
        [
            (User, "Fixture history: first turn"),
            (Assistant, "Scripted isolated reply"),
            (User, "Fixture history: second turn"),
            (Assistant, "Scripted isolated reply")
        ]
    );
    assert!(chat1.messages.iter().all(|m| m.chat == 1 && m.model.as_deref() == Some("scripted") && m.context.is_none()));
    let chat2 = map::message_page(&body("populated_chat2_open")).unwrap();
    assert_eq!((ids(&chat2), chat2.total, chat2.has_more), (vec![14, 15], 2, false));
    let last = map::message_page(&body("populated_chat1_last_turn")).unwrap();
    assert_eq!((ids(&last), last.total, last.has_more), (vec![12, 13], 4, true));
}
