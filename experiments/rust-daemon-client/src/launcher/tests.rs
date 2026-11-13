use super::*;
use crate::{ChatPageOptions, Client, ClientOptions, Notice};
use futures::{executor::block_on, FutureExt};
use std::{
    collections::VecDeque,
    os::unix::{fs::symlink, net::UnixListener, process::ExitStatusExt},
};

struct FakeProcess {
    answers: VecDeque<std::io::Result<Option<ExitStatus>>>,
    probes: usize,
    input_closed: usize,
}
impl Process for FakeProcess {
    fn id(&self) -> u32 {
        42
    }
    fn probe(&mut self) -> std::io::Result<Option<ExitStatus>> {
        self.probes += 1;
        self.answers.pop_front().unwrap_or(Ok(None))
    }
    fn close_input(&mut self) {
        self.input_closed += 1;
    }
}
fn fake() -> State<FakeProcess> {
    State {
        process: FakeProcess {
            answers: VecDeque::new(),
            probes: 0,
            input_closed: 0,
        },
        wait: Wait::Running,
        stop_ack: true,
        closing: false,
        storage: Storage::create().unwrap(),
        endpoint: None,
        cleanup: None,
    }
}

#[test]
fn acknowledged_pending_shutdown_keeps_exact_process_input_and_storage() {
    let mut state = fake();
    let path = state.storage.root.path.clone();
    assert_eq!(
        state.shutdown(Instant::now()),
        ShutdownReport::Pending {
            stop_acknowledged: true,
            reason: None
        }
    );
    assert!(path.exists());
    assert_eq!(state.process.input_closed, 0);
    assert!(matches!(state.wait, Wait::Running));
    state
        .process
        .answers
        .push_back(Ok(Some(ExitStatus::from_raw(0))));
    let report = state.shutdown(Instant::now());
    assert!(matches!(
        report,
        ShutdownReport::Complete(Cleanup {
            exit_code: Some(0),
            stop_acknowledged: true,
            launch_storage_removed: true,
            ..
        })
    ));
    let probes = state.process.probes;
    assert_eq!(state.process.input_closed, 1);
    assert!(!path.exists());
    assert_eq!(state.shutdown(Instant::now()), report);
    assert_eq!(state.process.probes, probes);
    assert_eq!(state.process.input_closed, 1);
}

#[test]
fn unknown_reap_is_sticky_and_never_releases_input_or_storage() {
    let mut state = fake();
    let path = state.storage.root.path.clone();
    state
        .process
        .answers
        .push_back(Err(std::io::Error::from_raw_os_error(libc::ECHILD)));
    assert!(matches!(
        state.shutdown(Instant::now()),
        ShutdownReport::Unknown { .. }
    ));
    state
        .process
        .answers
        .push_back(Ok(Some(ExitStatus::from_raw(0))));
    assert!(matches!(
        state.shutdown(Instant::now()),
        ShutdownReport::Unknown { .. }
    ));
    assert!(state.connect(Instant::now() + STOP_WAIT).is_err());
    assert_eq!(state.process.probes, 1);
    assert_eq!(state.process.input_closed, 0);
    assert!(path.exists());
    // This test owns no child; test-only cleanup must not be confused with the unknown path above.
    assert!(state.storage.remove());
}

#[test]
fn an_interrupted_probe_retries_but_a_real_error_never_does() {
    let mut state = fake();
    state
        .process
        .answers
        .push_back(Err(std::io::Error::from_raw_os_error(libc::EINTR)));
    state
        .process
        .answers
        .push_back(Ok(Some(ExitStatus::from_raw(0))));
    assert!(matches!(
        state.shutdown(Instant::now()),
        ShutdownReport::Complete(_)
    ));
    assert_eq!(state.process.probes, 2);
    let mut state = fake();
    state
        .process
        .answers
        .push_back(Err(std::io::Error::from_raw_os_error(libc::EINVAL)));
    assert!(matches!(state.probe(), Wait::Unknown));
    assert!(matches!(state.probe(), Wait::Unknown));
    assert_eq!(state.process.probes, 1);
    assert!(state.storage.remove());
}

