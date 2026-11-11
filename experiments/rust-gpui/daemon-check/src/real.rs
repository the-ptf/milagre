//! Real-fixture tests, ignored by default. Run only through `scripts/check-gpui-adapter.py run`, which stages this
//! test runner beside the exact hashed `app-fixture` so `FixtureGuard::launch()` (the only launch path) finds it.
//! Plain tests drive the client with `futures::executor::block_on`; the GPUI test with GPUI's own executor.

use std::collections::HashSet;
use std::sync::Arc;

use futures::FutureExt as _;
use futures::executor::block_on;
use gpui::{AnyView, AppContext as _, TestAppContext};
use gpui_component::Root;
use milagre_daemon_client::{Client, ClientOptions, Error, FixtureGuard, Notice, ShutdownReport};
use milagre_gpui_spike::data::{
    ChatRuns, ComputerId, ComputersSnapshot, Data, DataFuture, DataSource, LOCAL, MessagePage, OpenProject, PageRequest, Project,
    PullRequestSnapshot, ScopeKey, StateRead, UsageSnapshot, now, ready,
};
use milagre_gpui_spike::logic::lists::order::ChatOrder;
use milagre_gpui_spike::workspace::sidebar::{Sidebar, SidebarData, SidebarSeed, list::chat_lists};

use crate::{NotAvailable, Reducer, SyncError, connect_and_sync};

pub(super) fn body(name: &str, value: &serde_json::Value) {
    println!("GPUI_ADAPTER_BODY {name} {value}");
}

/// `Complete` with exit 0, stop acknowledged, and profile, socket and launch storage all gone.
pub(super) async fn shut_down(guard: &FixtureGuard) {
    let report = guard.shutdown().await.expect("shutdown");
    println!("GPUI_ADAPTER_SHUTDOWN {report:?}");
    let ShutdownReport::Complete(cleanup) = report else { panic!("fixture not cleanly stopped: {report:?}") };
    assert_eq!(cleanup.exit_code, Some(0));
    assert!(cleanup.stop_acknowledged && cleanup.profile_removed && cleanup.socket_removed && cleanup.launch_storage_removed);
}

fn not_available<T: std::fmt::Debug>(result: anyhow::Result<T>) -> &'static str {
    result.expect_err("not available in this stage").downcast_ref::<NotAvailable>().expect("typed NotAvailable").method
}

