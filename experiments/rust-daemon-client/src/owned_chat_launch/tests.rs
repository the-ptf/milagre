use super::*;
use crate::{ChatPageOptions, ClientOptions, OwnedChatGuard, OwnedChatShutdown};
use futures::executor::block_on;
use std::os::unix::fs::symlink;

fn private_root() -> tempfile::TempDir {
    let root = tempfile::tempdir_in(fs::canonicalize("/tmp").unwrap()).unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    root
}
fn manifest(root: &Path, fixture: bool) -> Value {
    json!({"schema":1,"kind":"milagre-rust-chat","root":root,"fixture":fixture,"launch":{"model":"sonnet","accountId":"selected-test-account"}})
}
fn write_manifest(root: &Path, value: &Value) {
    fs::write(root.join(MANIFEST), value.to_string()).unwrap();
    fs::set_permissions(root.join(MANIFEST), fs::Permissions::from_mode(0o600)).unwrap();
}

#[test]
fn locations_refuse_production_overlap_and_existing_create_destinations() {
    let parent = private_root();
    let protected = parent.path().join("profile");
    fs::create_dir(&protected).unwrap();
    for refused in [&protected, &protected.join("child"), parent.path()] {
        assert!(location(refused, std::slice::from_ref(&protected)).is_err());
    }
    assert!(location(Path::new("relative"), &[]).is_err());
    assert!(location(&parent.path().join("../bad"), &[]).is_err());
    assert!(location(&parent.path().join("dedicated"), &[protected]).is_ok());
    assert!(Request::prepare(
        parent.path(),
        Some(&parent.path().join("launch.json")),
        false
    )
    .is_err());
    assert!(Request::prepare(&parent.path().join("missing"), None, false).is_err());
}

#[test]
fn captured_selection_refuses_rewrites_replacement_and_symlinks() {
    let root = private_root();
    let value = manifest(root.path(), false);
    write_manifest(root.path(), &value);
    let capture = Selection::capture(root.path(), false).unwrap();
    assert!(Selection::capture(root.path(), true).is_err());
    let original = fs::read(root.path().join(MANIFEST)).unwrap();
    fs::write(root.path().join(MANIFEST), "{}").unwrap();
    assert!(capture.check().is_err());
    fs::write(root.path().join(MANIFEST), &original).unwrap();
    capture.check().unwrap();
    fs::rename(root.path().join(MANIFEST), root.path().join("old")).unwrap();
    write_manifest(root.path(), &value);
    assert!(capture.check().is_err());
    fs::remove_file(root.path().join(MANIFEST)).unwrap();
    symlink(root.path().join("old"), root.path().join(MANIFEST)).unwrap();
    assert!(Selection::capture(root.path(), false).is_err());
}

