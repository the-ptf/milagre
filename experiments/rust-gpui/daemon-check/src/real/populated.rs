//! Real-fixture tests on `FixtureGuard::launch_populated()`: the fixed preset with three completed Scripted turns
//! across two Chats (Chat 1: two turns, 4 messages; Chat 2: one turn, 2 messages). No client sends.

use std::collections::HashSet;
use std::sync::Arc;

use futures::executor::block_on;
use gpui::{AnyView, AppContext as _, TestAppContext};
use gpui_component::Root;
use milagre_daemon_client::FixtureGuard;
use milagre_gpui_spike::data::{ChatMessage, DataSource, LOCAL, MessagePage, PageRequest, Role, ScopeKey, now};
use milagre_gpui_spike::logic::lists::order::ChatOrder;
use milagre_gpui_spike::workspace::sidebar::{Sidebar, SidebarData, SidebarSeed, list::chat_lists};

use super::{AdapterFed, body, shut_down};
use crate::connect_and_sync;

const FIRST: &str = "Fixture history: first turn";
const ANOTHER: &str = "Fixture history: another Chat";

fn ids(page: &MessagePage) -> Vec<u64> {
    page.messages.iter().map(|m| m.id).collect()
}

fn assert_turns(messages: &[ChatMessage], chat: u64) {
    for (ix, message) in messages.iter().enumerate() {
        assert_eq!(message.chat, chat);
        assert_eq!(message.role, if ix % 2 == 0 { Role::User } else { Role::Assistant }, "message {ix} of Chat {chat}");
        assert!(!message.body.is_empty());
    }
    assert!(messages.windows(2).all(|pair| pair[0].id < pair[1].id), "oldest first, ids growing");
}

#[test]
#[ignore = "real fixture: run through scripts/check-gpui-adapter.py"]
fn transcripts_open_in_order_and_paging_discriminates() {
    block_on(async {
        let guard = FixtureGuard::launch_populated().await.expect("launch_populated");
        let path = guard.project().to_owned();
        let synced = connect_and_sync(guard.endpoint()).await.expect("sync");
        let adapter = synced.adapter.clone();
        let client = adapter.client().clone();
        let scope = ScopeKey::project(LOCAL, &path);
        adapter.open_project(LOCAL.into(), path.clone().into()).await.unwrap();

        let raw = client.state_read(&path).await.unwrap();
        body("populated_state_read", &serde_json::json!({"state": raw.state, "version": raw.version, "epoch": raw.epoch}));
        let all = || milagre_daemon_client::ChatPageOptions { before: None, turns: Some(20), limit: Some(75) };
        body("populated_chat1_open", &client.chat_messages(&path, 1, all()).await.unwrap());
        body("populated_chat2_open", &client.chat_messages(&path, 2, all()).await.unwrap());
        let one_turn = milagre_daemon_client::ChatPageOptions { turns: Some(1), ..Default::default() };
        body("populated_chat1_last_turn", &client.chat_messages(&path, 1, one_turn).await.unwrap());

        // Opening each transcript: every message, oldest first.
        let chat1 = adapter.chat_messages(scope.clone(), 1, PageRequest::OPEN).await.unwrap();
        assert_eq!((chat1.messages.len(), chat1.total, chat1.has_more), (4, 4, false));
        assert_turns(&chat1.messages, 1);
        let chat2 = adapter.chat_messages(scope.clone(), 2, PageRequest::OPEN).await.unwrap();
        assert_eq!((chat2.messages.len(), chat2.total, chat2.has_more), (2, 2, false));
        assert_turns(&chat2.messages, 2);
        let every = ids(&chat1);

        // Paging discriminates: each option set gives its own correct page of Chat 1.
        let page = |before, turns, limit| PageRequest { before, turns, limit };
        let last_turn = adapter.chat_messages(scope.clone(), 1, page(None, 1, 75)).await.unwrap();
        assert_eq!((ids(&last_turn), last_turn.has_more, last_turn.total), (every[2..].to_vec(), true, 4));
        let earlier = adapter.chat_messages(scope.clone(), 1, page(Some(every[2]), 1, 75)).await.unwrap();
        assert_eq!((ids(&earlier), earlier.has_more), (every[..2].to_vec(), false));
        let newest = adapter.chat_messages(scope.clone(), 1, page(None, 20, 1)).await.unwrap();
        assert_eq!((ids(&newest), newest.has_more), (every[3..].to_vec(), true));
        let three = adapter.chat_messages(scope.clone(), 1, page(None, 20, 3)).await.unwrap();
        assert_eq!((ids(&three), three.has_more), (every[1..].to_vec(), true));
        let before_last = adapter.chat_messages(scope.clone(), 1, page(Some(every[3]), 20, 1)).await.unwrap();
        assert_eq!((ids(&before_last), before_last.has_more), (every[2..3].to_vec(), true));
        let before_first = adapter.chat_messages(scope.clone(), 1, page(Some(every[0]), 20, 75)).await.unwrap();
        assert_eq!((ids(&before_first), before_first.has_more), (vec![], false));

        client.disconnect();
        drop((synced, adapter, client));
        shut_down(&guard).await;
        println!("GPUI_ADAPTER_EVIDENCE populated_transcripts chat1={every:?} chat2={:?} pages=6", ids(&chat2));
    });
}