#[test]
fn storage_replacement_never_authorizes_deleting_the_replacement() {
    let state = fake();
    let path = state.storage.root.path.clone();
    let moved = path.with_extension("retained");
    fs::rename(&path, &moved).unwrap();
    fs::create_dir(&path).unwrap();
    fs::write(path.join("keep"), b"replacement").unwrap();
    assert!(!state.storage.remove());
    assert_eq!(fs::read(path.join("keep")).unwrap(), b"replacement");
    fs::remove_dir_all(&path).unwrap();
    symlink(moved.join("does-not-exist"), &path).unwrap();
    assert!(!absent(&path));
    assert!(!state.storage.remove());
    assert!(fs::symlink_metadata(&path).unwrap().is_symlink());
    fs::remove_file(&path).unwrap();
    fs::rename(&moved, &path).unwrap();
    assert!(state.storage.remove());
}

#[test]
fn sibling_executable_and_parent_identity_are_checked() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("app-fixture");
    fs::write(&path, b"#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    let executable = Executable::sibling(root.path()).unwrap();
    executable.check().unwrap();
    fs::rename(&path, root.path().join("old")).unwrap();
    fs::write(&path, b"replacement").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(executable.check().is_err());
    fs::remove_file(&path).unwrap();
    symlink(root.path().join("old"), &path).unwrap();
    assert!(Executable::sibling(root.path()).is_err());
    fs::remove_file(&path).unwrap();
    fs::rename(root.path().join("old"), &path).unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o777)).unwrap();
    assert!(Executable::sibling(root.path()).is_err());
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
}

#[test]
fn pinned_directory_mode_and_socket_replacement_are_refused() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("directory");
    fs::create_dir(&path).unwrap();
    let directory = Pin::capture(&path, Kind::Directory).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o500)).unwrap();
    assert!(directory.check().is_err());
    fs::set_permissions(&path, fs::Permissions::from_mode(directory.identity.mode)).unwrap();
    directory.check().unwrap();
    let socket = root.path().join("socket");
    let old = UnixListener::bind(&socket).unwrap();
    let pin = Pin::capture(&socket, Kind::Socket).unwrap();
    fs::rename(&socket, root.path().join("old-socket")).unwrap();
    let _new = UnixListener::bind(&socket).unwrap();
    assert!(pin.check().is_err());
    drop(old);
}

#[test]
fn peer_pid_mismatch_is_refused_even_for_the_same_user() {
    let (one, _two) = UnixStream::pair().unwrap();
    assert!(peer(&one, std::process::id().wrapping_add(1)).is_err());
    #[cfg(target_os = "macos")]
    peer(&one, std::process::id()).unwrap();
}

#[test]
fn reply_line_limit_and_deadline_are_bounded() {
    let (mut read, mut write) = UnixStream::pair().unwrap();
    let fd = read.as_raw_fd();
    assert!(matches!(
        read_line(&mut read, fd, Instant::now()),
        Err(Error::Launch {
            code: "FIXTURE_RECEIPT_TIMEOUT",
            ..
        })
    ));
    let writer = thread::spawn(move || {
        let _ = write.write_all(&vec![b'x'; RECEIPT_LIMIT + 1]);
    });
    assert!(matches!(
        read_line(&mut read, fd, Instant::now() + Duration::from_secs(1)),
        Err(Error::Launch {
            code: "FIXTURE_RECEIPT_TOO_LARGE",
            ..
        })
    ));
    drop(read);
    writer.join().unwrap();
    let (mut read, write) = UnixStream::pair().unwrap();
    let fd = read.as_raw_fd();
    drop(write);
    assert!(matches!(
        read_line(&mut read, fd, Instant::now() + Duration::from_secs(1)),
        Err(Error::Launch {
            code: "FIXTURE_RECEIPT_EOF",
            ..
        })
    ));
}