#[test]
fn manifests_are_bounded_private_and_tied_to_root() {
    let root = private_root();
    let mut value = manifest(root.path(), false);
    value["root"] = json!("/foreign");
    write_manifest(root.path(), &value);
    assert!(Selection::capture(root.path(), false).is_err());
    write_manifest(root.path(), &manifest(root.path(), false));
    fs::set_permissions(
        root.path().join(MANIFEST),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert!(Selection::capture(root.path(), false).is_err());
    fs::set_permissions(
        root.path().join(MANIFEST),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    fs::write(
        root.path().join(MANIFEST),
        vec![b' '; MANIFEST_LIMIT as usize + 1],
    )
    .unwrap();
    assert!(Selection::capture(root.path(), false).is_err());
}

fn complete(guard: &OwnedChatGuard) {
    let until = Instant::now() + Duration::from_secs(15);
    loop {
        match block_on(guard.shutdown()).unwrap() {
            OwnedChatShutdown::Complete(result) => {
                assert_eq!(result.temporary.exit_code, Some(0));
                assert!(result.temporary.stop_acknowledged);
                assert!(result.temporary.profile_removed);
                assert!(result.temporary.socket_removed);
                assert!(result.temporary.launch_storage_removed);
                assert!(result.data_retained);
                println!(
                    "OWNED_CHAT_CLEANUP {}",
                    json!({"pid":result.temporary.pid,"dataRoot":result.data_root,"dataRetained":true,"profileRemoved":true,"socketRemoved":true,"launchStorageRemoved":true})
                );
                return;
            }
            OwnedChatShutdown::Pending { .. } if Instant::now() < until => thread::sleep(POLL),
            other => panic!("cleanup unconfirmed: {other:?}"),
        }
    }
}

#[test]
#[ignore = "run only using scripts/check-owned-chat.py with its private fixed-sibling stage"]
fn owned_chat_reads_restart_and_reconnect() {
    let parent = private_root();
    let root = parent.path().join("data");
    let selected = parent.path().join("selection.json");
    let executable = std::env::current_exe().unwrap().canonicalize().unwrap();
    let fake = executable.parent().unwrap().join("runtime-fake-claude");
    let home = parent.path().join("selected-home");
    fs::create_dir(&home).unwrap();
    let skills = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/core/src/bundled-skills")
        .canonicalize()
        .unwrap();
    fs::write(&selected, json!({"program":fake,"home":home,"configDirectory":home,"skillsDirectory":skills,"model":"sonnet","path":"/usr/bin:/bin","accountId":"11111111-1111-4111-8111-111111111111","accountLabel":"Synthetic selected account","userName":"synthetic-user"}).to_string()).unwrap();
    fs::set_permissions(&selected, fs::Permissions::from_mode(0o600)).unwrap();
    let guard = block_on(OwnedChatGuard::create(&root, &selected)).unwrap();
    assert!(
        block_on(OwnedChatGuard::open(&root)).is_err(),
        "a second owner must refuse"
    );
    let (client, _, _notifications) = block_on(guard.connect(ClientOptions::default())).unwrap();
    let project = guard.project();
    assert!(
        matches!(block_on(client.chat_messages(project, 1, ChatPageOptions::default())), Err(Error::Remote { code, .. }) if code == "ISOLATED_SCOPE_ONLY")
    );
    let current = block_on(client.project_current()).unwrap();
    let read = block_on(client.project_read(project, true)).unwrap();
    let state = block_on(client.state_read(project)).unwrap();
    assert_eq!(current["path"], project);
    assert_eq!(read["state"], state.state);
    assert!(block_on(client.chat_runs())
        .unwrap()
        .runs
        .as_object()
        .unwrap()
        .is_empty());
    block_on(client.open_view(project)).unwrap();
    assert_eq!(
        block_on(client.chat_messages(project, 1, ChatPageOptions::default())).unwrap()["total"],
        0
    );
    let snapshot = block_on(client.runtime_snapshot()).unwrap();
    block_on(client.accept_snapshot(&snapshot)).unwrap();
    client.disconnect();
    let (again, _, _events) = block_on(guard.connect(ClientOptions::default())).unwrap();
    assert_eq!(block_on(again.project_current()).unwrap()["path"], project);
    complete(&guard);
    let original_epoch = state.epoch;
    drop((client, again, guard));
    let reopened = block_on(OwnedChatGuard::open(&root)).unwrap();
    let (client, _, _events) = block_on(reopened.connect(ClientOptions::default())).unwrap();
    block_on(client.open_view(reopened.project())).unwrap();
    let next = block_on(client.state_read(reopened.project())).unwrap();
    assert_ne!(original_epoch, next.epoch);
    assert_eq!(next.state, state.state);
    complete(&reopened);
    println!(
        "OWNED_CHAT_READS_EVIDENCE {}",
        json!({"reads":6,"reconnect":true,"secondWriterRefused":true,"epochChanged":true,"sameState":true})
    );
}

#[test]
#[ignore = "run only using scripts/check-owned-chat.py with its private fixed-sibling stage"]
fn owned_chat_fixed_provider_actions_persist_across_restart() {
    use crate::{Notice, PermissionDecision, PermissionMode, ReplyStyle, SendOptions, SendTarget};
    use futures::FutureExt;
    let parent = private_root();
    let root = parent.path().join("data");
    let request =
        Request::prepare(&root, Some(Path::new("/private-test-selection")), true).unwrap();
    let guard = block_on(launch_request(request)).unwrap();
    let (client, _, mut notifications) = block_on(guard.connect(ClientOptions::default())).unwrap();
    let actions = guard.chat_actions(&client).unwrap();
    assert_eq!(block_on(actions.interrupt(1)), Err(Error::ViewNotOpened));
    block_on(client.open_view(guard.project())).unwrap();
    let snapshot = block_on(client.runtime_snapshot()).unwrap();
    block_on(client.accept_snapshot(&snapshot)).unwrap();
    assert_eq!(
        block_on(actions.respond_permission(1, "stale", PermissionDecision::Deny)).unwrap(),
        false
    );
    assert_eq!(
        block_on(actions.answer_question(1, "stale", None, None)).unwrap(),
        false
    );
    assert_eq!(
        block_on(actions.set_permission_mode(1, PermissionMode::Ask)).unwrap(),
        Value::Null
    );
    let options = SendOptions {
        replies: ReplyStyle::Normal,
        ..SendOptions::default()
    };
    let sent = block_on(actions.send(
        SendTarget::NewProjectChat,
        "Shared client fixed provider turn",
        "owned-send-1",
        options.clone(),
    ))
    .unwrap();
    assert_eq!(sent["sessionId"], 1);
    let duplicate = block_on(actions.send(
        SendTarget::NewProjectChat,
        "This must not be replayed",
        "owned-send-1",
        options,
    ))
    .unwrap();
    assert_eq!(sent, duplicate);
    assert!(!block_on(actions.send_status("owned-send-1"))
        .unwrap()
        .is_null());
    let until = Instant::now() + Duration::from_secs(15);
    let mut answered = false;
    let mut terminal = false;
    let mut last_wire = snapshot.event_seq;
    let mut types = Vec::new();
    while !terminal && Instant::now() < until {
        match notifications.next().now_or_never().flatten() {
            Some(Notice::Event {
                wire_seq,
                channel,
                payload,
                ..
            }) => {
                assert!(wire_seq > last_wire);
                last_wire = wire_seq;
                if channel != "agent:event" {
                    continue;
                }
                let event = &payload["event"];
                types.push(event["type"].clone());
                match event["type"].as_str() {
                    Some("permission-request") => {
                        assert!(!answered);
                        assert_eq!(event["tool"], "Bash");
                        assert_eq!(
                            block_on(actions.respond_permission(
                                1,
                                event["requestId"].as_str().unwrap(),
                                PermissionDecision::AllowOnce
                            ))
                            .unwrap(),
                            true
                        );
                        answered = true;
                    }
                    Some("turn-completed") => terminal = true,
                    Some("turn-failed" | "turn-cancelled") => panic!("fixed turn failed: {event}"),
                    _ => {}
                }
            }
            Some(other) => panic!("unexpected close: {other:?}"),
            None => thread::sleep(POLL),
        }
    }
    assert!(answered && terminal, "types={types:?}");
    let transcript =
        block_on(client.chat_messages(guard.project(), 1, ChatPageOptions::default())).unwrap();
    assert_eq!(transcript["total"], 2);
    let messages = transcript["messages"].as_array().unwrap();
    assert_eq!(messages[0]["body"], "Shared client fixed provider turn");
    assert_eq!(messages[0]["clientMessageId"], "owned-send-1");
    assert_eq!(messages[1]["body"], "Restartable Claude reply");
    assert_eq!(messages[1]["outcome"], "completed");
    block_on(actions.mark_unread(1, true)).unwrap();
    assert_eq!(
        block_on(client.state_read(guard.project())).unwrap().state["sessions"]["1"]["unread"],
        true
    );
    block_on(actions.mark_unread(1, false)).unwrap();
    let before = block_on(client.state_read(guard.project())).unwrap();
    complete(&guard);
    client.disconnect();
    assert_eq!(block_on(actions.interrupt(1)), Err(Error::Disconnected));
    drop((actions, client, guard));
    let reopened = block_on(launch_request(Request::prepare(&root, None, true).unwrap())).unwrap();
    let (client, _, _notifications) = block_on(reopened.connect(ClientOptions::default())).unwrap();
    block_on(client.open_view(reopened.project())).unwrap();
    let after = block_on(client.state_read(reopened.project())).unwrap();
    assert_ne!(after.epoch, before.epoch);
    // Shutdown/recovery clears transient suggestionTurnId. Compare the saved
    // transcript, summaries, preferences and next_id, not that active-turn marker.
    for field in ["next_id", "worktrees"] {
        assert_eq!(after.state[field], before.state[field]);
    }
    for field in ["summary", "native_session_id", "unread", "permissionMode"] {
        assert_eq!(
            after.state["sessions"]["1"][field],
            before.state["sessions"]["1"][field]
        );
    }
    assert_eq!(
        block_on(client.chat_messages(reopened.project(), 1, ChatPageOptions::default())).unwrap(),
        transcript
    );
    let actions = reopened.chat_actions(&client).unwrap();
    assert_eq!(block_on(actions.interrupt(1)).unwrap(), Value::Null);
    assert!(matches!(
        block_on(actions.send_queued_now(1, "missing")),
        Err(Error::Remote { .. })
    ));
    assert_eq!(
        block_on(actions.remove_queued(1, "missing")).unwrap(),
        false
    );
    complete(&reopened);
    println!(
        "OWNED_CHAT_ACTIONS_EVIDENCE {}",
        json!({"provider":"fixed native child","realProvider":false,"messages":2,"duplicateDidNotReplay":true,"staleAnswersRefused":true,"unreadPersisted":true,"epochChanged":true,"sameTranscript":true,"types":types})
    );
}

#[test]
#[ignore = "run only using scripts/check-owned-chat.py with its private fixed-sibling stage"]
fn owned_chat_terminal_actions_use_one_owner_with_explicit_reader_connection() {
    use crate::{Notice, TerminalSize};
    use futures::FutureExt;
    let parent = private_root();
    let root = parent.path().join("data");
    let request =
        Request::prepare(&root, Some(Path::new("/private-test-selection")), true).unwrap();
    let guard = block_on(launch_request(request)).unwrap();
    let (controls, _, mut control_events) =
        block_on(guard.connect(ClientOptions::default())).unwrap();
    let (reader, _, mut read_events) = block_on(guard.connect(ClientOptions::default())).unwrap();
    let terminal = guard.terminal_actions(&controls).unwrap();
    let reads = guard.terminal_actions(&reader).unwrap();
    assert_eq!(block_on(terminal.profiles()), Err(Error::ViewNotOpened));
    assert_eq!(block_on(reads.list(1)), Err(Error::ViewNotOpened));
    for client in [&controls, &reader] {
        block_on(client.open_view(guard.project())).unwrap();
        let snapshot = block_on(client.runtime_snapshot()).unwrap();
        block_on(client.accept_snapshot(&snapshot)).unwrap();
    }
    assert_eq!(
        block_on(terminal.profiles()).unwrap()["defaultShell"],
        "/bin/sh"
    );
    assert_eq!(block_on(terminal.list(1)).unwrap()["terminals"], json!([]));
    let opened = block_on(terminal.open(1, TerminalSize::default())).unwrap();
    let id = opened["id"].as_str().unwrap();
    assert_eq!(opened["cwd"], guard.project());
    assert_eq!(opened["chatId"], format!("{}#1", guard.project()));
    block_on(terminal.input(id, "printf '\\162\\165\\163\\164\\055\\163\\150\\141\\162\\145\\144\\055\\160\\164\\171\\055\\157\\153\\012'\n")).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut offset = 0;
    let mut text = String::new();
    while !text.contains("rust-shared-pty-ok\r\n") {
        assert!(
            Instant::now() < deadline,
            "actual shell output missing: {text:?}"
        );
        let result = block_on(reads.read(id, offset, Some(4096))).unwrap();
        assert_eq!(result["ended"], false);
        if result["reset"] == true {
            text.clear();
        }
        text.push_str(result["data"].as_str().unwrap());
        offset = result["offset"].as_u64().unwrap();
    }
    block_on(terminal.resize(
        id,
        TerminalSize {
            cols: 120,
            rows: 42,
        },
    ))
    .unwrap();
    let listed = block_on(terminal.list(1)).unwrap();
    assert_eq!(listed["terminals"][0]["cols"], 120);
    assert_eq!(listed["terminals"][0]["rows"], 42);
    let (reconnected, _, mut reconnect_events) =
        block_on(guard.connect(ClientOptions::default())).unwrap();
    block_on(reconnected.open_view(guard.project())).unwrap();
    let snapshot = block_on(reconnected.runtime_snapshot()).unwrap();
    block_on(reconnected.accept_snapshot(&snapshot)).unwrap();
    let catchup = guard.terminal_actions(&reconnected).unwrap();
    let replay = block_on(catchup.read(id, 0, None)).unwrap();
    assert!(replay["data"]
        .as_str()
        .unwrap()
        .contains("rust-shared-pty-ok\r\n"));
    assert_eq!(block_on(terminal.close(id)).unwrap(), Value::Null);
    assert_eq!(block_on(terminal.list(1)).unwrap()["terminals"], json!([]));
    assert_eq!(
        block_on(reads.read(id, offset, None)).unwrap()["ended"],
        true
    );
    assert!(matches!(
        block_on(terminal.input(id, "refused")),
        Err(Error::Remote { .. })
    ));
    let mut changed = false;
    let deadline = Instant::now() + Duration::from_secs(5);
    while !changed && Instant::now() < deadline {
        for events in [&mut control_events, &mut read_events, &mut reconnect_events] {
            while let Some(notice) = events.next().now_or_never().flatten() {
                match notice {
                    Notice::Event { channel, .. } => changed |= channel == "terminal:changed",
                    other => panic!("unexpected terminal connection close: {other:?}"),
                }
            }
        }
        if !changed {
            thread::sleep(POLL);
        }
    }
    assert!(changed);
    complete(&guard);
    controls.disconnect();
    reader.disconnect();
    reconnected.disconnect();
    assert_eq!(block_on(terminal.profiles()), Err(Error::Disconnected));
    println!(
        "OWNED_CHAT_TERMINALS_EVIDENCE {}",
        json!({"pid":guard.info().pid,"realProvider":false,"realPty":true,"routes":7,"explicitReaderConnection":true,"sameOwner":true,"reconnectCatchup":true,"octalOutputVerified":true,"resized":[120,42],"changedEvent":true,"closed":true})
    );
}
