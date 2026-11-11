//! Real-fixture tests with the backend's `ScriptedActions` (send, interrupt) on `launch_populated()`: explicit
//! `project:open`, an applied and accepted snapshot, then the action, then the released events applied by the live
//! reducer. Events are awaited on the notifications (bounded), never on the action's future: deferred hydration can
//! deliver them after it resolves.

use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::FutureExt as _;
use futures::executor::block_on;
use gpui::{AnyView, AppContext as _, Modifiers, TestAppContext};
use gpui_component::Root;
use milagre_daemon_client::{Client, ClientOptions, Error, FixtureGuard, Notice, Notifications, ScriptedActions};
use milagre_gpui_spike::data::{DataSource, LOCAL, ScopeKey};
use milagre_gpui_spike::workspace::Workspace;
use milagre_gpui_spike::workspace::chat::transcript::{Item, Transcript};
use milagre_gpui_spike::workspace::sidebar::SidebarSeed;
use serde_json::{Value, json};

use super::{AdapterFed, shut_down};
use crate::{DaemonAdapter, LiveStore, Reducer};

/// The documented Scripted sequences (CONTRACT.md, "Notification contract and actual fixture evidence").
const NORMAL: [&str; 5] = ["message-sent", "session-started", "message-sent", "text-delta", "turn-completed"];
const BLOCKED: [&str; 2] = ["message-sent", "session-started"];
const CANCELLED: [&str; 1] = ["turn-cancelled"];
const REPLY: &str = "Scripted isolated reply";
/// The saved reply of a `fixture:blocked-start` turn interrupted before any text delta: empty body, outcome `cancelled`.
/// Specific to that fixture path (no text was streamed), not a general rule for interrupted turns.
const BLOCKED_START_CANCELLED_BODY: &str = "";

struct Opened {
    adapter: DaemonAdapter,
    client: Client,
    notices: Notifications,
    store: LiveStore,
    actions: ScriptedActions,
    path: String,
    last: u64,
    /// The accepted snapshot's global watermark and its runs' sequence, for the evidence output.
    initial: Value,
}

/// Connect; check the actions refuse before `project:open` on this connection; open; snapshot, apply, accept.
async fn open(guard: &FixtureGuard) -> Opened {
    let path = guard.project().to_owned();
    let (client, _, notices) = Client::connect(guard.endpoint(), ClientOptions::default()).await.expect("connect");
    let actions = guard.scripted_actions(&client).expect("scripted actions for this guard's client");
    let refused = actions.send(1, "not opened", "gpui-refused-before-open").await;
    assert!(matches!(&refused, Err(Error::Remote { code, .. }) if code == "ISOLATED_SCOPE_ONLY"), "{refused:?}");
    let refused = actions.interrupt(1).await;
    assert!(matches!(&refused, Err(Error::Remote { code, .. }) if code == "ISOLATED_SCOPE_ONLY"), "{refused:?}");
    client.open_view(&path).await.expect("explicit project:open");
    let snapshot = client.runtime_snapshot().await.expect("snapshot");
    let mut reducer = Reducer::default();
    let runs_seq = reducer.apply_snapshot(&snapshot).expect("apply").runs.seq;
    let initial = json!({"eventSeq": snapshot.event_seq, "runsSeq": runs_seq});
    println!("GPUI_ADAPTER_INITIAL_SNAPSHOT {initial}");
    client.accept_snapshot(&snapshot).await.expect("accept");
    Opened {
        adapter: DaemonAdapter::new(client.clone()),
        client,
        notices,
        store: LiveStore::new(reducer),
        actions,
        path,
        last: snapshot.event_seq,
        initial,
    }
}

impl Opened {
    fn key(&self, chat: u64) -> String {
        ScopeKey::project(LOCAL, &self.path).chat_key(chat)
    }