#[test]
fn a_full_listener_backlog_respects_the_absolute_connect_deadline() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("full.sock");
    let listener = UnixListener::bind(&path).unwrap();
    assert_eq!(unsafe { libc::listen(listener.as_raw_fd(), 1) }, 0);
    listener.set_nonblocking(true).unwrap();
    let (stop, stopped) = mpsc::channel();
    // A deliberately late drain makes a blocking-connect mutation fail rather
    // than hang the test process forever.
    let drainer = thread::spawn(move || {
        if stopped.recv_timeout(Duration::from_millis(600)).is_ok() {
            return;
        }
        loop {
            match listener.accept() {
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) => panic!("{error}"),
            }
            if stopped.recv_timeout(Duration::from_millis(1)).is_ok() {
                return;
            }
        }
    });
    let mut held = Vec::new();
    let started = Instant::now();
    let mut refused = false;
    for _ in 0..16 {
        match connect::until(&path, Instant::now() + Duration::from_millis(80)) {
            Ok(stream) => held.push(stream),
            Err(Error::Launch {
                code: "FIXTURE_CONNECT_TIMEOUT" | "FIXTURE_CONNECT_REFUSED",
                ..
            }) => {
                refused = true;
                break;
            }
            Err(error) => panic!("{error:?}"),
        }
    }
    let elapsed = started.elapsed();
    let mut state = fake();
    state.stop_ack = false;
    // A private synthetic Endpoint pins this state-machine regression to the
    // same saturated listener; receipt authority is exercised in the real run.
    state.endpoint = Some(Endpoint {
        #[cfg(feature = "owned-chat")]
        owned: None,
        profile: root.path().to_owned(),
        project: root.path().to_owned(),
        socket: path.clone(),
        pins: Vec::new(),
        pid: std::process::id(),
    });
    let stop_started = Instant::now();
    assert!(matches!(
        state.shutdown(stop_started + Duration::from_millis(80)),
        ShutdownReport::Pending {
            stop_acknowledged: false,
            reason: Some(_)
        }
    ));
    let stop_elapsed = stop_started.elapsed();
    stop.send(()).unwrap();
    drainer.join().unwrap();
    assert!(!held.is_empty());
    assert!(refused, "listener never saturated");
    assert!(
        elapsed < Duration::from_millis(400),
        "connect exceeded deadline: {elapsed:?}"
    );
    assert!(
        stop_elapsed < Duration::from_millis(400),
        "shutdown connect exceeded its deadline: {stop_elapsed:?}"
    );
    assert_eq!(state.process.input_closed, 0);
    assert!(state.storage.remove());
    assert!(matches!(
        connect::until(&path, Instant::now()),
        Err(Error::Launch {
            code: "FIXTURE_CONNECT_TIMEOUT",
            ..
        })
    ));
}

#[test]
fn receipt_requires_closed_shapes_and_versions_before_reading_paths() {
    for value in [
        json!({}),
        json!({"bootstrapVersion":1,"extra":true}),
        json!({"bootstrapVersion":2}),
    ] {
        assert!(Endpoint::receipt(&value, 42).is_err());
    }
    assert!(keys(&json!({"a":1}), &["a"]));
    assert!(!keys(&json!({"a":1,"extra":true}), &["a"]));
}

#[test]
fn selected_transcript_preset_must_match_receipt() {
    assert!(preset_matches(&json!({"actor":{}}), false));
    assert!(!preset_matches(&json!({"actor":{}}), true));
    for value in [
        Value::Null,
        json!(false),
        json!(3),
        json!("unknown"),
        json!(["three-turns"]),
    ] {
        let receipt = json!({"actor":{"transcriptPreset":value}});
        assert!(!preset_matches(&receipt, true));
        assert!(!preset_matches(&receipt, false));
    }
    let populated = json!({"actor":{"transcriptPreset":"three-turns"}});
    assert!(preset_matches(&populated, true));
    assert!(!preset_matches(&populated, false));
}

