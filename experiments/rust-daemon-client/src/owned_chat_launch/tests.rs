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

fn refusal(request: &Request, pid: u32) -> Value {
    json!({"protocolVersion":1,"pid":pid,"uid":unsafe {libc::geteuid()},"dataRoot":request.root,"startupError":{"code":"CHAT_ROOT_BUSY","message":"This dedicated Rust Chat data root is already running"}})
}

#[test]
fn startup_refusal_requires_closed_shape_exact_child_root_and_safe_messages() {
    let parent = private_root();
    let root = parent.path().join("data");
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    write_manifest(&root, &manifest(&root, false));
    let request = Request::prepare(&root, None, false).unwrap();
    let pid = 12345;
    let value = refusal(&request, pid);
    assert_eq!(
        startup_refusal(&value, pid, &request).unwrap(),
        Some(Error::Remote {
            code: "CHAT_ROOT_BUSY".into(),
            message: "This dedicated Rust Chat data root is already running".into(),
            payload: value["startupError"].clone()
        })
    );
    let generic = json!({"code":"CHAT_RUNTIME_START_FAILED","message":"The dedicated Rust Chat runtime could not start"});
    let mut failure = value.clone();
    failure["startupError"] = generic.clone();
    assert_eq!(
        startup_refusal(&failure, pid, &request).unwrap(),
        Some(Error::Remote {
            code: "CHAT_RUNTIME_START_FAILED".into(),
            message: "The dedicated Rust Chat runtime could not start".into(),
            payload: generic
        })
    );
    for (key, replacement) in [
        ("protocolVersion", json!(2)),
        ("pid", json!(pid + 1)),
        ("uid", json!(unsafe { libc::geteuid() } + 1)),
        ("dataRoot", json!("/other-root")),
        ("extra", json!(true)),
        ("startupError", Value::Null),
        (
            "startupError",
            json!({"code":"CHAT_ROOT_BUSY","message":"secret raw path"}),
        ),
        (
            "startupError",
            json!({"code":"CHAT_ROOT_BUSY","message":"This dedicated Rust Chat data root is already running","extra":true}),
        ),
        (
            "startupError",
            json!({"code":"UNKNOWN","message":"This dedicated Rust Chat data root is already running"}),
        ),
    ] {
        let mut invalid = value.clone();
        invalid[key] = replacement;
        assert!(
            startup_refusal(&invalid, pid, &request).is_err(),
            "accepted {invalid}"
        );
    }
    for key in ["protocolVersion", "pid", "uid", "dataRoot"] {
        let mut invalid = value.clone();
        invalid.as_object_mut().unwrap().remove(key);
        assert!(startup_refusal(&invalid, pid, &request).is_err());
    }
    assert_eq!(
        startup_refusal(&json!({"success":"handled separately"}), pid, &request).unwrap(),
        None
    );
    fs::write(root.join(MANIFEST), b"{}").unwrap();
    assert!(
        startup_refusal(&value, pid, &request).is_err(),
        "a refusal cannot bypass captured root/selection checks"
    );
}