#[test]
#[ignore = "real fixture: run through scripts/check-gpui-adapter.py"]
fn six_reads_map_into_gpui_types() {
    block_on(async {
        let guard = FixtureGuard::launch().await.expect("launch");
        let path = guard.project().to_owned();
        let mut synced = connect_and_sync(guard.endpoint()).await.expect("connect, snapshot, apply, accept");
        let adapter = synced.adapter.clone();
        let client = adapter.client().clone();
        assert_eq!(synced.hello.wire, 1);

        // Raw bodies, for the checked-in test files (tests/bodies, paths replaced by a placeholder).
        body("project_current", &client.project_current().await.unwrap());
        body("open_view", &client.open_view(&path).await.unwrap());
        body("project_read_state", &client.project_read(&path, true).await.unwrap());
        body("project_read", &client.project_read(&path, false).await.unwrap());
        let raw = client.state_read(&path).await.unwrap();
        body("state_read", &serde_json::json!({"state": raw.state, "version": raw.version, "epoch": raw.epoch}));
        let raw = client.chat_runs().await.unwrap();
        body("chat_runs", &serde_json::json!({"runs": raw.runs, "seq": raw.seq}));
        body("chat_messages", &client.chat_messages(&path, 1, Default::default()).await.unwrap());
        body("snapshot", &synced.snapshot.body);

        // The applied snapshot, in GPUI types.
        let applied = synced.reducer.state().expect("applied");
        assert_eq!(applied.event_seq, synced.snapshot.event_seq);
        assert_eq!(applied.projects.len(), 1);
        assert_eq!(applied.projects[0].project.path.as_ref(), path);
        assert_eq!(applied.runs, ChatRuns::default());

        // The six reads through the GPUI DataSource.
        let current = adapter.current_project().await.unwrap().expect("a current Project");
        assert_eq!(current.project.path.as_ref(), path);
        assert_eq!(current.project.name.as_ref(), "fixture");
        assert!(!current.project.git);
        assert_eq!(current.project.computer.as_ref(), LOCAL);
        let state = current.state.as_ref().expect("project:current carries the state");
        assert_eq!(state.sessions.keys().copied().collect::<Vec<_>>(), vec![1, 2]);
        assert_eq!(state.worktrees.keys().copied().collect::<Vec<_>>(), vec![1]);
        assert_eq!(state.sessions[&1].agent_name.as_ref(), "fixture");
        assert_eq!(state.sessions[&1].summary.as_ref().map(|s| s.count), Some(0));

        let opened = adapter.open_project(LOCAL.into(), path.clone().into()).await.unwrap();
        assert_eq!(opened.project, current.project);
        let read = adapter.read_project(LOCAL.into(), path.clone().into(), true).await.unwrap();
        assert_eq!(read.state.as_ref(), Some(state));
        assert_eq!(read.stamp.version, Some(1));
        assert!(read.stamp.epoch.is_some());
        let lean = adapter.read_project(LOCAL.into(), path.clone().into(), false).await.unwrap();
        assert!(lean.state.is_none());
        assert_eq!(lean.stamp, read.stamp);

        let scope = ScopeKey::project(LOCAL, &path);
        let state_read = adapter.read_state(scope.clone()).await.unwrap();
        assert_eq!(&state_read.state, state);
        assert_eq!(state_read.stamp, read.stamp);
        assert_eq!(adapter.chat_runs(LOCAL.into()).await.unwrap(), ChatRuns::default());
        let page = adapter.chat_messages(scope.clone(), 1, PageRequest::OPEN).await.unwrap();
        assert_eq!(page, MessagePage { messages: vec![], has_more: false, total: 0 });

        // What the client does not provide answers a typed error, not data.
        assert_eq!(not_available(adapter.computers().await), "computers:list");
        assert_eq!(not_available(adapter.recent_projects(LOCAL.into()).await), "project:recent");
        assert_eq!(not_available(adapter.pull_requests(scope.clone()).await), "pull-requests:snapshot");
        assert_eq!(not_available(adapter.cached_usage(LOCAL.into()).await), "usage:cached");
        assert_eq!(not_available(adapter.chat_runs("other-mac".into()).await), "computers:invoke");
        assert_eq!(not_available(adapter.read_state(ScopeKey::project("other-mac", &path)).await), "computers:invoke");
        // A foreign Project is refused by the client, and the error is passed through whole.
        let foreign = adapter.read_state(ScopeKey::project(LOCAL, "/not/the/fixture")).await.unwrap_err();
        assert_eq!(foreign.downcast_ref::<Error>(), Some(&Error::InvalidScope));

        // Explicit disconnect: the stream closes visibly and the reducer answers that error, not an empty state.
        client.disconnect();
        let closed = synced.notifications.next().await.expect("a terminal notice");
        assert_eq!(closed, Notice::Closed(Error::Disconnected));
        assert_eq!(synced.reducer.apply_notice(closed).unwrap_err(), SyncError::Closed(Error::Disconnected));
        assert_eq!(synced.reducer.state().unwrap_err(), SyncError::Closed(Error::Disconnected));
        assert_eq!(adapter.current_project().await.unwrap_err().downcast_ref::<Error>(), Some(&Error::Disconnected));
        drop(synced);
        drop(adapter);
        drop(client);
        shut_down(&guard).await;
        println!("GPUI_ADAPTER_EVIDENCE six_reads project={path:?} chats=[1,2] worktrees=[1] stamp=v1");
    });
}