fn wait_removed(info: &FixtureInfo) {
    let until = Instant::now() + Duration::from_secs(8);
    while [
        info.profile.as_path(),
        info.socket.as_path(),
        info.launch_root.as_path(),
    ]
    .iter()
    .any(|p| p.exists())
    {
        assert!(Instant::now() < until, "cleanup not confirmed for {info:?}");
        thread::sleep(Duration::from_millis(20));
    }
}

// Fixture-only helper, never public: three admitted scripted sends produce >4 KiB
// of saved transcript and force the real server's result-pages-v1 path.
fn seed_scripted(guard: &FixtureGuard) {
    use std::io::{BufRead, BufReader};
    let mut socket = (guard.authority.connect)().unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut reader = BufReader::new(socket.try_clone().unwrap());
    let mut serial = 0;
    let mut call = |method: &str, args: Value| {
        serial += 1;
        writeln!(
            socket,
            "{}",
            json!({"v":1,"id":serial,"method":method,"args":args,"pages":true})
        )
        .unwrap();
        loop {
            let mut line = String::new();
            assert!(reader.read_line(&mut line).unwrap() > 0);
            assert!(line.len() < 16 * 1024 * 1024);
            let frame: Value = serde_json::from_str(&line).unwrap();
            if frame["id"] == serial {
                assert!(frame.get("error").is_none(), "{frame}");
                return frame["result"].clone();
            }
        }
    };
    call("project:open", json!([guard.project()]));
    for n in 0..3 {
        call(
            "chat:send",
            json!([{ "projectPath":guard.project(),"sessionId":1,"provider":"kiro","model":"scripted","body":format!("client-fixture-{n} {}","x".repeat(1600)),"clientMessageId":format!("shared-client-{n}")} ]),
        );
        let until = Instant::now() + Duration::from_secs(5);
        loop {
            let runs = call("chat:runs", json!([]));
            if runs["runs"].as_object().is_some_and(|runs| runs.is_empty()) {
                break;
            }
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(20));
        }
    }
}

