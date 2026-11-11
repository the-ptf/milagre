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

    // An event larger than the byte cap on its own is counted, not kept, and leaves the tail as it was.
    reducer.apply_notice(event(8, &"x".repeat(30))).unwrap();
    assert_eq!(reducer.released().tail().map(|e| e.wire_seq).collect::<Vec<_>>(), vec![7]);
    assert_eq!((reducer.released().count(), reducer.released().bytes()), (7, 18));
    // Zero capacity keeps nothing (events or bytes), and still counts.
    for (events, bytes) in [(0, 1024), (8, 0)] {
        let mut reducer = Reducer::with_bounds(events, bytes);
        reducer.apply_body(&body("snapshot"), 1).unwrap();
        reducer.apply_notice(event(2, "")).unwrap();
        reducer.apply_notice(event(3, "ab")).unwrap();
        assert_eq!(
            (reducer.released().count(), reducer.released().tail().len(), reducer.released().bytes()),
            (2, 0, 0),
            "{events} events, {bytes} bytes"
        );
    }
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

// ---- Live events ----
//
// DERIVED, not captured: neither fixture emits an event after the accepted snapshot (see `real::populated::
// post_snapshot_events`), and the client has no public write. Envelopes follow what the owner emits
// (`experiments/rust-runtime/src/actor.rs`: `agent:event {chatId, event, seq?, state?}`, `project:state {path,
// state}`), event bodies follow `packages/shared/src/agent-runs.mjs`, and every `state` is the real populated state
// captured from the wire (`tests/bodies/populated_state_read.json`).

mod live {
    use milagre_daemon_client::{Error, Hydration, Notice};
    use milagre_gpui_spike::data::{StateStamp, StepStatus};
    use serde_json::{Value, json};

    use super::{PATH, body};
    use crate::{Ignored, LiveBounds, LiveStore, Reducer, SyncError, live::cap_output};

    fn reducer() -> Reducer {
        let mut reducer = Reducer::default();
        reducer.apply_body(&body("snapshot"), 1).unwrap();
        reducer
    }
    fn agent(seq: u64, event: Value) -> Value {
        json!({"chatId": format!("{PATH}#1"), "event": event, "seq": seq})
    }
    fn notice(wire_seq: u64, channel: &str, payload: Value) -> Notice {
        Notice::Event { wire_seq, scope: Some(PATH.into()), channel: channel.into(), payload }
    }
    fn populated() -> Value {
        body("populated_state_read")["state"].clone()
    }

