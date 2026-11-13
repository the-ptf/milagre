//! The timing-dependent parts of terminals.test.cjs that a recorded fixture can't express (waiting reads, title
//! polling), plus owner behavior the Node daemon relies on: viewers that go away mid-read, the authenticated-command
//! rule, dispose, and the settings file.

mod common;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{resolver, worktree, Events, FakeSpawner};
use milagre_terminals::wire::{self, CommandContext};
use milagre_terminals::{Limits, OpenRequest, ShellCommand, ShellOption, TerminalEvent, Terminals, TerminalsOptions};
use serde_json::json;

struct Fixture {
    terminals: Terminals,
    spawner: Arc<FakeSpawner>,
    events: Events,
    folder: tempfile::TempDir,
}

fn fixture(limits: Limits, settings: Option<std::path::PathBuf>, shells: Option<Vec<ShellOption>>) -> Fixture {
    let folder = tempfile::tempdir().unwrap();
    let mut chats = HashMap::new();
    chats.insert("/p#1".to_owned(), vec![worktree(folder.path(), Some("one"))]);
    chats.insert("/p#2".to_owned(), vec![worktree(folder.path(), None)]);
    let spawner = Arc::new(FakeSpawner::default());
    let events = Events::default();
    let mut options = TerminalsOptions::new(resolver(chats));
    options.spawner = spawner.clone();
    options.shell = Arc::new(|| ShellCommand { file: "/bin/zsh".into(), args: vec!["-l".into()] });
    if let Some(shells) = shells {
        options.available_shells = Arc::new(move || shells.clone());
    }
    options.environment = Arc::new(Default::default);
    options.settings_file = settings;
    options.on_event = events.sink();
    options.limits = limits;
    Fixture { terminals: Terminals::new(options).unwrap(), spawner, events, folder }
}

fn quick() -> Limits {
    Limits { read_wait: Duration::from_millis(50), title_poll: Duration::from_millis(10), ..Limits::default() }
}

