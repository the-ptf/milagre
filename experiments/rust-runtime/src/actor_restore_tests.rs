// Included only by the actor's private unit-test module. Restore stays gated in every executable.
#[cfg(feature = "acp-fixture")]
mod successful_restore {
    use super::*;
    use crate::acp_fixture::{AcpFixture, Scenario};
    use milagre_owner_store::{ProjectRepository, ProjectStore};
    use std::io::{BufRead, BufReader, Read, Write};
    use std::process::{Child, Command, Stdio};

    struct ObservedProvider {
        inner: AcpFixture,
        starts: Arc<Mutex<Vec<Value>>>,
    }
    impl Provider for ObservedProvider {
        fn name(&self) -> &str {
            self.inner.name()
        }
        fn start_turn(&mut self, turn: TurnId, request: &RawJson) -> Result<(), ProviderError> {
            // Test-only observation at admission: before the native worker/process is spawned.
            let saved = ProjectStore::new(self.inner.project().to_owned())
                .read_project_state()
                .map_err(|_| {
                    ProviderError::new(
                        ProviderErrorKind::Refused,
                        "Fixture save observation failed",
                    )
                })?
                .state;
            let transcripts: Vec<_> =
                transcript_files(&self.inner.isolation().root().join(".owner/handovers"))
                    .into_iter()
                    .filter(|path| path.extension().is_some_and(|extension| extension == "md"))
                    .map(|path| fs::read_to_string(path).unwrap())
                    .collect();
            self.starts.lock().unwrap().push(json!({"turn":turn.0,"request":request.0,"saved":saved,"transcripts":transcripts,"thread":format!("{:?}",thread::current().id())}));
            self.inner.start_turn(turn, request)
        }
        fn interrupt(&mut self, chat: &str, turn: TurnId) -> Result<(), ProviderError> {
            self.inner.interrupt(chat, turn)
        }
        fn respond_permission(
            &mut self,
            chat: &str,
            turn: TurnId,
            answer: AnswerId,
            request: &str,
            decision: &str,
        ) -> Result<(), ProviderError> {
            self.inner
                .respond_permission(chat, turn, answer, request, decision)
        }
        fn answer_question(
            &mut self,
            chat: &str,
            turn: TurnId,
            answer: AnswerId,
            request: &str,
            answers: &RawJson,
        ) -> Result<(), ProviderError> {
            self.inner
                .answer_question(chat, turn, answer, request, answers)
        }
        fn close_chat(&mut self, chat: &str, turn: TurnId) -> Result<(), ProviderError> {
            self.inner.close_chat(chat, turn)
        }
        fn shutdown(&mut self) {
            self.inner.shutdown();
        }
        fn take_events(&mut self) -> Vec<ProviderEvent> {
            self.inner.take_events()
        }
    }
    struct ChildGuard(Child);
    impl ChildGuard {
        fn line(&mut self, receive: &Receiver<String>) -> String {
            match receive.recv_timeout(Duration::from_secs(10)) {
                Ok(line) => line,
                Err(error) => {
                    let _ = self.0.kill();
                    let _ = self.0.wait();
                    let mut stderr = String::new();
                    self.0
                        .stderr
                        .take()
                        .unwrap()
                        .read_to_string(&mut stderr)
                        .unwrap();
                    panic!("Node handshake {error}: {stderr}");
                }
            }
        }
    }
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    fn git(project: &std::path::Path, args: &[&str]) {
        let output = Command::new("/usr/bin/git")
            .current_dir(project)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", project)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .args([
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    fn transcript_files(root: &std::path::Path) -> Vec<PathBuf> {
        let mut files = vec![];
        let mut folders = vec![root.to_path_buf()];
        while let Some(folder) = folders.pop() {
            for entry in fs::read_dir(folder).unwrap() {
                let entry = entry.unwrap();
                if entry.file_type().unwrap().is_dir() {
                    folders.push(entry.path());
                } else {
                    files.push(entry.path());
                }
            }
        }
        files
    }
    fn until(label: &str, mut check: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while !check() {
            assert!(Instant::now() < deadline, "Timed out: {label}");
            thread::sleep(Duration::from_millis(5));
        }
    }
    fn lose_readiness(store: &std::path::Path, actor: &Actor) {
        let moved = store.with_file_name("held-handovers");
        fs::rename(store, &moved).unwrap();
        fs::create_dir(store).unwrap();
        until("periodic ownership detection", || {
            actor.shared.snapshot.lock().unwrap()["projects"] == json!([])
        });
        fs::remove_dir(store).unwrap();
        fs::rename(moved, store).unwrap();
        // Repair is intentionally not an open: the actor must stay not ready.
    }
    #[test]
    fn successful_restore_is_saved_before_the_second_acp_process_and_never_replayed() {
        successful_restore(None);
    }
    #[test]
    fn restore_job_completion_waits_for_explicit_reopen_before_second_native_process() {
        successful_restore(Some("job"));
    }
    #[test]
    fn restore_brief_completion_waits_for_explicit_reopen_before_second_native_process() {
        successful_restore(Some("brief"));
    }
    fn successful_restore(loss: Option<&str>) {
        let provider = AcpFixture::create(Scenario::PromptReceipts).unwrap();
        let project = provider.project().to_owned();
        let isolation = provider.isolation();
        let isolated_root = isolation.root().to_owned();
        assert!(project.starts_with(&isolated_root));
        // Fresh own-.git repository only. Never reuse or remap the separate GitService authority.
        git(&project, &["init", "-q"]);
        fs::write(project.join(".gitignore"), ".milagre/\n").unwrap();
        fs::write(project.join("edited.txt"), "before\n").unwrap();
        git(&project, &["add", ".gitignore", "edited.txt"]);
        git(&project, &["commit", "-q", "-m", "private fixture"]);
        let monitor = provider.monitor();
        let starts = Arc::new(Mutex::new(vec![]));
        let mut host = ChatHost::new(ProjectStates::new(isolation, Timing::default(), 0));
        host.enable_restore_for_tests().unwrap();
        host.admit_worktree(&project).unwrap();
        host.open_project(&project).unwrap();
        let brief = milagre_owner_store::brief::fake::FakeBriefModel::default();
        if loss == Some("brief") {
            host.register_brief_model(Box::new(brief.clone()));
        }
        host.register(Box::new(ObservedProvider {
            inner: provider,
            starts: starts.clone(),
        }));
        let (mut workers, gate, entered) = workers(0);
        let (job_finished, completed_job) = mpsc::sync_channel(1);
        workers.after_run = Some(Arc::new(move || {
            let _ = job_finished.send(());
        }));
        let original_hook = workers.before_run.take().unwrap();
        let worker_thread = Arc::new(Mutex::new(None));
        let observed_thread = worker_thread.clone();
        workers.before_run = Some(Arc::new(move || {
            *observed_thread.lock().unwrap() = Some(format!("{:?}", thread::current().id()));
            original_hook()
        }));
        let (server, actor) = running(IsolatedProfile::create().unwrap(), &project, host, workers);
        let _release = ReleaseOnDrop(gate.clone());
        let mut child = ChildGuard(
            Command::new("node")
                .arg(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/tests/restore-success-compat.cjs"
                ))
                .arg(server.profile_path())
                .arg(&project)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let output = child.0.stdout.take().unwrap();
        let (lines, receive) = mpsc::sync_channel(4);
        let reader = thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                if lines.send(line.unwrap()).is_err() {
                    break;
                }
            }
        });
        assert_eq!(child.line(&receive), "preparing");
        entered.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(
            starts.lock().unwrap().len(),
            1,
            "second process cannot start before the transcript job"
        );
        assert_eq!(monitor.pids().len(), 1);
        for (_, pid) in monitor.pids() {
            assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ESRCH)
            );
        }
        let saved = ProjectStore::new(project.clone())
            .read_project_state()
            .unwrap()
            .state;
        let messages = saved["messages"].as_array().unwrap();
        assert_eq!(
            messages
                .iter()
                .filter(|m| m["clientMessageId"] == "restore-second")
                .count(),
            1
        );
        assert_eq!(
            messages
                .iter()
                .find(|m| m["context"]["kind"] == "handoff")
                .unwrap()["context"]["status"],
            "preparing"
        );
        assert!(!transcript_files(&isolated_root.join(".owner/handovers"))
            .iter()
            .any(|p| p.extension().is_some_and(|s| s == "md")));
        let store = isolated_root.join(".owner/handovers");
        if loss == Some("job") {
            lose_readiness(&store, &actor);
        }
        gate.release();
        completed_job.recv_timeout(Duration::from_secs(3)).unwrap();
        if loss == Some("brief") {
            until("brief model admission", || brief.asked().len() == 1);
            lose_readiness(&store, &actor);
            brief.fail(brief.asked()[0].brief); // fixed model failure chooses the same minimal brief
            until("held brief result consumed", || {
                brief.state.lock().unwrap().events.is_empty()
            });
        }
        if loss.is_some() {
            let before = actor.shared.observed_ticks.load(Ordering::Acquire);
            until("paused preparation ticks", || {
                actor.shared.observed_ticks.load(Ordering::Acquire) >= before + 2
            });
            assert_eq!(
                starts.lock().unwrap().len(),
                1,
                "not-ready completion cannot start another native process"
            );
            assert_eq!(monitor.prompt_receipts().len(), 1);
            let saved = ProjectStore::new(project.clone())
                .read_project_state()
                .unwrap()
                .state;
            assert_eq!(
                saved["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|m| m["context"]["kind"] == "handoff")
                    .unwrap()["context"]["status"],
                "preparing"
            );
            if loss == Some("job") {
                assert!(
                    !transcript_files(&store)
                        .iter()
                        .any(|path| path.extension().is_some_and(|ext| ext == "md")),
                    "not-ready job cannot commit its transcript"
                );
            }
        }
        child
            .0
            .stdin
            .as_mut()
            .unwrap()
            .write_all(if loss.is_some() {
                b"reopen\n"
            } else {
                b"continue\n"
            })
            .unwrap();
        assert_eq!(child.line(&receive), "restored");
        let starts = starts.lock().unwrap().clone();
        assert_eq!(
            starts.len(),
            2,
            "idempotent retry does not spawn another process"
        );
        assert_eq!(
            starts[0]["request"]["prompt"],
            "First restore fixture prompt"
        );
        assert_eq!(starts[1]["transcripts"].as_array().unwrap().len(), 1);
        assert!(starts[1]["transcripts"][0]
            .as_str()
            .unwrap()
            .contains("First restore fixture prompt"));
        assert!(starts[1]["transcripts"][0]
            .as_str()
            .unwrap()
            .contains("live"));
        let prompt = starts[1]["request"]["prompt"].as_str().unwrap();
        assert!(prompt.contains("<handoff_brief>"), "{prompt}");
        assert!(prompt.contains("</handoff_brief>"), "{prompt}");
        assert!(prompt.contains("Second restore fixture prompt"), "{prompt}");
        assert!(
            prompt.contains("Changed files:\n- edited.txt\n- fresh.txt"),
            "{prompt}"
        );
        assert_eq!(
            starts[1]["saved"]["messages"]
                .as_array()
                .unwrap()
                .iter()
                .find(|m| m["context"]["kind"] == "handoff")
                .unwrap()["context"]["status"],
            "done"
        );
        assert_ne!(
            worker_thread.lock().unwrap().as_ref().unwrap(),
            starts[1]["thread"].as_str().unwrap()
        );
        let files = transcript_files(&isolated_root.join(".owner/handovers"));
        assert!(!files
            .iter()
            .any(|p| p.extension().is_some_and(|s| s == "tmp")));
        let transcripts: Vec<_> = files
            .iter()
            .filter(|p| p.extension().is_some_and(|s| s == "md"))
            .collect();
        assert_eq!(transcripts.len(), 1);
        let transcript = fs::read_to_string(transcripts[0]).unwrap();
        assert!(transcript.contains("First restore fixture prompt"));
        assert!(transcript.contains("live"));
        assert!(monitor.wait_stopped(Duration::from_secs(3)));
        assert!(!monitor.cleanup_failed());
        assert_eq!(monitor.pids().len(), 2);
        assert_ne!(monitor.pids()[0].1, monitor.pids()[1].1);
        let receipts = monitor.prompt_receipts();
        assert_eq!(
            receipts.len(),
            2,
            "exactly one native observation per process"
        );
        for (index, observation) in receipts.iter().enumerate() {
            use sha2::{Digest, Sha256};
            assert_eq!(observation["turn"], starts[index]["turn"]);
            assert_eq!(observation["pid"], monitor.pids()[index].1);
            assert_eq!(observation["receivedPromptCount"], 1);
            let records = observation["receivedPrompts"].as_array().unwrap();
            assert_eq!(records.len(), 1, "the child parsed no replayed prompt");
            let receipt = &records[0];
            assert_eq!(receipt["sequence"], 1);
            // This proves transport fidelity to Provider admission, not a golden
            // oracle for the owner's brief-generation algorithm.
            let expected = starts[index]["request"]["prompt"].as_str().unwrap();
            assert_eq!(receipt["textBytes"], expected.len());
            assert_eq!(
                receipt["textSha256"],
                format!("{:x}", Sha256::digest(expected.as_bytes()))
            );
            assert_eq!(
                receipt["text"],
                if expected.len() <= 4096 {
                    json!(expected)
                } else {
                    Value::Null
                }
            );
            let frame = milagre_acp::protocol::request_frame(
                receipt["requestId"].as_i64().unwrap(),
                "session/prompt",
                &milagre_acp::protocol::prompt(
                    observation["nativeId"].as_str().unwrap(),
                    &[json!({"type":"text","text":expected})],
                ),
            );
            let bytes = serde_json::to_vec(&frame).unwrap();
            assert_eq!(receipt["frameBytes"], bytes.len());
            assert_eq!(
                receipt["frameSha256"],
                format!("{:x}", Sha256::digest(bytes))
            );
        }

        for (_, pid) in monitor.pids() {
            assert_eq!(unsafe { libc::kill(pid as i32, 0) }, -1);
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ESRCH)
            );
        }
        child
            .0
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"stop\n")
            .unwrap();
        assert_eq!(child.line(&receive), "completed");
        let deadline = Instant::now() + Duration::from_secs(3);
        let status = loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                break status;
            }
            assert!(
                Instant::now() < deadline,
                "Node did not exit after its stop acknowledgement"
            );
            thread::sleep(Duration::from_millis(5));
        };
        assert!(status.success());
        reader.join().unwrap();
        assert!(server.is_stopped());
        assert_eq!(
            *actor.shared.observed_quit.lock().unwrap(),
            Some(QuitState::Done)
        );
        assert_eq!(
            actor.shared.stranded_lock_notices.load(Ordering::Acquire),
            0
        );
        drop(starts);
        drop(actor);
        Server::finish(server).unwrap();
        assert!(
            !isolated_root.exists(),
            "joined owner/provider teardown releases the private profile"
        );
    }
    struct HeldMock {
        inner: milagre_owner_store::chat_host::MockProvider,
        hold: Arc<AtomicBool>,
    }
    impl Provider for HeldMock {
        fn name(&self) -> &str {
            self.inner.name()
        }
        fn start_turn(&mut self, turn: TurnId, request: &RawJson) -> Result<(), ProviderError> {
            self.inner.start_turn(turn, request)
        }
        fn interrupt(&mut self, chat: &str, turn: TurnId) -> Result<(), ProviderError> {
            self.inner.interrupt(chat, turn)
        }
        fn respond_permission(
            &mut self,
            chat: &str,
            turn: TurnId,
            answer: AnswerId,
            request: &str,
            decision: &str,
        ) -> Result<(), ProviderError> {
            self.inner
                .respond_permission(chat, turn, answer, request, decision)
        }
        fn answer_question(
            &mut self,
            chat: &str,
            turn: TurnId,
            answer: AnswerId,
            request: &str,
            answers: &RawJson,
        ) -> Result<(), ProviderError> {
            self.inner
                .answer_question(chat, turn, answer, request, answers)
        }
        fn close_chat(&mut self, chat: &str, turn: TurnId) -> Result<(), ProviderError> {
            self.inner.close_chat(chat, turn)
        }
        fn shutdown(&mut self) {
            self.inner.shutdown();
        }
        fn take_events(&mut self) -> Vec<ProviderEvent> {
            if self.hold.load(Ordering::Acquire) {
                vec![]
            } else {
                self.inner.take_events()
            }
        }
    }
    #[test]
    fn periodic_readiness_loss_parks_stream_answer_and_end_until_node_explicitly_reopens() {
        use milagre_owner_store::chat_host::MockProvider;
        let (profile, project, mut host) = seeded();
        let store = profile.path().join(".owner/handovers");
        let provider = MockProvider::new("kiro");
        let hold = Arc::new(AtomicBool::new(false));
        host.register(Box::new(HeldMock {
            inner: provider.clone(),
            hold: hold.clone(),
        }));
        let (server, actor) = running(profile, &project, host, Default::default());
        let mut child = ChildGuard(
            Command::new("node")
                .arg(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/tests/readiness-stream-compat.cjs"
                ))
                .arg(server.profile_path())
                .arg(&project)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let (lines, receive) = mpsc::sync_channel(8);
        let stdout = child.0.stdout.take().unwrap();
        let reader = thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if lines.send(line.unwrap()).is_err() {
                    break;
                }
            }
        });
        assert_eq!(child.line(&receive), "sent");
        let chat = format!("{}#2", project.display());
        let turn = provider.current(&chat).unwrap();
        provider.emit(&chat, json!({"type":"message-sent"}));
        provider.emit(&chat, json!({"type":"text-delta","text":"before "}));
        provider.emit(&chat,json!({"type":"permission-request","requestId":"held","kind":"command","tool":"Shell","title":"Allow fixture?","command":"true","allowForChat":false}));
        child
            .0
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"stream\n")
            .unwrap();
        assert_eq!(child.line(&receive), "streaming");
        hold.store(true, Ordering::Release);
        child
            .0
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"answer\n")
            .unwrap();
        assert_eq!(child.line(&receive), "answer-pending");
        until("answer accepted by fixture", || {
            provider.state.lock().unwrap().answers.len() == 1
        });
        lose_readiness(&store, &actor); // only the periodic check can detect this fault
        let watermark = actor.shared.snapshot.lock().unwrap()["runs"]["seq"]
            .as_u64()
            .unwrap();
        let saved_before = [
            fs::read(project.join(".milagre/coordination.json")).unwrap(),
            fs::read(project.join(".milagre/chats.db")).unwrap(),
        ];
        provider.emit(&chat, json!({"type":"text-delta","text":"partial"}));
        provider.emit(&chat, json!({"type":"turn-completed"}));
        provider.push(ProviderEvent::Exited {
            chat: chat.clone(),
            turn,
            error: ProviderError::new(ProviderErrorKind::Exited, "Fixed fixture exited"),
        });
        hold.store(false, Ordering::Release);
        until("four parked provider events", || {
            actor.shared.parked_events.load(Ordering::Acquire) == 4
        });
        let ticks = actor.shared.observed_ticks.load(Ordering::Acquire);
        until("held provider ticks", || {
            actor.shared.observed_ticks.load(Ordering::Acquire) >= ticks + 2
        });
        assert_eq!(
            actor.shared.snapshot.lock().unwrap()["runs"]["seq"],
            watermark
        );
        assert_eq!(
            saved_before,
            [
                fs::read(project.join(".milagre/coordination.json")).unwrap(),
                fs::read(project.join(".milagre/chats.db")).unwrap()
            ],
            "not-ready clock/events write no Project state"
        );
        child
            .0
            .stdin
            .as_mut()
            .unwrap()
            .write_all(format!("hidden {watermark}\n").as_bytes())
            .unwrap();
        assert_eq!(child.line(&receive), "held");
        assert_eq!(actor.shared.parked_events.load(Ordering::Acquire), 4);
        child
            .0
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"reopen\n")
            .unwrap();
        assert_eq!(child.line(&receive), "completed");
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(5));
        }
        reader.join().unwrap();
        assert_eq!(
            provider.state.lock().unwrap().turns.len(),
            1,
            "reopen and resend never execute another turn"
        );
        assert_eq!(provider.state.lock().unwrap().answers.len(), 1);
        assert_eq!(actor.shared.parked_events.load(Ordering::Acquire), 0);
        assert_eq!(
            *actor.shared.observed_quit.lock().unwrap(),
            Some(QuitState::Done)
        );
        assert!(server.is_stopped());
        drop(actor);
        Server::finish(server).unwrap();
    }
    #[test]
    fn retained_completion_precedes_parked_exit_after_repeated_retry_failure_and_starts_queue_once()
    {
        use milagre_owner_store::chat_host::MockProvider;
        let (profile, project, mut host) = seeded();
        let store = profile.path().join(".owner/handovers");
        let provider = MockProvider::new("kiro");
        host.register(Box::new(provider.clone()));
        let (server, actor) = running(profile, &project, host, Default::default());
        let mut child = ChildGuard(
            Command::new("node")
                .arg(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/tests/retained-completion-compat.cjs"
                ))
                .arg(server.profile_path())
                .arg(&project)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let (lines, receive) = mpsc::sync_channel(8);
        let stdout = child.0.stdout.take().unwrap();
        let reader = thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if lines.send(line.unwrap()).is_err() {
                    break;
                }
            }
        });
        assert_eq!(child.line(&receive), "sent");
        let chat = format!("{}#2", project.display());
        let first = provider.current(&chat).unwrap();
        provider.emit(
            &chat,
            json!({"type":"session-started","nativeId":"fixed-resumable-mock"}),
        );
        provider.emit(&chat, json!({"type":"message-sent"}));
        provider.emit(
            &chat,
            json!({"type":"text-delta","text":"Retained first reply"}),
        );
        child
            .0
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"stream\n")
            .unwrap();
        assert_eq!(child.line(&receive), "queued");
        actor.shared.fail_commits.store(true, Ordering::Release);
        provider.emit(&chat, json!({"type":"turn-completed"}));
        until("retained completion", || {
            actor.shared.stuck_ends.load(Ordering::Acquire) == 1
        });
        lose_readiness(&store, &actor);
        let exited = || ProviderEvent::Exited {
            chat: chat.clone(),
            turn: first,
            error: ProviderError::new(ProviderErrorKind::Exited, "Fixed old process exited"),
        };
        provider.push(exited());
        until("parked old exit", || {
            actor.shared.parked_events.load(Ordering::Acquire) == 1
        });
        child
            .0
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"hidden\n")
            .unwrap();
        assert_eq!(child.line(&receive), "retry-held");
        assert_eq!(actor.shared.stuck_ends.load(Ordering::Acquire), 1);
        provider.push(exited()); // a newer arrival must stay behind the retained terminal too
        until("two old exits held", || {
            actor.shared.parked_events.load(Ordering::Acquire) == 2
        });
        let attempts = actor.shared.injected_commits.load(Ordering::Acquire);
        until("repeated retained-end fold failures", || {
            actor.shared.injected_commits.load(Ordering::Acquire) >= attempts + 2
        });
        assert_eq!(actor.shared.stuck_ends.load(Ordering::Acquire), 1);
        assert_eq!(actor.shared.parked_events.load(Ordering::Acquire), 2);
        assert_eq!(provider.state.lock().unwrap().turns.len(), 1);
        actor.shared.fail_commits.store(false, Ordering::Release);
        child
            .0
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"release\n")
            .unwrap();
        assert_eq!(child.line(&receive), "successor");
        assert_eq!(provider.state.lock().unwrap().turns.len(), 2);
        assert_eq!(
            provider.state.lock().unwrap().turns[1]["prompt"],
            "Queued successor prompt"
        );
        assert_ne!(provider.current(&chat).unwrap(), first);
        assert_eq!(actor.shared.stuck_ends.load(Ordering::Acquire), 0);
        assert_eq!(actor.shared.parked_events.load(Ordering::Acquire), 0);
        provider.emit(&chat, json!({"type":"message-sent"}));
        provider.emit(&chat, json!({"type":"text-delta","text":"Queued reply"}));
        provider.emit(&chat, json!({"type":"turn-completed"}));
        child
            .0
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"finish\n")
            .unwrap();
        assert_eq!(child.line(&receive), "completed");
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(5));
        }
        reader.join().unwrap();
        assert_eq!(provider.state.lock().unwrap().turns.len(), 2);
        assert_eq!(
            *actor.shared.observed_quit.lock().unwrap(),
            Some(QuitState::Done)
        );
        drop(actor);
        Server::finish(server).unwrap();
    }
}