    #[test]
    fn a_turn_folds_into_the_run_then_its_end_replaces_the_state() {
        let mut r = reducer();
        let key = format!("{PATH}#1");
        let mut wire = 1;
        let mut send = |r: &mut Reducer, channel: &str, payload: Value| {
            wire += 1;
            r.apply_notice(notice(wire, channel, payload))
        };
        let effect =
            send(&mut r, "agent:event", agent(1, json!({"type": "message-sent", "model": "scripted", "permissionMode": "ask"}))).unwrap();
        assert_eq!(effect.run.as_deref(), Some(key.as_str()));
        send(&mut r, "agent:event", agent(2, json!({"type": "turn-started", "turnId": "t1"}))).unwrap();
        send(&mut r, "agent:event", agent(3, json!({"type": "text-delta", "text": "Hello "}))).unwrap();
        let step = json!({"type": "step-started", "step": {"id": "s1", "kind": "shell", "title": "Ran `ls`", "detail": "$ ls\n"}});
        send(&mut r, "agent:event", agent(4, step)).unwrap();
        send(&mut r, "agent:event", agent(5, json!({"type": "step-output", "id": "s1", "text": "a.txt\n"}))).unwrap();
        send(&mut r, "agent:event", agent(6, json!({"type": "text-delta", "text": "world"}))).unwrap();
        let run = r.state().unwrap().runs.get(&key).unwrap().clone();
        assert_eq!((run.text.as_ref(), run.model.as_ref(), run.turn_id.as_deref()), ("Hello world", "scripted", Some("t1")));
        assert_eq!(run.steps[0].offset, Some(6), "where the step started in the text (UTF-16 units)");
        assert_eq!(run.steps[0].detail.as_deref(), Some("$ ls\na.txt\n"));
        assert_eq!(run.steps[0].status, StepStatus::Running);
        send(&mut r, "agent:event", agent(7, json!({"type": "step-completed", "id": "s1", "status": "done", "durationMs": 5}))).unwrap();
        let step = r.state().unwrap().runs.get(&key).unwrap().steps[0].clone();
        assert_eq!(
            (step.status, step.duration_ms, step.detail.clone()),
            (StepStatus::Done, Some(5), None),
            "a tool's end replaces its output"
        );
        let request = json!({"type": "permission-request", "requestId": "r1", "kind": "command", "tool": "Bash", "title": "Run ls", "allowForChat": true});
        send(&mut r, "agent:event", agent(8, request)).unwrap();
        assert_eq!(r.state().unwrap().runs.get(&key).unwrap().approvals.len(), 1);
        send(&mut r, "agent:event", agent(9, json!({"type": "permission-resolved", "requestId": "r1"}))).unwrap();
        assert!(r.state().unwrap().runs.get(&key).unwrap().approvals.is_empty());

        // The turn ends carrying the scope's state: the run goes, the state (and its message summaries) is replaced.
        let mut end = agent(10, json!({"type": "turn-completed"}));
        end["state"] = populated();
        let effect = send(&mut r, "agent:event", end).unwrap();
        assert_eq!((effect.state.as_deref(), effect.run.as_deref()), (Some(PATH), Some(key.as_str())));
        let applied = r.state().unwrap();
        assert!(applied.runs.runs.is_empty());
        assert_eq!(applied.runs.seq, 10);
        let state = applied.projects[0].state.as_ref().unwrap();
        assert_eq!(state.sessions[&1].summary.as_ref().unwrap().count, 4);
        assert_eq!(applied.projects[0].stamp, StateStamp::default(), "no version/epoch in the payload: none invented");

        // Already in the runs: its run part is skipped.
        let effect = send(&mut r, "agent:event", agent(5, json!({"type": "text-delta", "text": "late"}))).unwrap();
        assert!(effect.already_in_runs && effect.run.is_none());
        assert!(r.state().unwrap().runs.runs.is_empty());
        assert_eq!(r.counts().run_changes, 10);
        assert_eq!(r.counts().state_replacements, 1);
    }

    #[test]
    fn project_state_replaces_the_scope_and_takes_only_the_payloads_stamp() {
        let mut r = reducer();
        let before = r.version();
        let effect =
            r.apply_notice(notice(2, "project:state", json!({"path": PATH, "state": populated(), "version": 7, "epoch": "e1"}))).unwrap();
        assert_eq!(effect.state.as_deref(), Some(PATH));
        assert_eq!(r.version(), before + 1);
        let open = &r.state().unwrap().projects[0];
        assert_eq!(open.stamp, StateStamp { version: Some(7), epoch: Some("e1".into()) });
        assert_eq!(open.state.as_ref().unwrap().sessions[&2].summary.as_ref().unwrap().count, 2);
        // A hydrated event (current catch-up state, `stateTooLarge` removed by the client) applies the same way.
        let hydrated = json!({"path": PATH, "state": populated(), "extra": "retained"});
        r.apply_notice(notice(3, "project:state", hydrated)).unwrap();
        assert_eq!(r.state().unwrap().projects[0].stamp, StateStamp::default());
    }

    #[test]
    fn unknown_channels_foreign_scopes_and_unreduced_types_are_counted_not_guessed() {
        let mut r = reducer();
        let version = r.version();
        let effect = r.apply_notice(notice(2, "link:state", json!({"linkId": "x", "state": {}}))).unwrap();
        assert_eq!(effect.ignored, Some(Ignored::Channel("link:state".into())));
        r.apply_notice(notice(3, "agent:done", json!({"chatId": format!("{PATH}#1")}))).unwrap();
        let foreign = r.apply_notice(notice(4, "project:state", json!({"path": "/foreign", "state": {}}))).unwrap();
        assert_eq!(foreign.ignored, Some(Ignored::ForeignScope("/foreign".into())));
        let foreign = json!({"chatId": "/foreign#9", "event": {"type": "text-delta", "text": "x"}});
        assert_eq!(r.apply_notice(notice(5, "agent:event", foreign)).unwrap().ignored, Some(Ignored::ForeignScope("/foreign".into())));
        let suggestion = r.apply_notice(notice(6, "agent:event", agent(1, json!({"type": "prompt-suggestion", "text": "x"})))).unwrap();
        assert_eq!(suggestion.ignored, Some(Ignored::AgentEventType("prompt-suggestion".into())));
        let counts = r.counts();
        assert_eq!(
            counts.unknown_channels.iter().map(|(k, v)| (k.as_str(), *v)).collect::<Vec<_>>(),
            [("agent:done", 1), ("link:state", 1)]
        );
        assert_eq!((counts.foreign_scope, counts.unreduced_agent_types["prompt-suggestion"]), (2, 1));
        assert_eq!(r.version(), version, "nothing a view shows changed");
        assert_eq!(r.released().count(), 5);
        // Names are bounded too.
        let mut r = Reducer::with_live_bounds(LiveBounds { names: 2, ..LiveBounds::default() });
        r.apply_body(&body("snapshot"), 1).unwrap();
        for (seq, channel) in [(2, "a"), (3, "b"), (4, "c"), (5, "d")] {
            r.apply_notice(notice(seq, channel, json!({}))).unwrap();
        }
        assert_eq!(
            r.counts().unknown_channels.iter().map(|(k, v)| (k.as_str(), *v)).collect::<Vec<_>>(),
            [("(other)", 2), ("a", 1), ("b", 1)]
        );
    }