    /// Applies released notices until an `agent:event` of type `terminal` for `chat` (8 s bound). Each observation
    /// records the event and what the live state shows right after it.
    fn collect(&mut self, chat: u64, terminal: &str) -> Vec<Value> {
        let key = self.key(chat);
        let until = Instant::now() + Duration::from_secs(8);
        let mut seen = Vec::new();
        loop {
            assert!(Instant::now() < until, "no {terminal} within 8 s: {seen:?}");
            match self.notices.next().now_or_never() {
                Some(Some(notice)) => {
                    let Notice::Event { wire_seq, channel, payload, .. } = &notice else { panic!("closed: {notice:?}") };
                    assert!(*wire_seq > self.last, "global wire sequence increases");
                    self.last = *wire_seq;
                    let kind = payload["event"]["type"].as_str().map(str::to_owned);
                    let record = json!({"wireSeq": wire_seq, "channel": channel, "chatId": payload["chatId"], "type": kind,
                        "runSeq": payload["seq"], "statePresent": payload["state"].is_object(),
                        "version": payload["version"], "epoch": payload["epoch"]});
                    let done = channel == "agent:event" && payload["chatId"] == key.as_str() && kind.as_deref() == Some(terminal);
                    self.store.apply_notice(notice).expect("applied");
                    let (run, count) = self.store.read(|r| {
                        let state = r.state().expect("live state");
                        let run = state.runs.get(&key).map(|run| json!({"text": run.text.as_ref(), "model": run.model.as_ref()}));
                        let count = state.projects[0].state.as_ref().and_then(|s| s.sessions.get(&chat)?.summary.as_ref().map(|s| s.count));
                        (run, count)
                    });
                    let mut record = record;
                    record["run"] = run.unwrap_or(Value::Null);
                    record["summaryCount"] = json!(count);
                    seen.push(record);
                    if done {
                        return seen;
                    }
                }
                Some(None) => panic!("stream ended"),
                None => std::thread::sleep(Duration::from_millis(5)),
            }
        }
    }

    /// Applies whatever else arrives within `wait` (late hydrated notices).
    fn drain(&mut self, wait: Duration) -> Vec<Value> {
        let until = Instant::now() + wait;
        let mut seen = Vec::new();
        while Instant::now() < until {
            match self.notices.next().now_or_never() {
                Some(Some(notice)) => {
                    if let Notice::Event { wire_seq, channel, payload, .. } = &notice {
                        assert!(*wire_seq > self.last);
                        self.last = *wire_seq;
                        seen.push(
                            json!({"wireSeq": wire_seq, "channel": channel, "chatId": payload["chatId"], "type": payload["event"]["type"]}),
                        );
                    }
                    self.store.apply_notice(notice).expect("applied");
                }
                Some(None) => panic!("stream ended"),
                None => std::thread::sleep(Duration::from_millis(5)),
            }
        }
        seen
    }

    fn count(&self, chat: u64) -> usize {
        self.store.read(|r| r.state().unwrap().projects[0].state.as_ref().unwrap().sessions[&chat].summary.as_ref().unwrap().count)
    }
}

/// Role, body, client id and outcome of each message, for exact transcript assertions.
fn described(messages: &[milagre_gpui_spike::data::ChatMessage]) -> Vec<Value> {
    use milagre_gpui_spike::data::Role;
    messages
        .iter()
        .map(|m| {
            json!({"role": if m.role == Role::User { "user" } else { "assistant" }, "body": m.body.as_ref(),
                "clientMessageId": m.client_message_id.as_deref(), "outcome": m.outcome.map(|o| o.key())})
        })
        .collect()
}

/// The exact-sequence claims cover the Chat's `agent:event`s up to and including the terminal one. Events released
/// after it (sometimes a `project:state`, sometimes nothing; the contract promises none) are
/// collected for the evidence and only checked to hold no further `agent:event` for the Chat.
fn assert_no_late_agent_events(late: &[Value], key: &str) {
    assert!(late.iter().all(|r| !(r["channel"] == "agent:event" && r["chatId"] == key)), "late agent events: {late:?}");
}

fn types(seen: &[Value], key: &str) -> Vec<String> {
    seen.iter()
        .filter(|r| r["channel"] == "agent:event" && r["chatId"] == key)
        .map(|r| r["type"].as_str().unwrap_or_default().to_owned())
        .collect()
}