#[test]
#[ignore = "real fixture: run through scripts/check-gpui-adapter.py"]
fn chat_messages_paging_options() {
    block_on(async {
        let guard = FixtureGuard::launch().await.expect("launch");
        let path = guard.project().to_owned();
        let synced = connect_and_sync(guard.endpoint()).await.expect("sync");
        let scope = ScopeKey::project(LOCAL, &path);
        let empty = MessagePage { messages: vec![], has_more: false, total: 0 };
        // Before `project:open` on this connection the owner refuses the read; the refusal comes through whole.
        let refused = synced.adapter.chat_messages(scope.clone(), 1, PageRequest::OPEN).await.unwrap_err();
        let Some(Error::Remote { code, .. }) = refused.downcast_ref::<Error>() else { panic!("not a remote refusal: {refused:?}") };
        assert_eq!(code, "ISOLATED_SCOPE_ONLY");
        synced.adapter.open_project(LOCAL.into(), path.clone().into()).await.unwrap();
        for chat in [1, 2] {
            for page in [
                PageRequest::OPEN,
                PageRequest::default(),
                PageRequest { before: None, turns: 1, limit: 2 },
                PageRequest::before(1),
                PageRequest { before: Some(9), turns: 3, limit: 1 },
            ] {
                let read = synced.adapter.chat_messages(scope.clone(), chat, page).await.unwrap();
                assert_eq!(read, empty, "chat {chat} page {page:?}");
            }
        }
        // Options are passed as given and the raw body carries exactly the three paging fields.
        let raw = synced
            .adapter
            .client()
            .chat_messages(&path, 1, milagre_daemon_client::ChatPageOptions { before: Some(5), turns: Some(2), limit: Some(2) })
            .await
            .unwrap();
        let mut keys: Vec<_> = raw.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["hasMore", "messages", "total"]);
        synced.adapter.client().disconnect();
        drop(synced);
        shut_down(&guard).await;
        println!("GPUI_ADAPTER_EVIDENCE paging chats=[1,2] pages=5 total=0 (fixture has no messages; sends are out of scope)");
    });
}

#[test]
#[ignore = "real fixture: run through scripts/check-gpui-adapter.py"]
fn events_are_released_only_after_the_snapshot_is_applied_and_accepted() {
    block_on(async {
        let guard = FixtureGuard::launch().await.expect("launch");
        let (client, _hello, mut notifications) = Client::connect(guard.endpoint(), ClientOptions::default()).await.unwrap();
        let mut reducer = Reducer::default();
        // Held from the handshake: nothing is released before a snapshot is accepted.
        assert!(notifications.next().now_or_never().is_none(), "nothing released before the snapshot");
        let snapshot = client.runtime_snapshot().await.unwrap();
        assert!(notifications.next().now_or_never().is_none(), "nothing released while the snapshot is unaccepted");
        let applied = reducer.apply_snapshot(&snapshot).unwrap();
        assert_eq!(applied.event_seq, snapshot.event_seq);
        assert!(notifications.next().now_or_never().is_none(), "applying is local; still held");
        client.accept_snapshot(&snapshot).await.unwrap();
        // After accept: whatever is released is above the watermark (the idle fixture emits nothing here).
        let mut released = 0;
        while let Some(Some(notice)) = notifications.next().now_or_never() {
            reducer.apply_notice(notice).expect("only events above the watermark");
            released += 1;
        }
        assert!(reducer.released().tail().all(|event| event.wire_seq > snapshot.event_seq));
        // A second capture invalidates the first receipt.
        let second = client.runtime_snapshot().await.unwrap();
        assert_eq!(client.accept_snapshot(&snapshot).await.unwrap_err(), Error::StaleSnapshot);
        reducer.apply_snapshot(&second).unwrap();
        client.accept_snapshot(&second).await.unwrap();
        client.disconnect();
        assert_eq!(notifications.next().await, Some(Notice::Closed(Error::Disconnected)));
        drop(client);
        shut_down(&guard).await;
        println!(
            "GPUI_ADAPTER_EVIDENCE barrier watermark={} second={} released_after_accept={released}",
            snapshot.event_seq, second.event_seq
        );
    });
}

/// The adapter's reads, fetched once, answered synchronously to the sidebar. `computers:list` and `project:recent`
/// are not in the client, so this test shell (not the adapter) lists only this computer and the fixture's Project;
/// PRs and usage stay unavailable.
pub(super) struct AdapterFed {
    pub(super) project: Project,
    pub(super) state: StateRead,
    pub(super) runs: ChatRuns,
}