    #[test]
    fn stale_and_regressing_events_are_refused_with_typed_errors() {
        let mut r = reducer();
        r.apply_notice(notice(5, "x", json!({}))).unwrap();
        assert_eq!(r.apply_notice(notice(1, "x", json!({}))).unwrap_err(), SyncError::StaleEvent { wire_seq: 1, watermark: 1 });
        assert_eq!(r.apply_notice(notice(5, "x", json!({}))).unwrap_err(), SyncError::OutOfOrder { wire_seq: 5, last: 5 });
        assert_eq!(r.apply_notice(notice(3, "x", json!({}))).unwrap_err(), SyncError::OutOfOrder { wire_seq: 3, last: 5 });
        r.apply_notice(notice(6, "x", json!({}))).expect("refusals are not latched");
        assert_eq!((r.last_seq(), r.released().count()), (6, 2));
    }

    #[test]
    fn oversized_invalid_and_unbounded_events_close_the_live_state_visibly() {
        // An oversized marker that reached the reducer unhydrated is StateTooLarge, never an empty state.
        let mut r = reducer();
        let marker = notice(2, "project:state", json!({"path": PATH, "stateTooLarge": true}));
        let expected = SyncError::StateTooLarge { scope: Some(PATH.into()), method: None };
        assert_eq!(r.apply_notice(marker).unwrap_err(), expected);
        assert_eq!(r.state().unwrap_err(), expected);
        // A failed hydration closes with the client's StateTooLarge (or its actual error), as before.
        let mut r = reducer();
        let closed =
            Notice::Closed(Error::StateTooLarge { hydration: Some(Hydration { scope: "/foreign".into(), method: "project:read".into() }) });
        assert!(matches!(r.apply_notice(closed).unwrap_err(), SyncError::StateTooLarge { .. }));
        assert!(r.state().is_err());
        // A known channel with the wrong shape.
        let mut r = reducer();
        let error = r.apply_notice(notice(2, "project:state", json!({"path": PATH, "state": {"sessions": {}}}))).unwrap_err();
        assert!(
            matches!(&error, SyncError::InvalidEvent { channel, message } if channel == "project:state" && message.contains("next_id"))
        );
        assert_eq!(r.state().unwrap_err(), error);
        // A bound.
        let mut r = Reducer::with_live_bounds(LiveBounds { runs: 1, ..LiveBounds::default() });
        r.apply_body(&body("snapshot"), 1).unwrap();
        r.apply_notice(notice(2, "agent:event", agent(1, json!({"type": "message-sent", "model": "m"})))).unwrap();
        let second = json!({"chatId": format!("{PATH}#2"), "event": {"type": "message-sent", "model": "m"}});
        assert_eq!(r.apply_notice(notice(3, "agent:event", second)).unwrap_err(), SyncError::Bound { what: "runs", limit: 1 });
        assert!(r.state().is_err());
        // Zero is a hard bound too: no run, no step, no text, no request is admitted.
        for (bounds, what, event) in [
            (LiveBounds { runs: 0, ..LiveBounds::default() }, "runs", json!({"type": "message-sent", "model": "m"})),
            (LiveBounds { steps: 0, ..LiveBounds::default() }, "steps", json!({"type": "step-started", "step": {"id": "s", "title": "t"}})),
            (LiveBounds { run_text: 0, ..LiveBounds::default() }, "run text bytes", json!({"type": "text-delta", "text": "x"})),
            (
                LiveBounds { requests: 0, ..LiveBounds::default() },
                "approvals",
                json!({"type": "permission-request", "requestId": "r", "kind": "edit", "tool": "Edit", "title": "t"}),
            ),
        ] {
            let mut r = Reducer::with_live_bounds(bounds);
            r.apply_body(&body("snapshot"), 1).unwrap();
            let mut seq = 2;
            if what != "runs" {
                let start = LiveBounds { runs: 1, ..bounds };
                r = Reducer::with_live_bounds(start);
                r.apply_body(&body("snapshot"), 1).unwrap();
                r.apply_notice(notice(seq, "agent:event", agent(1, json!({"type": "message-sent", "model": "m"})))).unwrap();
                seq += 1;
            }
            assert_eq!(
                r.apply_notice(notice(seq, "agent:event", agent(2, event))).unwrap_err(),
                SyncError::Bound { what, limit: 0 },
                "{what}"
            );
        }
        // With no names allowed, every unknown channel is counted under the one overflow entry.
        let mut r = Reducer::with_live_bounds(LiveBounds { names: 0, ..LiveBounds::default() });
        r.apply_body(&body("snapshot"), 1).unwrap();
        r.apply_notice(notice(2, "a", json!({}))).unwrap();
        assert_eq!(r.counts().unknown_channels.iter().map(|(k, v)| (k.as_str(), *v)).collect::<Vec<_>>(), [("(other)", 1)]);
    }