#[test]
fn startup_refusal_line_uses_existing_size_deadline_and_json_bounds() {
    use std::os::unix::net::UnixStream;
    let body = json!({"startupError":{"code":"CHAT_ROOT_BUSY","message":"This dedicated Rust Chat data root is already running"}});
    for length in [4096, 4097] {
        let mut bytes = serde_json::to_vec(&body).unwrap();
        bytes.resize(length - 1, b' ');
        bytes.push(b'\n');
        let (mut input, mut output) = UnixStream::pair().unwrap();
        let writer = thread::spawn(move || output.write_all(&bytes).unwrap());
        let fd = input.as_raw_fd();
        let result = read_line(&mut input, fd, Instant::now() + Duration::from_secs(1));
        if length == 4096 {
            assert_eq!(result.unwrap(), body);
        } else {
            assert!(matches!(
                result,
                Err(Error::Launch {
                    code: "FIXTURE_RECEIPT_TOO_LARGE",
                    ..
                })
            ));
        }
        drop(input);
        writer.join().unwrap();
    }
    for bytes in [b"{not-json}\n".to_vec(), vec![b'x'; 4097]] {
        let (mut input, mut output) = UnixStream::pair().unwrap();
        let worker = thread::spawn(move || {
            let _ = output.write_all(&bytes);
        });
        let fd = input.as_raw_fd();
        assert!(read_line(&mut input, fd, Instant::now() + Duration::from_secs(1)).is_err());
        drop(input);
        worker.join().unwrap();
    }
    let (mut input, _output) = UnixStream::pair().unwrap();
    let fd = input.as_raw_fd();
    assert!(matches!(
        read_line(&mut input, fd, Instant::now()),
        Err(Error::Launch {
            code: "FIXTURE_RECEIPT_TIMEOUT",
            ..
        })
    ));
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
        matches!(block_on(OwnedChatGuard::open(&root)),Err(Error::Remote{code,..}) if code=="CHAT_ROOT_BUSY"),
        "public open must preserve the dedicated owner's typed Busy refusal"
    );
    let (rejected, observed) = mpsc::channel();
    let mut second = Request::prepare(&root, None, false).unwrap();
    second.rejected = Some(rejected);
    let refused = block_on(launch_request(second))
        .err()
        .expect("a second owner must refuse");
    assert!(
        matches!(&refused,Error::Remote{code,..} if code=="CHAT_ROOT_BUSY"),
        "wrong startup refusal: {refused}"
    );
    let (rejected_pid, rejected_storage) = observed.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_ne!(rejected_pid, guard.info().pid);
    let until = Instant::now() + Duration::from_secs(5);
    while rejected_storage.exists() && Instant::now() < until {
        thread::sleep(POLL);
    }
    assert!(
        !rejected_storage.exists(),
        "rejected child was not reaped/temporary storage retained"
    );
    assert!(root.exists());
    assert!(guard.info().profile.exists());
    assert!(guard.info().socket.exists());
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
        json!({"reads":6,"reconnect":true,"secondWriterRefused":true,"secondWriterCode":"CHAT_ROOT_BUSY","rejectedPid":rejected_pid,"rejectedLaunchStorageRemoved":true,"firstOwnerUsable":true,"epochChanged":true,"sameState":true})
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