#[gpui::test]
#[ignore = "real fixture: run through scripts/check-gpui-adapter.py"]
fn the_sidebar_shows_the_two_real_rows(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let (guard, adapter) = cx.foreground_executor().block_test(async {
        let guard = FixtureGuard::launch_populated().await.expect("launch_populated");
        let synced = connect_and_sync(guard.endpoint()).await.expect("sync");
        (guard, synced.adapter)
    });
    let (fed, raw_state) = cx.foreground_executor().block_test(async {
        let current = adapter.current_project().await.unwrap().expect("current");
        let state = adapter.read_state(current.project.scope()).await.unwrap();
        let runs = adapter.chat_runs(LOCAL.into()).await.unwrap();
        let raw = adapter.client().state_read(current.project.path.as_ref()).await.unwrap();
        (AdapterFed { project: current.project, state, runs }, raw.state)
    });
    let path = fed.project.path.clone();
    let mapped = fed.state.state.clone();
    let source: Arc<dyn DataSource> = Arc::new(fed);

    // Summaries arrive intact: what the sidebar loads is the adapter's mapping of the owner's own summaries.
    let data = now(SidebarData::load(source.clone())).expect("the sidebar's load");
    assert_eq!(data.scopes.len(), 1);
    assert_eq!(data.scopes[0].state, mapped);
    let sessions = &data.scopes[0].state.sessions;
    assert_eq!(sessions.keys().copied().collect::<Vec<_>>(), vec![1, 2]);
    for (id, count, title) in [(1u64, 4usize, FIRST), (2, 2, ANOTHER)] {
        let summary = sessions[&id].summary.as_ref().expect("summary");
        let wire = &raw_state["sessions"][id.to_string()]["summary"];
        assert_eq!(summary.count, count);
        assert_eq!(wire["count"], count);
        assert_eq!(summary.first_at, wire["firstAt"].as_i64());
        assert_eq!(summary.last_at, wire["lastAt"].as_i64());
        assert!(summary.first_at.is_some() && summary.last_at.is_some());
        assert_eq!(summary.last_outcome.map(|o| o.key()), wire["lastOutcome"].as_str());
        assert_eq!(summary.last_model.as_deref(), wire["lastModel"].as_str());
        assert_eq!(summary.title_line.as_deref(), wire["titleLine"].as_str());
        println!("GPUI_ADAPTER_SUMMARY chat={id} title={title:?} {summary:?}");
    }
    let lists = chat_lists(&data, ChatOrder::Created, &HashSet::new());

    cx.update(|cx| {
        cx.set_global(milagre_gpui_spike::theme::Theme::dark());
        cx.set_global(SidebarSeed::default());
        cx.set_global(milagre_gpui_spike::data::Data(source));
        gpui_component::init(cx);
        milagre_gpui_spike::theme::component_bridge::init(cx);
    });
    let (root, vcx) = cx.add_window_view(|window, cx| {
        let view = cx.new(Sidebar::new);
        Root::new(AnyView::from(view), window, cx)
    });
    let sidebar = root.read_with(vcx, |root, _| root.view().clone().downcast::<Sidebar>().expect("the sidebar"));
    vcx.run_until_parked();
    let rows = sidebar.read_with(vcx, |sidebar, _| {
        (0..sidebar.row_count())
            .map(|ix| sidebar.row(ix).map(|row| (row.key.to_string(), row.title.to_string())).unwrap())
            .collect::<Vec<_>>()
    });
    println!("GPUI_ADAPTER_ROWS {rows:?}");
    // Exactly the two real Chats, nothing else; the sidebar's order (ChatOrder::Created: newest first message first,
    // else newest last message) puts Chat 2 first, since it started after Chat 1.
    let scope = ScopeKey::project(LOCAL, &path);
    assert_eq!(rows, vec![(scope.chat_key(2), ANOTHER.to_owned()), (scope.chat_key(1), FIRST.to_owned())]);
    assert_eq!(lists.pinned.len() + lists.rows.len(), 2);
    assert!(vcx.debug_bounds("chat-row-0").is_some() && vcx.debug_bounds("chat-row-1").is_some());
    assert!(vcx.debug_bounds("chat-row-2").is_none(), "no third row");

    adapter.client().disconnect();
    drop(adapter);
    cx.foreground_executor().block_test(shut_down(&guard));
    println!("GPUI_ADAPTER_EVIDENCE populated_sidebar rows={rows:?}");
}