    #[test]
    fn step_output_keeps_its_last_20000_utf16_units() {
        let long = "é".repeat(20_005);
        let capped = cap_output(&long);
        assert!(capped.starts_with("… truncated\n"));
        assert_eq!(capped.trim_start_matches("… truncated\n").encode_utf16().count(), 20_000);
        assert_eq!(cap_output("short"), "short");
    }

    /// The seam a view uses: subscribe, and on each signal read the version and what it draws.
    #[gpui::test]
    fn a_gpui_view_follows_the_live_store(cx: &mut gpui::TestAppContext) {
        use futures::StreamExt as _;
        use gpui::AppContext as _;
        struct Follower {
            version: u64,
            runs: usize,
        }
        let store = LiveStore::new(reducer());
        let follower = cx.new(|_| Follower { version: 0, runs: 0 });
        let mut signals = store.subscribe().expect("a subscriber slot");
        let (watched, view) = (store.clone(), follower.clone());
        cx.spawn(async move |mut cx| {
            while signals.next().await.is_some() {
                let (version, runs) = watched.read(|r| (r.version(), r.state().map(|s| s.runs.runs.len()).unwrap_or(0)));
                view.update(&mut cx, |view, _| *view = Follower { version, runs });
            }
        })
        .detach();
        store.apply_notice(notice(2, "agent:event", agent(1, json!({"type": "message-sent", "model": "m"})))).unwrap();
        store.apply_notice(notice(3, "agent:event", agent(2, json!({"type": "text-delta", "text": "hi"})))).unwrap();
        cx.run_until_parked();
        assert_eq!(follower.read_with(cx, |f, _| (f.version, f.runs)), (store.version(), 1));
        // An ignored event moves nothing and signals nothing.
        let version = store.version();
        store.apply_notice(notice(4, "link:state", json!({}))).unwrap();
        cx.run_until_parked();
        assert_eq!((store.version(), follower.read_with(cx, |f, _| f.version)), (version, version));
    }
}

/// CAPTURED from the real wire: the `project:state` event the populated fixture released after the accepted snapshot
/// (`real::populated::post_snapshot_events`), applied to the captured default snapshot (same placeholder path).
#[test]
fn a_captured_live_project_state_replaces_the_scope() {
    let mut reducer = Reducer::default();
    reducer.apply_body(&body("snapshot"), 1).unwrap();
    assert_eq!(reducer.state().unwrap().projects[0].state.as_ref().unwrap().sessions[&1].summary.as_ref().unwrap().count, 0);
    let event = body("live_project_state");
    for wire_seq in [2, 3] {
        let effect = reducer
            .apply_notice(Notice::Event { wire_seq, scope: Some(PATH.into()), channel: "project:state".into(), payload: event.clone() })
            .unwrap();
        assert_eq!(effect.state.as_deref(), Some(PATH));
    }
    let open = &reducer.state().unwrap().projects[0];
    let sessions = &open.state.as_ref().unwrap().sessions;
    assert_eq!((sessions[&1].summary.as_ref().unwrap().count, sessions[&2].summary.as_ref().unwrap().count), (4, 2));
    assert_eq!(sessions[&1].summary.as_ref().unwrap().title_line.as_deref(), Some("Fixture history: first turn"));
    assert_eq!(open.stamp, StateStamp::default(), "the real event carries no version/epoch; none is invented");
    assert_eq!((reducer.counts().state_replacements, reducer.version()), (2, 3));
}