#[test]
#[ignore = "Run only through scripts/check-owned-fixture.py with the real fixed sibling staged"]
fn owned_fixture_end_to_end() {
    block_on(async {
        let guard = FixtureGuard::launch().await.unwrap();
        let info = guard.info().unwrap().clone();
        let project = guard.project().to_owned();
        assert_ne!(info.pid, std::process::id());
        assert_eq!(info.project, info.profile.join("fixture"));
        assert_ne!(info.profile, info.launch_root);
        fs::set_permissions(&info.socket, fs::Permissions::from_mode(0o400)).unwrap();
        assert!(matches!(
            Client::connect(guard.endpoint(), ClientOptions::default()).await,
            Err(Error::Launch {
                code: "FIXTURE_IDENTITY_CHANGED",
                ..
            })
        ));
        fs::set_permissions(&info.socket, fs::Permissions::from_mode(0o600)).unwrap();
        let (client, hello, mut events) =
            Client::connect(guard.endpoint(), ClientOptions::default())
                .await
                .unwrap();
        assert_eq!(hello.owner["pid"], info.pid);
        assert_eq!(client.project_current().await.unwrap()["path"], project);
        client.open_view(&project).await.unwrap();
        assert!(client
            .project_read(&project, false)
            .await
            .unwrap()
            .get("state")
            .is_none());
        assert!(client.state_read(&project).await.unwrap().state["sessions"].is_object());
        assert!(client
            .chat_runs()
            .await
            .unwrap()
            .runs
            .as_object()
            .unwrap()
            .is_empty());
        assert_eq!(
            client
                .chat_messages(&project, 1, ChatPageOptions::default())
                .await
                .unwrap()["total"],
            0
        );
        let initial = client.runtime_snapshot().await.unwrap();
        client.accept_snapshot(&initial).await.unwrap();
        client.accept_snapshot(&initial).await.unwrap();
        seed_scripted(&guard);
        let mut live_terminal_events = 0;
        let mut live_hydrated_events = 0;
        let mut last_wire_seq = initial.event_seq;
        let until = Instant::now() + Duration::from_secs(10);
        while live_terminal_events < 3 {
            assert!(Instant::now() < until, "live hydration did not finish");
            match events.next().now_or_never() {
                Some(Some(Notice::Event {
                    wire_seq,
                    channel,
                    payload,
                    ..
                })) => {
                    assert!(wire_seq > last_wire_seq);
                    last_wire_seq = wire_seq;
                    assert_ne!(payload["stateTooLarge"], true);
                    // This body could not have arrived whole in a 4,096-byte frame.
                    if payload["state"].is_object() && payload["state"].to_string().len() > 4096 {
                        live_hydrated_events += 1;
                    }
                    if channel == "agent:event" && payload["event"]["type"] == "turn-completed" {
                        assert!(payload["state"].is_object());
                        live_terminal_events += 1;
                    }
                }
                Some(other) => panic!("live hydration closed unexpectedly: {other:?}"),
                None => thread::sleep(Duration::from_millis(10)),
            }
        }
        assert!(live_hydrated_events > 0);
        client.disconnect();
        drop(client);
        let (client, hello, _events) = Client::connect(guard.endpoint(), ClientOptions::default())
            .await
            .unwrap();
        assert_eq!(hello.owner["pid"], info.pid);
        client.open_view(&project).await.unwrap();
        let messages = client
            .chat_messages(
                &project,
                1,
                ChatPageOptions {
                    limit: Some(100),
                    ..ChatPageOptions::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(messages["total"], 6);
        assert!(messages.to_string().len() > 4096);
        let page = client
            .chat_messages(
                &project,
                1,
                ChatPageOptions {
                    limit: Some(2),
                    ..ChatPageOptions::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(page["total"], 6);
        assert_eq!(page["messages"].as_array().unwrap().len(), 2);
        assert_eq!(page["hasMore"], true);
        let all = messages["messages"].as_array().unwrap();
        assert_eq!(page["messages"].as_array().unwrap().as_slice(), &all[4..]);
        let previous = client
            .chat_messages(
                &project,
                1,
                ChatPageOptions {
                    before: page["messages"][0]["id"].as_u64(),
                    limit: Some(2),
                    ..ChatPageOptions::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(
            previous["messages"].as_array().unwrap().as_slice(),
            &all[2..4]
        );
        assert_eq!(previous["hasMore"], true);
        let state = client.state_read(&project).await.unwrap();
        assert_eq!(state.state["sessions"]["1"]["summary"]["count"], 6);
        let snapshot = client.runtime_snapshot().await.unwrap();
        assert!(snapshot.body.to_string().len() > 4096);
        assert!(snapshot.event_seq > initial.event_seq);
        client.accept_snapshot(&snapshot).await.unwrap();
        let report = guard.shutdown().await.unwrap();
        let ShutdownReport::Complete(cleanup) = report else {
            panic!("not stopped: {report:?}")
        };
        assert_eq!(cleanup.exit_code, Some(0));
        assert!(
            cleanup.stop_acknowledged
                && cleanup.profile_removed
                && cleanup.socket_removed
                && cleanup.launch_storage_removed
        );
        assert!(Client::connect(guard.endpoint(), ClientOptions::default())
            .await
            .is_err());
        wait_removed(&info);
        println!(
            "OWNED_FIXTURE_EVIDENCE {}",
            json!({"pid":info.pid,"profile":info.profile,"socket":info.socket,"launchRoot":info.launch_root,"reads":6,"scriptedSends":3,"liveTerminalEvents":live_terminal_events,"liveHydratedEvents":live_hydrated_events,"messages":6,"resultBytes":messages.to_string().len(),"snapshotBytes":snapshot.body.to_string().len(),"eventSeq":snapshot.event_seq,"stopAcknowledged":cleanup.stop_acknowledged,"exitCode":cleanup.exit_code,"profileRemoved":cleanup.profile_removed,"socketRemoved":cleanup.socket_removed,"launchRootRemoved":cleanup.launch_storage_removed})
        );
        drop(client);
        drop(guard);
        // A Client's drop does not stop a guard-owned child; another connection still works.
        let guard = FixtureGuard::launch().await.unwrap();
        let info = guard.info().unwrap().clone();
        let (client, _, _) = Client::connect(guard.endpoint(), ClientOptions::default())
            .await
            .unwrap();
        drop(client);
        let (again, hello, _) = Client::connect(guard.endpoint(), ClientOptions::default())
            .await
            .unwrap();
        assert_eq!(hello.owner["pid"], info.pid);
        drop(again);
        drop(guard);
        wait_removed(&info);
        println!(
            "OWNED_FIXTURE_DROP_EVIDENCE {}",
            json!({"pid":info.pid,"profile":info.profile,"socket":info.socket,"launchRoot":info.launch_root,"retainedAcrossClientDrop":true,"removedAfterLastAuthorityDrop":true})
        );
        // Pause the real launcher after exact-child/receipt/peer admission and before
        // publication. Dropping its local receiver must release the eventual guard
        // and close stdin through the same last-authority path, without signals.
        let (ready, wait) = reply::channel();
        let (admitted, observation) = mpsc::sync_channel(1);
        let (release, gate) = mpsc::channel();
        let worker = thread::spawn(move || {
            launch_worker(
                ready,
                false,
                Some(AdmissionPause {
                    admitted,
                    release: gate,
                }),
            )
        });
        let cancelled = observation.recv_timeout(Duration::from_secs(8)).unwrap();
        assert!(cancelled.profile.exists() && cancelled.launch_root.exists());
        drop(wait);
        release.send(()).unwrap();
        wait_removed(&cancelled);
        worker.join().unwrap();
        println!(
            "OWNED_FIXTURE_CANCEL_EVIDENCE {}",
            json!({"pid":cancelled.pid,"profile":cancelled.profile,"socket":cancelled.socket,"launchRoot":cancelled.launch_root,"cancelledBeforePublication":true,"removedAfterCancellation":true})
        );
        populated_fixture().await;
        scripted_actions_fixture().await;
    });
}

async fn scripted_actions_fixture() {
    let guard = FixtureGuard::launch().await.unwrap();
    let info = guard.info().unwrap().clone();
    let project = guard.project().to_owned();
    let (client, hello, mut notices) = Client::connect(guard.endpoint(), ClientOptions::default())
        .await
        .unwrap();
    assert_eq!(hello.owner["pid"], info.pid);
    let actions = guard.scripted_actions(&client).unwrap();
    assert!(matches!(
        actions.send(1, "not opened", "refused-before-open").await,
        Err(Error::Remote { code, .. }) if code == "ISOLATED_SCOPE_ONLY"
    ));
    assert!(matches!(
        actions.interrupt(1).await,
        Err(Error::Remote { code, .. }) if code == "ISOLATED_SCOPE_ONLY"
    ));
    client.open_view(&project).await.unwrap();
    let initial = client.runtime_snapshot().await.unwrap();
    client.accept_snapshot(&initial).await.unwrap();
    let sent = actions
        .send(1, "Public scripted action", "public-action-1")
        .await
        .unwrap();
    let mut last = initial.event_seq;
    let completed = collect_action_events(&mut notices, &mut last, "turn-completed");
    let types = action_types(&completed);
    assert_eq!(
        types,
        [
            "message-sent",
            "session-started",
            "message-sent",
            "text-delta",
            "turn-completed"
        ]
    );
    let transcript = client
        .chat_messages(&project, 1, ChatPageOptions::default())
        .await
        .unwrap();
    assert_eq!(transcript["total"], 2);
    assert_eq!(transcript["messages"][0]["body"], "Public scripted action");
    assert_eq!(
        transcript["messages"][0]["clientMessageId"],
        "public-action-1"
    );
    assert_eq!(transcript["messages"][1]["body"], "Scripted isolated reply");
    assert_eq!(transcript["messages"][1]["outcome"], "completed");
    let before_stop = actions
        .send(2, "fixture:blocked-start", "public-action-2")
        .await
        .unwrap();
    let blocked = collect_action_events(&mut notices, &mut last, "session-started");
    assert_eq!(action_types(&blocked), ["message-sent", "session-started"]);
    assert!(client
        .chat_runs()
        .await
        .unwrap()
        .runs
        .get(format!("{project}#2"))
        .is_some());
    let stopped = actions.interrupt(2).await.unwrap();
    let cancelled = collect_action_events(&mut notices, &mut last, "turn-cancelled");
    assert_eq!(action_types(&cancelled), ["turn-cancelled"]);
    assert!(client
        .chat_runs()
        .await
        .unwrap()
        .runs
        .as_object()
        .unwrap()
        .is_empty());
    let second = client
        .chat_messages(&project, 2, ChatPageOptions::default())
        .await
        .unwrap();
    assert_eq!(second["total"], 2);
    assert_eq!(second["messages"][0]["clientMessageId"], "public-action-2");
    assert_eq!(second["messages"][0]["role"], "user");
    assert_eq!(second["messages"][0]["body"], "fixture:blocked-start");
    assert_eq!(second["messages"][1]["role"], "assistant");
    assert_eq!(second["messages"][1]["body"], "");
    assert_eq!(second["messages"][1]["outcome"], "cancelled");
    client.disconnect();
    assert_eq!(actions.interrupt(2).await, Err(Error::Disconnected));
    let ShutdownReport::Complete(cleanup) = guard.shutdown().await.unwrap() else {
        panic!("scripted actions fixture did not stop")
    };
    assert_eq!(cleanup.exit_code, Some(0));
    assert!(
        cleanup.stop_acknowledged
            && cleanup.profile_removed
            && cleanup.socket_removed
            && cleanup.launch_storage_removed
    );
    wait_removed(&info);
    println!(
        "OWNED_FIXTURE_ACTIONS_EVIDENCE {}",
        json!({
            "pid":info.pid,"profile":info.profile,"socket":info.socket,"launchRoot":info.launch_root,
            "sends":2,"interrupts":1,"viewRefusals":2,"sameConnection":true,
            "completedEvents":completed,"blockedEvents":blocked,"cancelledEvents":cancelled,
            "sendReceipt":sent,"blockedReceipt":before_stop,"interruptReceipt":stopped,
            "messages":4,"cleanup":"Complete"
        })
    );
}

fn collect_action_events(
    notices: &mut crate::Notifications,
    last: &mut u64,
    terminal: &str,
) -> Vec<Value> {
    let until = Instant::now() + Duration::from_secs(8);
    let mut events = Vec::new();
    loop {
        assert!(Instant::now() < until, "missing {terminal}: {events:?}");
        match notices.next().now_or_never() {
            Some(Some(Notice::Event {
                wire_seq,
                channel,
                payload,
                ..
            })) => {
                assert!(wire_seq > *last);
                *last = wire_seq;
                assert!(events.len() < 64, "unexpected event flood");
                let done = channel == "agent:event" && payload["event"]["type"] == terminal;
                // Retain metadata only; the transcript is checked independently above.
                events.push(json!({"wireSeq":wire_seq,"channel":channel,"type":payload["event"]["type"],"runSeq":payload["seq"],"statePresent":payload["state"].is_object()}));
                if done {
                    return events;
                }
            }
            Some(other) => panic!("actions connection closed unexpectedly: {other:?}"),
            None => thread::sleep(Duration::from_millis(5)),
        }
    }
}

fn action_types(events: &[Value]) -> Vec<&str> {
    events
        .iter()
        .filter(|e| e["channel"] == "agent:event")
        .map(|e| e["type"].as_str().unwrap())
        .collect()
}

async fn populated_fixture() {
    let guard = FixtureGuard::launch_populated().await.unwrap();
    let info = guard.info().unwrap().clone();
    let project = guard.project().to_owned();
    let (client, _, mut events) = Client::connect(guard.endpoint(), ClientOptions::default())
        .await
        .unwrap();
    let first = client.runtime_snapshot().await.unwrap();
    assert!(first.body["runs"]["seq"].as_u64().unwrap() > 0);
    client.accept_snapshot(&first).await.unwrap();
    client.project_current().await.unwrap();
    while let Some(notice) = events.next().now_or_never() {
        match notice {
            Some(Notice::Event { channel, .. }) => assert_ne!(channel, "agent:event"),
            other => panic!("Unexpected preset notification: {other:?}"),
        }
    }
    client.open_view(&project).await.unwrap();
    let state = client.state_read(&project).await.unwrap().state;
    for (id, count, title) in [
        ("1", 4, "Fixture history: first turn"),
        ("2", 2, "Fixture history: another Chat"),
    ] {
        let summary = &state["sessions"][id]["summary"];
        assert_eq!(summary["count"], count);
        assert_eq!(summary["titleLine"], title);
        assert_eq!(summary["lastModel"], "scripted");
        assert_eq!(summary["lastOutcome"], "completed");
        assert!(summary["firstAt"].as_i64().unwrap() > 0);
        assert!(summary["lastAt"].as_i64().unwrap() >= summary["firstAt"].as_i64().unwrap());
    }
    assert!(
        state["sessions"]["2"]["summary"]["lastAt"]
            .as_i64()
            .unwrap()
            > state["sessions"]["1"]["summary"]["lastAt"]
                .as_i64()
                .unwrap()
    );
    assert!(client
        .chat_runs()
        .await
        .unwrap()
        .runs
        .as_object()
        .unwrap()
        .is_empty());
    let all = client
        .chat_messages(&project, 1, ChatPageOptions::default())
        .await
        .unwrap();
    assert_eq!(all["total"], 4);
    let messages = all["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 4);
    assert_eq!(messages[1]["body"], "Scripted isolated reply");
    let latest = client
        .chat_messages(
            &project,
            1,
            ChatPageOptions {
                limit: Some(2),
                ..ChatPageOptions::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        latest["messages"].as_array().unwrap().as_slice(),
        &messages[2..]
    );
    assert_eq!(latest["hasMore"], true);
    let earlier = client
        .chat_messages(
            &project,
            1,
            ChatPageOptions {
                before: messages[2]["id"].as_u64(),
                limit: Some(2),
                ..ChatPageOptions::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        earlier["messages"].as_array().unwrap().as_slice(),
        &messages[..2]
    );
    assert_eq!(earlier["hasMore"], false);
    let turn = client
        .chat_messages(
            &project,
            1,
            ChatPageOptions {
                turns: Some(1),
                ..ChatPageOptions::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        turn["messages"].as_array().unwrap().as_slice(),
        &messages[2..]
    );
    let snapshot = client.runtime_snapshot().await.unwrap();
    client.accept_snapshot(&snapshot).await.unwrap();
    client.disconnect();
    let (again, hello, _events) = Client::connect(guard.endpoint(), ClientOptions::default())
        .await
        .unwrap();
    assert_eq!(hello.owner["pid"], info.pid);
    again.open_view(&project).await.unwrap();
    assert_eq!(
        again
            .chat_messages(&project, 1, ChatPageOptions::default())
            .await
            .unwrap(),
        all
    );
    let ShutdownReport::Complete(cleanup) = guard.shutdown().await.unwrap() else {
        panic!("populated fixture did not stop")
    };
    assert_eq!(cleanup.exit_code, Some(0));
    assert!(
        cleanup.stop_acknowledged
            && cleanup.profile_removed
            && cleanup.socket_removed
            && cleanup.launch_storage_removed
    );
    wait_removed(&info);
    println!(
        "OWNED_FIXTURE_POPULATED_EVIDENCE {}",
        json!({"pid":info.pid,"profile":info.profile,"socket":info.socket,"launchRoot":info.launch_root,"presetTurns":3,"clientSends":0,"chats":2,"messages":6,"pagingBefore":true,"pagingLimit":true,"pagingTurns":true,"reconnectSamePid":true,"cleanup": "Complete","snapshotFirst":true,"startupTurnEvents":0})
    );
}
