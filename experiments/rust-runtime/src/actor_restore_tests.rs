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
    #[test]
    fn successful_restore_is_saved_before_the_second_acp_process_and_never_replayed() {
        let provider = AcpFixture::create(Scenario::Reply).unwrap();
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
        host.register(Box::new(ObservedProvider {
            inner: provider,
            starts: starts.clone(),
        }));
        let (mut workers, gate, entered) = workers(0);
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
        gate.release();
        child
            .0
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"continue\n")
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
            .contains("Hello"));
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
        assert!(transcript.contains("Hello"));
        assert!(monitor.wait_stopped(Duration::from_secs(3)));
        assert!(!monitor.cleanup_failed());
        assert_eq!(monitor.pids().len(), 2);
        assert_ne!(monitor.pids()[0].1, monitor.pids()[1].1);
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
}