/// Differential traces: `tests/vectors/run-traces.json` is what the repository's own `applyRunEvent` produced for
/// `tests/vectors/run-cases.json` (`scripts/run-vectors.mjs`, injected clock, `lastUserModel` fallback). The Rust
/// fold must produce the same runs after every event. Numbers compare as numbers (5 == 5.0).
mod vectors {
    use std::collections::BTreeMap;
    use std::sync::Arc;

    use milagre_daemon_client::Notice;
    use milagre_gpui_spike::data::{AgentRun, ChatStep, PermissionKind, PermissionMode, StepKind, StepStatus};
    use serde_json::{Map, Value, json};

    use super::body;
    use crate::Reducer;

    fn read(name: &str) -> Value {
        let file = format!("{}/tests/vectors/{name}.json", env!("CARGO_MANIFEST_DIR"));
        serde_json::from_str(&std::fs::read_to_string(&file).expect(&file)).expect("JSON")
    }

    fn put(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
        if let Some(value) = value {
            map.insert(key.into(), value);
        }
    }

    fn step(step: &ChatStep) -> Value {
        let mut m = Map::new();
        m.insert("id".into(), json!(step.id.as_ref()));
        put(&mut m, "kind", step.kind.map(|kind| json!(kind_name(kind))));
        m.insert("title".into(), json!(step.title.as_ref()));
        let status = match step.status {
            StepStatus::Running => "running",
            StepStatus::Done => "done",
            StepStatus::Failed => "failed",
        };
        m.insert("status".into(), json!(status));
        put(&mut m, "startedAt", step.started_at.map(|v| json!(v)));
        put(&mut m, "endedAt", step.ended_at.map(|v| json!(v)));
        for (key, value) in [
            ("input", &step.input),
            ("summary", &step.summary),
            ("error", &step.error),
            ("detail", &step.detail),
            ("file", &step.file),
            ("note", &step.note),
            ("tool", &step.tool),
            ("agent", &step.agent),
        ] {
            put(&mut m, key, value.as_ref().map(|v| json!(v.as_ref())));
        }
        put(&mut m, "durationMs", step.duration_ms.map(|v| json!(v)));
        put(&mut m, "offset", step.offset.map(|v| json!(v)));
        Value::Object(m)
    }