#[test]
#[ignore = "real fixture: run through scripts/check-gpui-adapter.py"]
fn a_send_streams_into_the_live_state_and_persists_two_messages() {
    block_on(async {
        let guard = FixtureGuard::launch_populated().await.expect("launch_populated");
        let mut o = open(&guard).await;
        let key = o.key(1);
        assert_eq!(o.count(1), 4);
        let receipt = o.actions.send(1, "Streamed from GPUI", "gpui-action-1").await.expect("send");
        let seen = o.collect(1, "turn-completed");
        let late = o.drain(Duration::from_millis(300));
        assert_no_late_agent_events(&late, &key);
        let observed = types(&seen, &key);
        assert_eq!(observed, NORMAL, "documented Scripted sequence");
        // The run appears with the owner's message-sent, its text grows with the delta, and it ends.
        let at =
            |kind: &str, nth: usize| seen.iter().filter(|r| r["chatId"] == key.as_str() && r["type"] == kind).nth(nth).cloned().unwrap();
        assert_eq!(at("message-sent", 0)["run"], json!({"text": "", "model": "scripted"}));
        assert_eq!(at("text-delta", 0)["run"]["text"], REPLY);
        assert_eq!(at("turn-completed", 0)["run"], Value::Null);
        assert!(o.store.read(|r| r.state().unwrap().runs.get(&key).is_none()));
        // The summary rises by the two persisted messages, from the state the events carry.
        assert_eq!(o.count(1), 6);
        let page =
            o.adapter.chat_messages(ScopeKey::project(LOCAL, &o.path), 1, milagre_gpui_spike::data::PageRequest::OPEN).await.unwrap();
        assert_eq!(page.total, 6);
        assert_eq!(
            described(&page.messages[4..]),
            [
                json!({"role": "user", "body": "Streamed from GPUI", "clientMessageId": "gpui-action-1", "outcome": null}),
                json!({"role": "assistant", "body": REPLY, "clientMessageId": null, "outcome": "completed"}),
            ]
        );
        let o_initial = o.initial.clone();
        o.client.disconnect();
        drop(o);
        shut_down(&guard).await;
        println!("GPUI_ADAPTER_ACTIONS_EVIDENCE send initial={} receipt={receipt} events={} late={}", o_initial, json!(seen), json!(late));
    });
}

#[test]
#[ignore = "real fixture: run through scripts/check-gpui-adapter.py"]
fn a_blocked_start_then_interrupt_cancels_and_removes_the_run() {
    block_on(async {
        let guard = FixtureGuard::launch_populated().await.expect("launch_populated");
        let mut o = open(&guard).await;
        let key = o.key(2);
        let receipt = o.actions.send(2, "fixture:blocked-start", "gpui-action-2").await.expect("send");
        let blocked = o.collect(2, "session-started");
        assert_eq!(types(&blocked, &key), BLOCKED);
        assert!(o.store.read(|r| r.state().unwrap().runs.get(&key).is_some()), "the run is live while blocked");
        let stopped = o.actions.interrupt(2).await.expect("interrupt");
        let cancelled = o.collect(2, "turn-cancelled");
        let late = o.drain(Duration::from_millis(300));
        assert_no_late_agent_events(&late, &key);
        assert_eq!(types(&cancelled, &key), CANCELLED);
        assert!(o.store.read(|r| r.state().unwrap().runs.runs.is_empty()), "the run is removed");
        let page =
            o.adapter.chat_messages(ScopeKey::project(LOCAL, &o.path), 2, milagre_gpui_spike::data::PageRequest::OPEN).await.unwrap();
        assert_eq!(page.total, 4);
        println!("GPUI_ADAPTER_CANCELLED_TRANSCRIPT {}", json!(described(&page.messages)));
        assert_eq!(
            described(&page.messages),
            [
                json!({"role": "user", "body": "Fixture history: another Chat", "clientMessageId": null, "outcome": null}),
                json!({"role": "assistant", "body": REPLY, "clientMessageId": null, "outcome": "completed"}),
                json!({"role": "user", "body": "fixture:blocked-start", "clientMessageId": "gpui-action-2", "outcome": null}),
                json!({"role": "assistant", "body": BLOCKED_START_CANCELLED_BODY, "clientMessageId": null, "outcome": "cancelled"}),
            ]
        );
        let o_initial = o.initial.clone();
        o.client.disconnect();
        assert_eq!(o.actions.interrupt(2).await, Err(Error::Disconnected));
        drop(o);
        shut_down(&guard).await;
        println!(
            "GPUI_ADAPTER_ACTIONS_EVIDENCE cancel initial={o_initial} receipt={receipt} interrupt={stopped} blocked={} cancelled={} late={}",
            json!(blocked),
            json!(cancelled),
            json!(late)
        );
    });
}