#[test]
#[ignore = "run only using scripts/check-owned-chat.py with its private fixed-sibling stage"]
fn owned_chat_git_reads_an_actual_owned_repo_without_provider_execution() {
    use crate::{GitDiffFileOptions, GitDiffMode, GitDiffOptions, GitHistoryOptions, TerminalSize};
    let parent = private_root();
    let root = parent.path().join("data");
    let guard = block_on(launch_request(
        Request::prepare(&root, Some(Path::new("/private-test-selection")), true).unwrap(),
    ))
    .unwrap();
    let (client, _, _events) = block_on(guard.connect(ClientOptions::default())).unwrap();
    let git = guard.git_reads(&client).unwrap();
    assert_eq!(block_on(git.changes(None)), Err(Error::ViewNotOpened));
    assert_eq!(
        block_on(git.pr_diff_files(&"0".repeat(40), &"0".repeat(40))),
        Err(Error::ViewNotOpened)
    );
    block_on(client.open_view(guard.project())).unwrap();
    let snapshot = block_on(client.runtime_snapshot()).unwrap();
    block_on(client.accept_snapshot(&snapshot)).unwrap();
    assert_eq!(block_on(git.changes(None)).unwrap()["isRepo"], false);
    assert_eq!(
        block_on(git.history(Default::default())).unwrap()["isRepo"],
        false
    );
    assert_eq!(
        block_on(git.diff_files(Default::default())).unwrap()["isRepo"],
        false
    );
    assert!(
        matches!(block_on(git.diff_file("hello.txt",Default::default())),Err(Error::Remote{code,..}) if code == "GIT_NOT_REPOSITORY")
    );
    let terminal = guard.terminal_actions(&client).unwrap();
    let opened = block_on(terminal.open(1, TerminalSize::default())).unwrap();
    let id = opened["id"].as_str().unwrap();
    // All mutations here are explicit test setup in this generated Project's PTY.
    // GitReads itself exposes no write command. Identity and HOME are synthetic.
    let setup="set -e; export HOME=\"$PWD/.git-client-home\"; mkdir \"$HOME\"; export XDG_CONFIG_HOME=\"$HOME/.config\" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=Synthetic GIT_AUTHOR_EMAIL=synthetic@example.invalid GIT_COMMITTER_NAME=Synthetic GIT_COMMITTER_EMAIL=synthetic@example.invalid; /usr/bin/git init -b main; printf 'baseline\\n' > hello.txt; /usr/bin/git add -- hello.txt; /usr/bin/git -c core.hooksPath=/dev/null -c commit.gpgsign=false commit -qm baseline; /usr/bin/git checkout -qb topic; printf 'topic\\n' > hello.txt; /usr/bin/git add -- hello.txt; /usr/bin/git -c core.hooksPath=/dev/null -c commit.gpgsign=false commit -qm topic-read-check; printf 'working\\n' > hello.txt; printf 'untracked\\n' > new.txt; printf '\\147\\151\\164\\055\\143\\154\\151\\145\\156\\164\\055\\162\\145\\141\\144\\171\\012'\n";
    block_on(terminal.input(id, setup)).unwrap();
    let (reader, _, _read_events) = block_on(guard.connect(ClientOptions::default())).unwrap();
    block_on(reader.open_view(guard.project())).unwrap();
    let snapshot = block_on(reader.runtime_snapshot()).unwrap();
    block_on(reader.accept_snapshot(&snapshot)).unwrap();
    let output = guard.terminal_actions(&reader).unwrap();
    let until = Instant::now() + Duration::from_secs(15);
    let mut text = String::new();
    let mut offset = 0;
    while !text.contains("git-client-ready\r\n") {
        assert!(
            Instant::now() < until,
            "synthetic Git setup did not finish: {text:?}"
        );
        let read = block_on(output.read(id, offset, Some(4096))).unwrap();
        text.push_str(read["data"].as_str().unwrap());
        offset = read["offset"].as_u64().unwrap();
        assert_ne!(read["ended"], true, "synthetic Git setup exited: {text:?}");
    }
    let changes = block_on(git.changes(Some("main"))).unwrap();
    assert_eq!(changes["isRepo"], true);
    assert_eq!(changes["hasChanges"], true);
    assert!(changes["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["path"] == "hello.txt"));
    let history = block_on(git.history(GitHistoryOptions {
        base: Some("main".into()),
        limit: Some(10),
        ..Default::default()
    }))
    .unwrap();
    assert_eq!(history["commits"][0]["message"], "topic-read-check");
    let head = history["head"].as_str().unwrap();
    assert_eq!(head.len(), 40);
    let files = block_on(git.diff_files(Default::default())).unwrap();
    assert!(files["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["path"] == "hello.txt"));
    let working = block_on(git.diff_file("hello.txt", Default::default())).unwrap();
    assert!(working["patch"].as_str().unwrap().contains("+working"));
    let untracked = block_on(git.diff_file(
        "new.txt",
        GitDiffFileOptions {
            untracked: true,
            ..Default::default()
        },
    ))
    .unwrap();
    assert!(untracked["patch"].as_str().unwrap().contains("+untracked"));
    let committed = GitDiffOptions {
        mode: GitDiffMode::Committed,
        base: Some("main".into()),
        commit: Some(head.into()),
    };
    let files = block_on(git.diff_files(committed.clone())).unwrap();
    assert_eq!(files["commit"], head);
    assert!(files["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| row["path"] == "hello.txt"));
    let patch = block_on(git.diff_file(
        "hello.txt",
        GitDiffFileOptions {
            diff: committed,
            ..Default::default()
        },
    ))
    .unwrap();
    assert!(patch["patch"].as_str().unwrap().contains("+topic"));
    assert_eq!(
        fs::read_to_string(Path::new(guard.project()).join("hello.txt")).unwrap(),
        "working\n"
    );
    assert_eq!(
        block_on(git.history(GitHistoryOptions {
            limit: Some(0),
            ..Default::default()
        }))
        .unwrap()["head"],
        head
    );
    let base = fs::read_to_string(Path::new(guard.project()).join(".git/refs/heads/main"))
        .unwrap()
        .trim()
        .to_owned();
    let index = fs::read(Path::new(guard.project()).join(".git/index")).unwrap();
    let pr_files = block_on(git.pr_diff_files(&base, head)).unwrap();
    assert_eq!(pr_files["files"][0]["path"], "hello.txt");
    let pr_patch = block_on(git.pr_diff_file(&base, head, "hello.txt", None)).unwrap();
    assert!(pr_patch["patch"].as_str().unwrap().contains("+topic"));
    assert!(!pr_patch["patch"].as_str().unwrap().contains("+working"));
    let missing = block_on(git.pr_diff_files(&base, &"0".repeat(40))).unwrap();
    assert_eq!(
        missing["message"],
        "Fetch this PR's commits to see its diff here."
    );
    assert_eq!(
        fs::read(Path::new(guard.project()).join(".git/index")).unwrap(),
        index
    );
    block_on(terminal.close(id)).unwrap();
    complete(&guard);
    client.disconnect();
    reader.disconnect();
    assert_eq!(block_on(git.changes(None)), Err(Error::Disconnected));
    let original_pid = guard.info().pid;
    drop((git, terminal, output, client, reader, guard));
    let reopened = block_on(launch_request(Request::prepare(&root, None, true).unwrap())).unwrap();
    let (client, _, _events) = block_on(reopened.connect(ClientOptions::default())).unwrap();
    block_on(client.open_view(reopened.project())).unwrap();
    let snapshot = block_on(client.runtime_snapshot()).unwrap();
    block_on(client.accept_snapshot(&snapshot)).unwrap();
    let git = reopened.git_reads(&client).unwrap();
    assert_eq!(block_on(git.pr_diff_files(&base, head)).unwrap(), pr_files);
    assert_eq!(
        block_on(git.pr_diff_file(&base, head, "hello.txt", None)).unwrap(),
        pr_patch
    );
    assert_eq!(
        fs::read_to_string(Path::new(reopened.project()).join("hello.txt")).unwrap(),
        "working\n"
    );
    complete(&reopened);
    client.disconnect();
    println!(
        "OWNED_CHAT_GIT_EVIDENCE {}",
        json!({"pid":original_pid,"restartPid":reopened.info().pid,"restartPrDiffEqual":true,"realProvider":false,"realRepository":true,"routes":6,"localPrDiff":true,"missingCommitsRefuseWithoutFetch":true,"indexUnchanged":true,"privateSetupHome":true,"explicitSyntheticIdentity":true,"repoInitializationObserved":true,"commit":head,"uncommittedPatch":true,"untrackedPatch":true,"committedPatch":true,"workingFileUnchanged":true})
    );
}

#[test]
#[ignore = "run only using scripts/check-owned-chat.py with its private fixed-sibling stage"]
fn owned_chat_pr_details_uses_explicit_github_selection_and_observed_viewer() {
    let parent = private_root();
    let root = parent.path().join("data");
    let home = parent.path().join("home");
    let account = parent.path().join("gh-account");
    fs::create_dir(&home).unwrap();
    fs::create_dir(&account).unwrap();
    let config_file = account.join("hosts.yml");
    fs::write(&config_file, "synthetic-alice\n").unwrap();
    fs::set_permissions(&config_file, fs::Permissions::from_mode(0o600)).unwrap();
    let calls = parent.path().join("gh-calls");
    let script = parent.path().join("gh.py");
    fs::write(&script,format!(r#"import json,os,sys
assert 'owner=example' in sys.argv and 'name=repo' in sys.argv
assert any(s.startswith('query=') and 'viewer {{ login }}' in s for s in sys.argv)
assert not any(k in os.environ for k in ['GH_TOKEN','GITHUB_TOKEN','NODE_OPTIONS','SSH_AUTH_SOCK'])
with open({calls:?},'a') as f:f.write('called'+chr(10))
print(json.dumps({{'data':{{'viewer':{{'login':'alice'}},'repository':{{'pullRequest':{{'number':12,'title':'SDK PR','state':'OPEN','baseRefOid':'1'*40,'headRefOid':'2'*40,'files':{{'nodes':[],'pageInfo':{{'hasNextPage':False}}}}}}}}}}}}))
"#,calls=calls.to_str().unwrap())).unwrap();
    let gh = parent.path().join("gh");
    fs::write(
        &gh,
        format!(
            "#!/bin/sh\nexec /usr/bin/python3 '{}' \"$@\"\n",
            script.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&gh, fs::Permissions::from_mode(0o700)).unwrap();
    let fake = std::env::current_exe()
        .unwrap()
        .canonicalize()
        .unwrap()
        .parent()
        .unwrap()
        .join("runtime-fake-claude");
    let skills = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/core/src/bundled-skills")
        .canonicalize()
        .unwrap();
    let selected = parent.path().join("selection.json");
    fs::write(&selected,json!({"program":fake,"home":home,"configDirectory":home,"skillsDirectory":skills,"model":"sonnet","path":"/usr/bin:/bin","accountId":"11111111-1111-4111-8111-111111111111","accountLabel":"Synthetic selected account","userName":"synthetic-user",
        "githubRead":{"program":gh,"home":home,"configDirectory":account,"path":"/usr/bin:/bin","accountLogin":"alice","owner":"example","repository":"repo"}}).to_string()).unwrap();
    fs::set_permissions(&selected, fs::Permissions::from_mode(0o600)).unwrap();
    let guard = block_on(OwnedChatGuard::create(&root, &selected)).unwrap();
    assert!(!calls.exists(), "Capture must not probe GitHub");
    let (client, _, _events) = block_on(guard.connect(ClientOptions::default())).unwrap();
    let reads = guard.pr_details(&client).unwrap();
    assert!(matches!(
        block_on(reads.detail(12)),
        Err(Error::ViewNotOpened)
    ));
    block_on(client.open_view(guard.project())).unwrap();
    let snapshot = block_on(client.runtime_snapshot()).unwrap();
    block_on(client.accept_snapshot(&snapshot)).unwrap();
    let first = block_on(reads.detail(12)).unwrap();
    assert_eq!(first["pr"]["title"], "SDK PR");
    assert_eq!(first["pr"]["headRefOid"], "2".repeat(40));
    fs::write(&config_file, "synthetic-other\n").unwrap();
    assert!(
        matches!(block_on(reads.detail(12)),Err(Error::Remote{code,..}) if code=="PR_SELECTION_REVOKED")
    );
    assert_eq!(fs::read_to_string(&calls).unwrap().lines().count(), 1);
    complete(&guard);
    client.disconnect();
    assert_eq!(block_on(reads.detail(12)), Err(Error::Disconnected));
    drop(guard);
    let guard = block_on(OwnedChatGuard::open(&root)).unwrap();
    let (client, _, _events) = block_on(guard.connect(ClientOptions::default())).unwrap();
    block_on(client.open_view(guard.project())).unwrap();
    let snapshot = block_on(client.runtime_snapshot()).unwrap();
    block_on(client.accept_snapshot(&snapshot)).unwrap();
    assert_eq!(
        block_on(guard.pr_details(&client).unwrap().detail(12)).unwrap(),
        first
    );
    complete(&guard);
    client.disconnect();
    println!(
        "OWNED_CHAT_PR_DETAILS_EVIDENCE {}",
        json!({"explicitSyntheticGrant":true,"startupNetwork":false,"viewerObserved":true,"configEditRevoked":true,"restartReadEqual":true,"realProvider":false,"realGithub":false})
    );
}