    fn kind_name(kind: StepKind) -> &'static str {
        match kind {
            StepKind::Shell => "shell",
            StepKind::Edit => "edit",
            StepKind::Read => "read",
            StepKind::Search => "search",
            StepKind::Other => "other",
            StepKind::Thinking => "thinking",
            StepKind::Setup => "setup",
            StepKind::Image => "image",
            StepKind::Artifact => "artifact",
        }
    }

    fn run(run: &AgentRun) -> Value {
        let mut m = Map::new();
        m.insert("text".into(), json!(run.text.as_ref()));
        m.insert("model".into(), json!(run.model.as_ref()));
        put(&mut m, "startedAt", run.started_at.map(|v| json!(v)));
        m.insert("steps".into(), Value::Array(run.steps.iter().map(step).collect()));
        let approvals = run.approvals.iter().map(|r| {
            let mut a = Map::new();
            a.insert("requestId".into(), json!(r.request_id.as_ref()));
            let kind = match r.kind {
                PermissionKind::Command => "command",
                PermissionKind::Edit => "edit",
                PermissionKind::Other => "other",
                PermissionKind::Delegation => "delegation",
                PermissionKind::Setup => "setup",
            };
            a.insert("kind".into(), json!(kind));
            a.insert("tool".into(), json!(r.tool.as_ref()));
            a.insert("title".into(), json!(r.title.as_ref()));
            for (key, value) in [
                ("description", &r.description),
                ("command", &r.command),
                ("cwd", &r.cwd),
                ("diff", &r.diff),
                ("detail", &r.detail),
                ("reason", &r.reason),
                ("stepId", &r.step_id),
            ] {
                put(&mut a, key, value.as_ref().map(|v| json!(v.as_ref())));
            }
            if !r.files.is_empty() {
                a.insert("files".into(), json!(r.files.iter().map(|f| f.as_ref()).collect::<Vec<_>>()));
            }
            a.insert("allowForChat".into(), json!(r.allow_for_chat));
            Value::Object(a)
        });
        m.insert("approvals".into(), Value::Array(approvals.collect()));
        let questions = run.questions.iter().map(|q| {
            let questions = q.questions.iter().map(|q| {
                let options = q.options.iter().map(|o| {
                    let mut m = Map::new();
                    m.insert("label".into(), json!(o.label));
                    put(&mut m, "description", o.description.as_ref().map(|d| json!(d)));
                    Value::Object(m)
                });
                json!({"id": q.id, "header": q.header, "question": q.question, "options": options.collect::<Vec<_>>(),
                       "multiSelect": q.multi_select, "allowOther": q.allow_other, "secret": q.secret})
            });
            json!({"requestId": q.request_id.as_ref(), "questions": questions.collect::<Vec<_>>()})
        });
        m.insert("questions".into(), Value::Array(questions.collect()));
        m.insert("answered".into(), json!({}));
        put(
            &mut m,
            "permissionMode",
            run.permission_mode.map(|mode| {
                json!(match mode {
                    PermissionMode::Ask => "ask",
                    PermissionMode::Auto => "auto",
                    PermissionMode::Full => "full",
                })
            }),
        );
        put(&mut m, "turnId", run.turn_id.as_ref().map(|t| json!(t.as_ref())));
        if run.split {
            m.insert("split".into(), json!(true));
        }
        if run.waiting_for_subagents {
            m.insert("waitingForSubagents".into(), json!(true));
        }
        put(&mut m, "contextUsage", run.context_usage.map(|c| json!({"used": c.used, "size": c.size})));
        Value::Object(m)
    }

    /// Equal as JSON, numbers by value; on a difference, the path.
    fn same(a: &Value, b: &Value, path: &str) -> Result<(), String> {
        match (a, b) {
            (Value::Number(x), Value::Number(y)) if x.as_f64() == y.as_f64() => Ok(()),
            (Value::Object(x), Value::Object(y)) => {
                let keys: std::collections::BTreeSet<_> = x.keys().chain(y.keys()).collect();
                for key in keys {
                    same(x.get(key).unwrap_or(&Value::Null), y.get(key).unwrap_or(&Value::Null), &format!("{path}.{key}"))?;
                }
                Ok(())
            }
            (Value::Array(x), Value::Array(y)) if x.len() == y.len() => {
                x.iter().zip(y).enumerate().try_for_each(|(ix, (x, y))| same(x, y, &format!("{path}[{ix}]")))
            }
            _ if a == b => Ok(()),
            _ => Err(format!("{path}: rust {} vs node {}", short(a), short(b))),
        }
    }

    fn short(value: &Value) -> String {
        let text = value.to_string();
        if text.chars().count() > 160 { format!("{}…", text.chars().take(160).collect::<String>()) } else { text }
    }

    #[test]
    fn the_rust_run_fold_matches_node_applyrunevent_after_every_event() {
        let cases = read("run-cases");
        let traces = read("run-traces");
        let cases = cases.as_array().unwrap();
        assert_eq!(cases.len(), traces.as_array().unwrap().len());
        let mut checked = 0;
        for (case, trace) in cases.iter().zip(traces.as_array().unwrap()) {
            let name = case["name"].as_str().unwrap();
            assert_eq!(trace["name"], name);
            let clock = Arc::new(std::sync::atomic::AtomicI64::new(0));
            let reading = clock.clone();
            let mut reducer = Reducer::default().with_clock(Arc::new(move || reading.load(std::sync::atomic::Ordering::SeqCst)));
            let mut snapshot = body("snapshot");
            if let Some(model) = case.get("lastModel") {
                snapshot["projects"][0]["state"]["sessions"]["1"]["summary"]["lastModel"] = model.clone();
            }
            reducer.apply_body(&snapshot, 1).unwrap();
            let chat = case["chatId"].as_str().unwrap();
            for (ix, (step, expected)) in case["events"].as_array().unwrap().iter().zip(trace["after"].as_array().unwrap()).enumerate() {
                clock.store(step["at"].as_i64().unwrap(), std::sync::atomic::Ordering::SeqCst);
                let payload = json!({"chatId": chat, "event": step["event"]});
                let notice = Notice::Event { wire_seq: 2 + ix as u64, scope: None, channel: "agent:event".into(), payload };
                reducer.apply_notice(notice).unwrap_or_else(|e| panic!("{name} event {ix}: {e}"));
                let runs: BTreeMap<_, _> = reducer.state().unwrap().runs.runs.iter().map(|(k, v)| (k.clone(), run(v))).collect();
                let actual = Value::Object(runs.into_iter().collect());
                same(&actual, expected, "runs")
                    .unwrap_or_else(|diff| panic!("{name} after event {ix} ({}): {diff}", step["event"]["type"]));
                checked += 1;
            }
        }
        assert_eq!(checked, cases.iter().map(|c| c["events"].as_array().unwrap().len()).sum::<usize>());
    }
}