#[gpui::test]
#[ignore = "real fixture: run through scripts/check-gpui-adapter.py"]
fn the_mounted_transcript_shows_the_new_messages_after_a_send(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (guard, mut o) = cx.foreground_executor().block_test(async {
        let guard = FixtureGuard::launch_populated().await.expect("launch_populated");
        let o = open(&guard).await;
        (guard, o)
    });
    let fed = cx.foreground_executor().block_test(async {
        let current = o.adapter.current_project().await.unwrap().expect("current");
        let state = o.adapter.read_state(current.project.scope()).await.unwrap();
        let runs = o.adapter.chat_runs(LOCAL.into()).await.unwrap();
        AdapterFed { project: current.project, state, runs }
    });
    cx.update(|cx| {
        cx.set_global(milagre_gpui_spike::theme::Theme::dark());
        cx.set_global(SidebarSeed::default());
        cx.set_global(milagre_gpui_spike::data::Data(Arc::new(fed)));
        gpui_component::init(cx);
        milagre_gpui_spike::theme::component_bridge::init(cx);
    });
    let (root, vcx) = cx.add_window_view(|window, cx| {
        let workspace = cx.new(|cx| Workspace::new(window, cx));
        Root::new(AnyView::from(workspace), window, cx)
    });
    let workspace = root.read_with(vcx, |root, _| root.view().clone().downcast::<Workspace>().expect("the workspace"));
    vcx.run_until_parked();
    let (sidebar, chat) = workspace.read_with(vcx, |w, _| (w.sidebar.clone(), w.chat.clone()));
    let row = vcx.debug_bounds("chat-row-1").expect("row 1 is drawn");
    vcx.simulate_click(row.center(), Modifiers::none());
    let key = sidebar.read_with(vcx, |s, _| s.selected().and_then(|ix| s.row(ix)).map(|row| row.key.to_string())).expect("selected");
    assert_eq!(key, o.key(1));

    // Send, wait for the turn on the notifications, then the same documented seam: open-on-select, swap the items.
    let seen = vcx.foreground_executor().block_test(async {
        o.actions.send(1, "Shown in the GPUI transcript", "gpui-action-3").await.expect("send");
        let seen = o.collect(1, "turn-completed");
        let late = o.drain(Duration::from_millis(300));
        assert_no_late_agent_events(&late, &o.key(1));
        seen
    });
    assert_eq!(types(&seen, &key), NORMAL);
    let page = vcx.foreground_executor().block_test(crate::view::open_on_select(&o.adapter, &key)).expect("transcript");
    let items = crate::view::transcript_items(&page).expect("plain messages");
    chat.update(vcx, |chat, cx| {
        chat.transcript = cx.new(|cx| Transcript::with_items(items, cx));
        chat.running = None;
        cx.notify();
    });
    vcx.run_until_parked();
    let transcript = chat.read_with(vcx, |chat, _| chat.transcript.clone());
    let shown = transcript.read_with(vcx, |t, _| {
        t.items()
            .iter()
            .map(|item| match item {
                Item::User(text) => format!("user: {text}"),
                Item::Prose(prose) => format!("reply: {}", prose.text),
                other => format!("other: {other:?}"),
            })
            .collect::<Vec<_>>()
    });
    assert_eq!(
        shown,
        [
            "user: Fixture history: first turn",
            "reply: Scripted isolated reply",
            "user: Fixture history: second turn",
            "reply: Scripted isolated reply",
            "user: Shown in the GPUI transcript",
            "reply: Scripted isolated reply"
        ]
    );
    let tops: Vec<_> = ["transcript-item-3", "transcript-item-4", "transcript-item-5"]
        .into_iter()
        .map(|id| vcx.debug_bounds(id).expect("drawn").origin.y)
        .collect();
    assert!(tops.windows(2).all(|pair| pair[0] < pair[1]), "the new messages are drawn last, in order: {tops:?}");

    let initial = o.initial.clone();
    o.client.disconnect();
    drop(o);
    cx.foreground_executor().block_test(shut_down(&guard));
    println!("GPUI_ADAPTER_ACTIONS_EVIDENCE transcript initial={initial} key={key:?} items={shown:?} tops={tops:?}");
}