fn open(chat: &str) -> OpenRequest {
    OpenRequest { chat_id: chat.into(), ..Default::default() }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_read_waits_for_output_instead_of_returning_at_once() {
    let f = fixture(Limits { read_wait: Duration::from_secs(5), ..quick() }, None, None);
    let id = f.terminals.open(open("/p#1")).await.unwrap().id;
    let terminals = f.terminals.clone();
    let reader = {
        let id = id.clone();
        tokio::spawn(async move { terminals.read(&id, 0, None).await.unwrap() })
    };
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(!reader.is_finished());
    f.spawner.pty(0).emit("late");
    let read = tokio::time::timeout(Duration::from_secs(1), reader).await.unwrap().unwrap();
    assert_eq!((read.data.as_str(), read.offset, read.ended), ("late", 4, false));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_waiting_read_times_out_empty_after_the_read_wait() {
    let f = fixture(quick(), None, None);
    let id = f.terminals.open(open("/p#1")).await.unwrap().id;
    let started = Instant::now();
    let read = f.terminals.read(&id, 0, None).await.unwrap();
    assert!(started.elapsed() >= Duration::from_millis(45));
    assert_eq!((read.data.as_str(), read.offset, read.reset, read.ended), ("", 0, false, false));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shell_that_exits_answers_a_waiting_read() {
    let f = fixture(Limits { read_wait: Duration::from_secs(5), ..quick() }, None, None);
    let id = f.terminals.open(open("/p#1")).await.unwrap().id;
    f.spawner.pty(0).emit("bye");
    let first = f.terminals.read(&id, 0, None).await.unwrap();
    let terminals = f.terminals.clone();
    let waiting = {
        let id = id.clone();
        tokio::spawn(async move { terminals.read(&id, first.offset, None).await.unwrap() })
    };
    tokio::time::sleep(Duration::from_millis(20)).await;
    f.events.take();
    f.spawner.pty(0).exit();
    let ended = tokio::time::timeout(Duration::from_secs(1), waiting).await.unwrap().unwrap();
    assert!(ended.ended);
    assert!(f.terminals.list("/p#1").await.unwrap().terminals.is_empty());
    let events = f.events.take();
    assert_eq!(events[0], TerminalEvent::Changed { chat_id: "/p#1".into() });
    assert_eq!(events[1], TerminalEvent::ShellsChanged);
    assert!(matches!(&events[2], TerminalEvent::Exited { terminal_id, exit, .. } if terminal_id == &id && exit.exit_code == 0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closing_answers_every_waiting_viewer() {
    let f = fixture(Limits { read_wait: Duration::from_secs(5), ..quick() }, None, None);
    let id = f.terminals.open(open("/p#1")).await.unwrap().id;
    let viewers: Vec<_> = (0..3)
        .map(|_| {
            let (terminals, id) = (f.terminals.clone(), id.clone());
            tokio::spawn(async move { terminals.read(&id, 0, None).await.unwrap() })
        })
        .collect();
    tokio::time::sleep(Duration::from_millis(20)).await;
    f.terminals.close(&id).await.unwrap();
    for viewer in viewers {
        assert!(tokio::time::timeout(Duration::from_secs(1), viewer).await.unwrap().unwrap().ended);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_viewer_that_goes_away_mid_read_leaves_the_terminal_for_the_next() {
    let f = fixture(Limits { read_wait: Duration::from_secs(5), ..quick() }, None, None);
    let id = f.terminals.open(open("/p#1")).await.unwrap().id;
    // A window that closes while its long-poll waits: the future is dropped.
    let terminals = f.terminals.clone();
    let gone = {
        let id = id.clone();
        tokio::spawn(async move { terminals.read(&id, 0, None).await })
    };
    tokio::time::sleep(Duration::from_millis(20)).await;
    gone.abort();
    assert!(gone.await.unwrap_err().is_cancelled());
    // A whole client (its own handle) going away does not end the owner either.
    drop(f.terminals.clone());
    f.spawner.pty(0).emit("still here");
    assert!(!f.spawner.pty(0).killed());
    let next = f.terminals.read(&id, 0, None).await.unwrap();
    assert_eq!((next.data.as_str(), next.ended), ("still here", false));
    assert!(f.terminals.input(&id, "x").await.unwrap().accepted);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_terminal_running_a_command_is_retitled_by_the_poll() {
    let f = fixture(quick(), None, None);
    f.terminals.open(open("/p#1")).await.unwrap();
    f.events.take();
    f.spawner.pty(0).set_process("npm");
    let deadline = Instant::now() + Duration::from_secs(2);
    while !f.events.take().contains(&TerminalEvent::Changed { chat_id: "/p#1".into() }) {
        assert!(Instant::now() < deadline, "no title change event");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let listed = &f.terminals.list("/p#1").await.unwrap().terminals[0];
    assert_eq!((listed.title.as_str(), listed.busy), ("npm", true));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn commands_but_list_need_an_authenticated_connection() {
    let f = fixture(quick(), None, None);
    let anonymous = CommandContext::default();
    for command in wire::COMMANDS.iter().filter(|c| **c != "terminal:list") {
        let error = wire::handle(&f.terminals, command, &json!({ "chatId": "/p#1" }), &anonymous).await.unwrap_err();
        assert_eq!(error.0, "Terminal access requires an authenticated connection", "{command}");
    }
    let empty = CommandContext { client_id: Some(String::new()) };
    assert!(wire::handle(&f.terminals, "terminal:open", &json!({ "chatId": "/p#1" }), &empty).await.is_err());
    assert_eq!(
        wire::handle(&f.terminals, "terminal:list", &json!({ "chatId": "/p#1" }), &anonymous).await.unwrap(),
        json!({ "terminals": [] })
    );
    assert_eq!(f.spawner.count(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dispose_ends_everything_and_reports_each_chat() {
    let f = fixture(quick(), None, None);
    f.terminals.open(open("/p#1")).await.unwrap();
    f.terminals.open(open("/p#2")).await.unwrap();
    assert_eq!(f.terminals.size(), 2);
    f.events.take();
    f.terminals.dispose(Duration::from_secs(1)).await;
    assert!(f.spawner.pty(0).killed() && f.spawner.pty(1).killed());
    assert_eq!(f.terminals.size(), 0);
    let changed: Vec<_> = f.events.take().into_iter().filter(|e| matches!(e, TerminalEvent::Changed { .. })).collect();
    assert_eq!(changed.len(), 2);
    assert_eq!(f.terminals.list("/p#1").await.unwrap_err().0, "Terminals are closed.");
    f.terminals.dispose(Duration::from_secs(1)).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_the_last_owner_handle_ends_its_shells() {
    let f = fixture(quick(), None, None);
    f.terminals.open(open("/p#1")).await.unwrap();
    let pty = f.spawner.pty(0);
    drop(f.terminals);
    assert!(pty.killed());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_settings_file_is_written_atomically_and_bad_files_are_no_choice() {
    let data = tempfile::tempdir().unwrap();
    let file = data.path().join("nested").join("terminal-settings.json");
    let shells = vec![ShellOption { file: "/bin/bash".into(), label: "bash".into() }];
    let f = fixture(quick(), Some(file.clone()), Some(shells.clone()));
    f.terminals.set_shell(Some("/bin/bash".into())).await.unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), r#"{"shell":"/bin/bash"}"#);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(file.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
    }
    let leftovers: Vec<_> = std::fs::read_dir(file.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(leftovers.len(), 1, "{leftovers:?}");
    for text in ["not json", "5", "null", r#"{"shell":5}"#] {
        std::fs::write(&file, text).unwrap();
        let again = fixture(quick(), Some(file.clone()), Some(shells.clone()));
        assert_eq!(again.terminals.profiles().await.selected_shell, None, "{text}");
    }
    let _ = f.folder;
}