/// DERIVED: the captured default snapshot with one run added (shape: `AgentRun`), to check the snapshot's runs against
/// the live bounds before they are installed.
mod snapshot_bounds {
    use serde_json::{Value, json};

    use super::{PATH, body};
    use crate::{LiveBounds, Reducer, SyncError};

    fn with_run() -> Value {
        let mut snapshot = body("snapshot");
        snapshot["runs"]["runs"] = json!({ format!("{PATH}#1"): {
            "text": "abc", "model": "m", "steps": [{"id": "a", "title": "a", "status": "done"}, {"id": "b", "title": "b", "status": "running"}],
            "approvals": [{"requestId": "r", "kind": "edit", "tool": "Edit", "title": "t", "allowForChat": false}],
            "questions": [{"requestId": "q", "questions": []}], "answered": {}
        }});
        snapshot["runs"]["seq"] = json!(4);
        snapshot
    }

    const EXACT: LiveBounds = LiveBounds { runs: 1, run_text: 3, steps: 2, requests: 1, names: 32 };

    #[test]
    fn a_snapshot_exactly_at_every_bound_is_installed() {
        let mut reducer = Reducer::with_live_bounds(EXACT);
        let applied = reducer.apply_body(&with_run(), 1).unwrap();
        assert_eq!((applied.runs.runs.len(), applied.runs.seq), (1, 4));
    }

    #[test]
    fn a_snapshot_one_over_any_bound_is_refused_and_the_held_state_is_unchanged() {
        for (bounds, what, limit) in [
            (LiveBounds { runs: 0, ..EXACT }, "runs", 0),
            (LiveBounds { run_text: 2, ..EXACT }, "run text bytes", 2),
            (LiveBounds { steps: 1, ..EXACT }, "steps", 1),
            (LiveBounds { requests: 0, ..EXACT }, "approvals", 0),
        ] {
            let mut reducer = Reducer::with_live_bounds(bounds);
            reducer.apply_body(&body("snapshot"), 1).unwrap();
            reducer
                .apply_notice(milagre_daemon_client::Notice::Event { wire_seq: 2, scope: None, channel: "x".into(), payload: json!({}) })
                .unwrap();
            let before =
                (reducer.state().unwrap().projects.clone(), reducer.state().unwrap().runs.clone(), reducer.state().unwrap().event_seq);
            let (version, last, released) = (reducer.version(), reducer.last_seq(), reducer.released().count());
            let error = reducer.apply_body(&with_run(), 1).unwrap_err();
            assert_eq!(error.downcast_ref::<SyncError>(), Some(&SyncError::Bound { what, limit }), "{what}");
            let after =
                (reducer.state().unwrap().projects.clone(), reducer.state().unwrap().runs.clone(), reducer.state().unwrap().event_seq);
            assert_eq!(after, before, "{what}: the held state is unchanged");
            assert_eq!((reducer.version(), reducer.last_seq(), reducer.released().count()), (version, last, released));
        }
        // Questions too.
        let mut snapshot = with_run();
        snapshot["runs"]["runs"][format!("{PATH}#1")]["approvals"] = json!([]);
        snapshot["runs"]["runs"][format!("{PATH}#1")]["questions"] =
            json!([{"requestId": "q", "questions": []}, {"requestId": "p", "questions": []}]);
        let error = Reducer::with_live_bounds(EXACT).apply_body(&snapshot, 1).unwrap_err();
        assert_eq!(error.downcast_ref::<SyncError>(), Some(&SyncError::Bound { what: "questions", limit: 1 }));
    }
}