impl DataSource for AdapterFed {
    fn computers(&self) -> DataFuture<ComputersSnapshot> {
        ready(Ok(ComputersSnapshot::default()))
    }
    fn recent_projects(&self, computer: ComputerId) -> DataFuture<Vec<Project>> {
        ready(Ok(if computer.as_ref() == LOCAL { vec![self.project.clone()] } else { vec![] }))
    }
    fn current_project(&self) -> DataFuture<Option<OpenProject>> {
        ready(Err(NotAvailable { method: "project:current" }.into()))
    }
    fn open_project(&self, _: ComputerId, _: gpui::SharedString) -> DataFuture<OpenProject> {
        ready(Err(NotAvailable { method: "project:open" }.into()))
    }
    fn read_project(&self, _: ComputerId, _: gpui::SharedString, _: bool) -> DataFuture<OpenProject> {
        ready(Err(NotAvailable { method: "project:read" }.into()))
    }
    fn read_state(&self, scope: ScopeKey) -> DataFuture<StateRead> {
        ready(if scope == self.project.scope() { Ok(self.state.clone()) } else { Err(anyhow::anyhow!("unknown scope")) })
    }
    fn chat_runs(&self, _: ComputerId) -> DataFuture<ChatRuns> {
        ready(Ok(self.runs.clone()))
    }
    fn chat_messages(&self, _: ScopeKey, _: u64, _: PageRequest) -> DataFuture<MessagePage> {
        ready(Err(NotAvailable { method: "chat:messages" }.into()))
    }
    fn pull_requests(&self, _: ScopeKey) -> DataFuture<PullRequestSnapshot> {
        ready(Err(NotAvailable { method: "pull-requests:snapshot" }.into()))
    }
    fn cached_usage(&self, _: ComputerId) -> DataFuture<UsageSnapshot> {
        ready(Err(NotAvailable { method: "usage:cached" }.into()))
    }
}

#[gpui::test]
#[ignore = "real fixture: run through scripts/check-gpui-adapter.py"]
fn sidebar_mounts_from_the_adapter(cx: &mut TestAppContext) {
    // The client's futures are woken by its own I/O thread, so the GPUI test scheduler may park while it waits.
    cx.executor().allow_parking();
    let (guard, adapter) = cx.foreground_executor().block_test(async {
        let guard = FixtureGuard::launch().await.expect("launch");
        let synced = connect_and_sync(guard.endpoint()).await.expect("sync");
        (guard, synced.adapter)
    });
    let fed = cx.foreground_executor().block_test(async {
        let current = adapter.current_project().await.unwrap().expect("current");
        let state = adapter.read_state(current.project.scope()).await.unwrap();
        let runs = adapter.chat_runs(LOCAL.into()).await.unwrap();
        AdapterFed { project: current.project, state, runs }
    });
    let path = fed.project.path.clone();
    let source: Arc<dyn DataSource> = Arc::new(fed);

    // What the sidebar reads, through the shared list rules.
    let data = now(SidebarData::load(source.clone())).expect("the sidebar's load");
    assert_eq!(data.scopes.len(), 1);
    assert_eq!(data.scopes[0].project.path, path);
    assert_eq!(data.scopes[0].state.sessions.keys().copied().collect::<Vec<_>>(), vec![1, 2]);
    let lists = chat_lists(&data, ChatOrder::Created, &HashSet::new());

    cx.update(|cx| {
        cx.set_global(milagre_gpui_spike::theme::Theme::dark());
        cx.set_global(SidebarSeed::default());
        cx.set_global(Data(source));
        gpui_component::init(cx);
        milagre_gpui_spike::theme::component_bridge::init(cx);
    });
    let (root, vcx) = cx.add_window_view(|window, cx| {
        let view = cx.new(Sidebar::new);
        Root::new(AnyView::from(view), window, cx)
    });
    let sidebar = root.read_with(vcx, |root, _| root.view().clone().downcast::<Sidebar>().expect("the sidebar"));
    vcx.run_until_parked();
    let rows = sidebar.read_with(vcx, |sidebar, _| sidebar.row_count());
    // Both fixture Chats have `summary.count` 0: the shared listing rule keeps empty starter Chats out of the lists,
    // so the mounted sidebar holds the fixture Project and its Chats but draws no row.
    assert_eq!(lists.rows.len(), 0);
    assert_eq!(rows, lists.pinned.len() + lists.rows.len());
    assert!(vcx.debug_bounds("chat-row-0").is_none());

    adapter.client().disconnect();
    drop(adapter);
    cx.foreground_executor().block_test(shut_down(&guard));
    println!("GPUI_ADAPTER_EVIDENCE sidebar scopes=1 project={path:?} chats=[1,2] listed_rows={rows}");
}

mod actions;
mod populated;