/// The required positive post-snapshot proof: after an explicit open and an applied, accepted snapshot, a scripted send
/// must release state-bearing `agent:event`s (admission `message-sent` and terminal `turn-completed` carry `state`), and
/// the live state they leave is checked. `project:state` is recorded as optional evidence, never required.
#[test]
#[ignore = "real fixture: run through scripts/check-gpui-adapter.py"]
fn a_send_after_the_snapshot_releases_state_bearing_agent_events() {
    block_on(async {
        let guard = FixtureGuard::launch_populated().await.expect("launch_populated");
        let mut o = open(&guard).await;
        let key = o.key(1);
        o.actions.send(1, "Post-snapshot proof", "gpui-post-snapshot").await.expect("send");
        let seen = o.collect(1, "turn-completed");
        let late = o.drain(Duration::from_millis(300));
        assert_no_late_agent_events(&late, &key);
        let bearing: Vec<_> =
            seen.iter().filter(|r| r["channel"] == "agent:event" && r["chatId"] == key.as_str() && r["statePresent"] == true).collect();
        let bearing_types: Vec<_> = bearing.iter().map(|r| r["type"].as_str().unwrap_or_default()).collect();
        assert!(bearing_types.contains(&"message-sent"), "admission carries state: {bearing_types:?}");
        assert!(bearing_types.contains(&"turn-completed"), "the terminal event carries state: {bearing_types:?}");
        let project_states = seen.iter().chain(&late).filter(|r| r["channel"] == "project:state").count();
        // The state the events left: counts, and a stamp exactly as the last state-bearing payload carried it.
        let last = bearing.last().expect("a state-bearing event");
        o.store.read(|reducer| {
            let applied = reducer.state().expect("live state");
            assert!(applied.runs.get(&key).is_none(), "the run ended");
            let open = &applied.projects[0];
            let sessions = &open.state.as_ref().expect("state").sessions;
            let summary = |id: u64| sessions[&id].summary.clone().expect("summary");
            assert_eq!((summary(1).count, summary(2).count), (6, 2));
            assert_eq!(summary(1).last_model.as_deref(), Some("scripted"));
            assert_eq!(summary(1).last_outcome.map(|o| o.key()), Some("completed"));
            assert_eq!(open.stamp.version, last["version"].as_u64());
            assert_eq!(open.stamp.epoch.as_deref(), last["epoch"].as_str());
        });
        // Bodies, models and outcomes as persisted.
        let page =
            o.adapter.chat_messages(ScopeKey::project(LOCAL, &o.path), 1, milagre_gpui_spike::data::PageRequest::OPEN).await.unwrap();
        assert_eq!(page.total, 6);
        let tail: Vec<_> = page.messages[4..]
            .iter()
            .map(|m| (m.body.to_string(), m.model.as_deref().map(str::to_owned), m.outcome.map(|o| o.key())))
            .collect();
        assert_eq!(
            tail,
            [
                ("Post-snapshot proof".to_owned(), Some("scripted".to_owned()), None),
                (REPLY.to_owned(), Some("scripted".to_owned()), Some("completed"))
            ]
        );
        let initial = o.initial.clone();
        o.client.disconnect();
        drop(o);
        shut_down(&guard).await;
        println!(
            "GPUI_ADAPTER_EVIDENCE post_snapshot_send initial={initial} state_bearing={} project_state_optional={project_states} late={}",
            json!(bearing_types),
            json!(late)
        );
    });
}
