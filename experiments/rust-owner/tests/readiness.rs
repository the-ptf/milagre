//! A Project loaded here that stops being ready (its root replaced, then put back): provider events are kept in
//! order, bounded, and handled once after an explicit open; nothing is folded, saved or started meanwhile (turn ends
//! kept after a failed fold, deadlines, handoff jobs, briefs and done-divider saves included); an overflow fails
//! closed; a forgotten or never-opened Project drops late events and is never reopened; reads are refused.

use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use milagre_owner_store::brief::fake::FakeBriefModel;
use milagre_owner_store::chat_host::{
    AnswerId, AnswerOutcome, AnswerResult, AnswerTicket, ChatHost, MockProvider, Notice,
    ProviderEvent, QuitState, TurnId, MAX_PARKED_EVENTS, MAX_RELEASED_ERRORS,
};
use milagre_owner_store::handover::Zone;
use milagre_owner_store::isolation::{Isolation, Policy};
use milagre_owner_store::states::{ProjectStates, Timing};
use serde_json::{json, Value};

struct Copy {
    _base: tempfile::TempDir,
    project: PathBuf,
    host: ChatHost,
    kiro: MockProvider,
    brief: FakeBriefModel,
}

/// Chat 1 on Kiro. `replied`: it has a reply and no native session (the next send restores; Restore turned on).
fn copy(replied: bool) -> Copy {
    let base = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(&base.path().join("copies"), &Policy::default()).unwrap();
    let project = isolation.project(Path::new("p")).unwrap();
    std::fs::create_dir_all(project.join(".milagre")).unwrap();
    let messages = if replied {
        json!([
            { "id": 1, "session_id": 1, "role": "user", "body": "Fix the build", "model": "m0" },
            { "id": 2, "session_id": 1, "role": "assistant", "body": "Done.", "outcome": "completed" },
        ])
    } else {
        json!([])
    };
    let state = json!({ "next_id": 100, "worktrees": { "1": { "id": 1, "path": "/tmp/wt", "name": "main" } },
        "sessions": { "1": { "id": 1, "worktree_id": 1, "provider": "kiro", "title": "Chat 1" } }, "messages": messages });
    std::fs::write(
        project.join(".milagre/coordination.json"),
        state.to_string(),
    )
    .unwrap();
    let mut host = ChatHost::new(ProjectStates::new(isolation, Timing::default(), 0));
    if replied {
        host.enable_restore_for_tests().unwrap();
    }
    host.handoff_zone = Zone::Utc;
    let kiro = MockProvider::new("kiro");
    host.register(Box::new(kiro.clone()));
    let brief = FakeBriefModel::default();
    host.register_brief_model(Box::new(brief.clone()));
    host.open_project(&project).unwrap();
    host.take_notices();
    Copy {
        _base: base,
        project,
        host,
        kiro,
        brief,
    }
}

impl Copy {
    fn chat(&self) -> String {
        format!("{}#1", self.project.display())
    }

    fn send(
        &mut self,
        body: &str,
    ) -> milagre_owner_store::Result<milagre_owner_store::chat_host::Sent> {
        self.host.send(&json!({ "projectPath": self.project.display().to_string(), "sessionId": 1, "provider": "kiro", "model": "m", "body": body, "clientMessageId": format!("c-{body}") }))
    }

    fn starts(&self) -> usize {
        self.kiro.state.lock().unwrap().turns.len()
    }

    fn messages(&self) -> Vec<Value> {
        self.host
            .states
            .current(&self.project)
            .map(|state| {
                state
                    .message_list()
                    .iter()
                    .map(|m| m.value().clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn divider(&self) -> Value {
        self.messages()
            .into_iter()
            .rev()
            .find(|m| m["context"]["kind"] == json!("handoff"))
            .expect("a divider")
    }

    /// What is on disk for the Project (wherever its folder is now).
    fn saved_at(dir: &Path) -> Vec<u8> {
        let mut bytes = std::fs::read(dir.join(".milagre/coordination.json")).unwrap_or_default();
        bytes.extend(std::fs::read(dir.join(".milagre/chats.db")).unwrap_or_default());
        bytes
    }

    /// The Project's folder moved away and a link put in its place: the readiness check fails. Returns where it went.
    fn replace_root(&mut self) -> PathBuf {
        let moved = self.project.with_file_name("p-moved");
        std::fs::rename(&self.project, &moved).unwrap();
        symlink(&moved, &self.project).unwrap();
        assert!(self.host.require_project_ready(&self.project).is_err());
        assert!(!self.host.is_project_ready(&self.project));
        moved
    }

    fn restore_root(&self, moved: &Path) {
        std::fs::remove_file(&self.project).unwrap();
        std::fs::rename(moved, &self.project).unwrap();
    }

    /// Readiness lost, and the folder put back at once: only an explicit open makes it ready again.
    fn lose_readiness(&mut self) {
        let moved = self.replace_root();
        self.restore_root(&moved);
        assert!(!self.host.is_project_ready(&self.project));
    }

    fn ask(&mut self, request: &str) {
        let chat = self.chat();
        self.kiro.emit(
            &chat,
            json!({ "type": "question-request", "requestId": request, "questions": [{ "id": "c", "header": "C", "question": "Which?", "options": [] }] }),
        );
        assert!(self.host.pump().is_empty());
    }

    fn answer(&mut self, request: &str) -> AnswerId {
        self.kiro.state.lock().unwrap().hold_answers = true;
        let request = json!({ "chatId": self.chat(), "requestId": request, "answers": { "c": ["Red"] }, "summary": "Red" });
        match self.host.answer_question(&request).unwrap() {
            AnswerTicket::Pending(id) => id,
            other => panic!("settled at once: {other:?}"),
        }
    }

    fn settlements(notices: &[Notice], answer: AnswerId) -> Vec<AnswerResult> {
        notices
            .iter()
            .filter_map(|notice| match notice {
                Notice::AnswerSettled {
                    answer: settled,
                    result,
                    ..
                } if *settled == answer => Some(result.clone()),
                _ => None,
            })
            .collect()
    }

    fn turn_ends(notices: &[Notice]) -> usize {
        notices
            .iter()
            .filter(|notice| matches!(notice, Notice::Event { event, .. } if ["turn-completed", "turn-failed", "turn-cancelled"].contains(&event["type"].as_str().unwrap_or(""))))
            .count()
    }
}

/// Readiness lost mid-turn: the reply, the turn end, the session's exit and the answer's receipt are kept in order
/// (nothing folded, saved, settled or published, also past every deadline); with the root back, an explicit open
/// handles them once: the turn ends once, the answer settles once as the agent said, and a later pump adds nothing.
#[test]
fn events_kept_while_not_ready_settle_exactly_once_after_an_explicit_open() {
    let mut c = copy(false);
    c.send("one").unwrap();
    assert!(c.host.pump().is_empty());
    c.ask("q1");
    let answer = c.answer("q1");
    let turn = c.kiro.current(&c.chat()).unwrap();
    // Stop asked: its deadline passes while not ready, and nothing is forced.
    c.host.interrupt(&c.chat()).unwrap();
    // A debounced save is left pending: the clock must not write it while not ready.
    let chat = c.chat();
    c.kiro
        .emit(&chat, json!({ "type": "text-delta", "text": "before " }));
    assert!(c.host.pump().is_empty());
    c.host.take_notices();
    let moved = c.replace_root();
    let before = Copy::saved_at(&moved);
    c.kiro
        .emit(&chat, json!({ "type": "text-delta", "text": "partial" }));
    c.kiro.push(ProviderEvent::AnswerSettled {
        chat: chat.clone(),
        answer,
        outcome: AnswerOutcome::Accepted,
    });
    c.kiro.emit(&chat, json!({ "type": "turn-completed" }));
    c.kiro.push(ProviderEvent::Exited {
        chat: chat.clone(),
        turn,
        error: milagre_owner_store::chat_host::ProviderError::new(
            milagre_owner_store::chat_host::ProviderErrorKind::Exited,
            "bye",
        ),
    });
    assert!(c.host.pump().is_empty(), "a kept event was refused");
    assert_eq!(c.host.parked_for_tests().0, 4);
    // Past the answer's and an interrupt's deadline: nothing settles or is forced while not ready.
    let now = c.host.states.now();
    c.host
        .tick(now + c.host.answer_grace_ms + c.host.interrupt_grace_ms + 1);
    assert!(c.host.is_busy(&chat), "the turn ended while not ready");
    assert_eq!(c.host.answers_in_flight(), 1);
    let notices = c.host.take_notices();
    assert!(Copy::settlements(&notices, answer).is_empty());
    assert_eq!(Copy::turn_ends(&notices), 0);
    assert!(
        notices
            .iter()
            .all(|n| !matches!(n, Notice::Broadcast { .. })),
        "{notices:?}"
    );
    assert!(
        Copy::saved_at(&moved) == before,
        "something was saved while not ready"
    );
    // A repeat open on the untrusted root fails and releases nothing.
    assert!(c.host.open_project(&c.project).is_err());
    assert_eq!(c.host.parked_for_tests().0, 4);
    c.restore_root(&moved);
    c.host.open_project(&c.project).unwrap();
    assert_eq!(c.host.parked_for_tests(), (0, 0));
    let mut notices = c.host.take_notices();
    let errors = c.host.pump();
    assert!(errors.is_empty(), "{errors:?}");
    notices.extend(c.host.take_notices());
    assert!(!c.host.is_busy(&chat));
    assert_eq!(Copy::turn_ends(&notices), 1);
    assert_eq!(
        Copy::settlements(&notices, answer),
        vec![AnswerResult::Accepted]
    );
    assert_eq!(c.host.answers_in_flight(), 0);
    let reply = c
        .messages()
        .into_iter()
        .rev()
        .find(|m| m["role"] == json!("assistant"))
        .unwrap();
    assert_eq!(reply["body"], json!("before partial"));
    // Nothing more: a later pump and tick handle nothing again.
    assert!(c.host.pump().is_empty());
    c.host.tick(c.host.states.now() + 1);
    let later = c.host.take_notices();
    assert_eq!(Copy::turn_ends(&later), 0);
    assert!(Copy::settlements(&later, answer).is_empty());
}

/// Past the budget a not-ready Project fails closed: what was kept is dropped (nothing replayed), the running
/// session is closed at once, later events are dropped, and after an explicit open the turn ends once and its answer
/// settles once (`Uncertain`, its message kept).
#[test]
fn an_overflow_fails_closed_and_ends_the_turn_once_after_open() {
    for by_bytes in [false, true] {
        let mut c = copy(false);
        c.send("one").unwrap();
        assert!(c.host.pump().is_empty());
        c.ask("q1");
        let answer = c.answer("q1");
        c.lose_readiness();
        c.host.take_notices();
        let chat = c.chat();
        let delta =
            |index: usize| json!({ "type": "text-delta", "text": format!("kept {index} ") });
        // Three same-size events fill the budget exactly (by count, or by their measured bytes).
        c.host
            .set_parked_budget_for_tests(if by_bytes { usize::MAX } else { 3 }, usize::MAX);
        c.kiro.emit(&chat, delta(0));
        assert!(c.host.pump().is_empty());
        let (_, one) = c.host.parked_for_tests();
        if by_bytes {
            c.host.set_parked_budget_for_tests(usize::MAX, 3 * one);
        }
        for index in 1..3 {
            c.kiro.emit(&chat, delta(index));
        }
        assert!(c.host.pump().is_empty());
        assert_eq!(
            c.host.parked_for_tests(),
            (3, 3 * one),
            "by_bytes {by_bytes}"
        );
        c.kiro.emit(&chat, delta(3));
        let refused = c.host.pump();
        assert_eq!(refused.len(), 1, "{refused:?}");
        assert_eq!(
            c.host.parked_for_tests(),
            (0, 0),
            "kept events weren't dropped"
        );
        assert!(
            c.kiro.state.lock().unwrap().closed.contains(&chat),
            "the session wasn't closed at once"
        );
        c.kiro.emit(&chat, json!({ "type": "turn-completed" }));
        assert_eq!(c.host.pump()[0].code(), Some("PROJECT_NOT_READY"));
        assert_eq!(c.host.parked_for_tests(), (0, 0));
        assert!(c.host.is_busy(&chat));
        c.host.open_project(&c.project).unwrap();
        let mut notices = c.host.take_notices();
        assert!(c.host.pump().is_empty());
        notices.extend(c.host.take_notices());
        assert!(!c.host.is_busy(&chat));
        assert_eq!(Copy::turn_ends(&notices), 1, "by_bytes {by_bytes}");
        assert!(matches!(
            Copy::settlements(&notices, answer).as_slice(),
            [AnswerResult::Uncertain(_)]
        ));
        let reply = c
            .messages()
            .into_iter()
            .rev()
            .find(|m| m["role"] == json!("assistant"))
            .unwrap();
        assert!(
            !reply["body"].as_str().unwrap_or("").contains("kept"),
            "a dropped event was replayed"
        );
        assert!(
            c.messages().iter().any(|m| m["body"] == json!("Red")),
            "the answer's message was taken back"
        );
    }
}

/// A forgotten Project, or one never opened: a late event is refused and dropped, nothing kept, nothing loaded or
/// reopened. Reads of a Project that isn't ready are refused; after a completed quit nothing is ready.
#[test]
fn late_events_of_a_forgotten_project_are_dropped_and_reads_are_gated() {
    let mut c = copy(false);
    c.send("one").unwrap();
    assert!(c.host.pump().is_empty());
    let chat = c.chat();
    let turn = c.kiro.current(&chat).unwrap();
    let path = c.project.display().to_string();
    c.lose_readiness();
    let read = c.host.call("chat:messages", &[json!(path), json!(1)]);
    assert_eq!(read.unwrap_err().code(), Some("PROJECT_NOT_READY"));
    // The public fold refuses too, folding nothing.
    let folded = c
        .host
        .receive(&chat, turn, &json!({ "type": "text-delta", "text": "x" }));
    assert_eq!(folded.unwrap_err().code(), Some("PROJECT_NOT_READY"));
    c.host.forget(&c.project, true).unwrap();
    assert!(!c.host.states.has(&c.project));
    c.kiro.push(ProviderEvent::Agent {
        chat: chat.clone(),
        turn,
        event: milagre_owner_store::jsjson::RawJson(
            json!({ "type": "text-delta", "text": "late" }),
        ),
    });
    let errors = c.host.pump();
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].code(), Some("PROJECT_NOT_READY"));
    assert_eq!(c.host.parked_for_tests(), (0, 0));
    assert!(!c.host.states.has(&c.project), "a late event reopened it");
    // Never opened: the same.
    c.kiro.push(ProviderEvent::Agent {
        chat: "/nowhere/p#1".into(),
        turn: TurnId(1),
        event: milagre_owner_store::jsjson::RawJson(json!({ "type": "text-delta", "text": "x" })),
    });
    assert_eq!(c.host.pump().len(), 1);
    assert_eq!(c.host.parked_for_tests(), (0, 0));
    // Reopened explicitly, read, then quit: nothing ready after.
    c.host.open_project(&c.project).unwrap();
    assert!(c
        .host
        .call("chat:messages", &[json!(path), json!(1)])
        .is_ok());
    c.host.shutdown(true).unwrap();
    assert!(!c.host.is_project_ready(&c.project));
}

/// A turn end kept after its fold failed is not folded while the Project isn't ready (`retry_stuck`, `pump` and
/// `tick` all leave it); after an explicit open it folds once.
#[test]
fn a_kept_turn_end_waits_for_an_explicit_open() {
    let mut c = copy(false);
    c.send("one").unwrap();
    assert!(c.host.pump().is_empty());
    let chat = c.chat();
    c.host.states.fail_next_commit("injected");
    c.kiro.emit(&chat, json!({ "type": "turn-completed" }));
    assert_eq!(c.host.pump().len(), 1);
    assert_eq!(c.host.stuck_ends(), vec![chat.clone()]);
    c.lose_readiness();
    c.host.take_notices();
    assert!(c.host.retry_stuck().is_empty());
    assert!(c.host.pump().is_empty());
    c.host.tick(c.host.states.now() + 1);
    assert_eq!(
        c.host.stuck_ends(),
        vec![chat.clone()],
        "the kept end was dropped"
    );
    assert!(c.host.is_busy(&chat), "the kept end folded while not ready");
    assert_eq!(Copy::turn_ends(&c.host.take_notices()), 0);
    c.host.open_project(&c.project).unwrap();
    assert!(c.host.pump().is_empty());
    assert!(c.host.stuck_ends().is_empty());
    assert!(!c.host.is_busy(&chat));
    assert_eq!(Copy::turn_ends(&c.host.take_notices()), 1);
}

/// Readiness lost while a restore waits on its transcript job, on its brief, or on saving its done divider: nothing
/// is committed, settled, saved or started (also over many ticks) until an explicit open; then it goes on and the
/// turn starts once.
#[test]
fn a_restore_waiting_on_job_brief_or_save_resumes_only_after_an_explicit_open() {
    for phase in ["job", "brief", "save"] {
        let mut c = copy(true);
        c.send("Next").unwrap();
        assert_eq!(
            c.divider()["context"]["status"],
            json!("preparing"),
            "{phase}"
        );
        let milagre = c.project.join(".milagre");
        match phase {
            "job" => {
                c.lose_readiness();
                for job in c.host.take_jobs() {
                    job.run();
                }
            }
            "brief" => {
                for job in c.host.take_jobs() {
                    job.run();
                }
                c.host.pump();
                assert_eq!(c.brief.asked().len(), 1);
                c.lose_readiness();
                c.brief
                    .reply(c.brief.asked()[0].brief, "{\"brief\": \"b\"}");
            }
            _ => {
                use std::os::unix::fs::PermissionsExt;
                for job in c.host.take_jobs() {
                    job.run();
                }
                c.host.pump();
                std::fs::set_permissions(&milagre, std::fs::Permissions::from_mode(0o555)).unwrap();
                c.brief
                    .reply(c.brief.asked()[0].brief, "{\"brief\": \"b\"}");
                c.host.pump();
                assert_eq!(c.divider()["context"]["status"], json!("done"));
                std::fs::set_permissions(&milagre, std::fs::Permissions::from_mode(0o755)).unwrap();
                c.lose_readiness();
            }
        }
        for step in 1..=5 {
            c.host.pump();
            c.host.tick(c.host.states.now() + step);
        }
        assert_eq!(c.starts(), 0, "{phase}: started while not ready");
        match phase {
            "job" => {
                assert!(
                    c.brief.asked().is_empty(),
                    "job: the transcript was committed while not ready"
                );
                assert_eq!(c.divider()["context"]["status"], json!("preparing"));
            }
            "brief" => {
                assert_eq!(c.divider()["context"]["status"], json!("preparing"));
                // Stop would fail the divider: refused while not ready, nothing written.
                let stop = c.host.interrupt(&c.chat());
                assert_eq!(stop.unwrap_err().code(), Some("PROJECT_NOT_READY"));
                assert_eq!(c.divider()["context"]["status"], json!("preparing"));
            }
            _ => {}
        }
        c.host.open_project(&c.project).unwrap();
        if phase == "job" {
            assert_eq!(
                c.brief.asked().len(),
                1,
                "job: not committed after the open"
            );
            c.brief
                .reply(c.brief.asked()[0].brief, "{\"brief\": \"b\"}");
        }
        for step in 1..=3 {
            c.host.pump();
            c.host.tick(c.host.states.now() + step);
        }
        assert_eq!(c.starts(), 1, "{phase}");
        assert_eq!(c.divider()["context"]["status"], json!("done"), "{phase}");
    }
}

/// A held transcript of a not-ready Project is still cleaned up once its handoff stops (a forced quit): the quit
/// completes with no job out.
#[test]
fn a_held_transcript_is_cleaned_up_when_its_handoff_stops() {
    let mut c = copy(true);
    c.send("Next").unwrap();
    c.lose_readiness();
    for job in c.host.take_jobs() {
        job.run();
    }
    c.host.pump();
    assert_eq!(c.host.quit_state(), QuitState::Running);
    c.host.shutdown(true).unwrap();
    assert!(c.brief.asked().is_empty());
    assert_eq!(c.starts(), 0);
    assert!(!c.host.is_project_ready(&c.project));
}

/// A debounced save left pending when readiness is lost isn't written by the clock while the Project isn't ready,
/// even with its root back; the explicit open writes it.
#[test]
fn the_clock_writes_nothing_while_not_ready() {
    let mut c = copy(false);
    c.send("one").unwrap();
    assert!(c.host.pump().is_empty());
    c.host.states.flush(Some(&c.project)).unwrap();
    let chat = c.chat();
    c.kiro.emit(
        &chat,
        json!({ "type": "session-started", "nativeId": "native-xyz" }),
    );
    assert!(c.host.pump().is_empty());
    c.lose_readiness();
    let before = Copy::saved_at(&c.project);
    assert!(
        !String::from_utf8_lossy(&before).contains("native-xyz"),
        "saved at once"
    );
    c.host.tick(c.host.states.now() + 60_000);
    assert!(
        Copy::saved_at(&c.project) == before,
        "the clock saved a not-ready Project"
    );
    c.host.open_project(&c.project).unwrap();
    assert!(String::from_utf8_lossy(&Copy::saved_at(&c.project)).contains("native-xyz"));
}

/// A transcript job that fails (here dropped unrun: it reports `Unknown`) while the Project isn't ready: nothing is
/// written, told or started and the turn stays reserved; after an explicit open the divider fails and the turn ends,
/// once, and nothing starts.
#[test]
fn a_transcript_job_failing_while_not_ready_takes_effect_only_after_open() {
    let mut c = copy(true);
    c.send("Next").unwrap();
    let chat = c.chat();
    c.lose_readiness();
    let before = Copy::saved_at(&c.project);
    c.host.take_notices();
    drop(c.host.take_jobs());
    for step in 1..=5 {
        c.host.pump();
        c.host.tick(c.host.states.now() + step);
    }
    assert!(
        Copy::saved_at(&c.project) == before,
        "written while not ready"
    );
    assert_eq!(c.divider()["context"]["status"], json!("preparing"));
    assert!(c.host.is_busy(&chat));
    let notices = c.host.take_notices();
    assert!(
        notices
            .iter()
            .all(|n| !matches!(n, Notice::Failed { .. }) && !matches!(n, Notice::Broadcast { .. })),
        "{notices:?}"
    );
    assert_eq!(Copy::turn_ends(&notices), 0);
    c.host.open_project(&c.project).unwrap();
    c.host.pump();
    let notices = c.host.take_notices();
    assert_eq!(c.divider()["context"]["status"], json!("failed"));
    assert!(!c.host.is_busy(&chat));
    assert_eq!(Copy::turn_ends(&notices), 1);
    assert_eq!(c.starts(), 0);
    c.host.tick(c.host.states.now() + 60_000);
    assert!(String::from_utf8_lossy(&Copy::saved_at(&c.project)).contains("\"failed\""));
}

/// Recovery's change kept in memory while the open's final save failed: the next open (which recovers nothing new)
/// still saves it and publishes it once.
#[test]
fn a_recovery_whose_save_failed_is_published_by_the_open_that_succeeds() {
    use std::os::unix::fs::PermissionsExt;
    let base = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(&base.path().join("copies"), &Policy::default()).unwrap();
    let project = isolation.project(Path::new("p")).unwrap();
    let milagre = project.join(".milagre");
    std::fs::create_dir_all(&milagre).unwrap();
    let state = json!({ "next_id": 10, "worktrees": { "1": { "id": 1, "path": "/tmp/wt" } },
        "sessions": { "1": { "id": 1, "worktree_id": 1, "provider": "kiro" } },
        "messages": [
            { "id": 1, "session_id": 1, "role": "user", "body": "hi" },
            { "id": 2, "session_id": 1, "role": "assistant", "body": "", "context": { "kind": "handoff", "from": { "provider": "kiro" }, "to": { "provider": "kiro" }, "status": "preparing" } },
        ] });
    std::fs::write(milagre.join("coordination.json"), state.to_string()).unwrap();
    let mut host = ChatHost::new(ProjectStates::new(isolation, Timing::default(), 0));
    // Loaded and locked first (another owner's handover store refuses the first open, after loading).
    let other_isolation = Isolation::open(project.parent().unwrap(), &Policy::default()).unwrap();
    let other = milagre_owner_store::transcripts::TranscriptJobs::new(&other_isolation).unwrap();
    assert_eq!(
        host.open_project(&project).unwrap_err().code(),
        Some("HANDOVER_STORE_BUSY")
    );
    drop(other);
    // Recovery's update succeeds in memory; the final save can't write.
    std::fs::set_permissions(&milagre, std::fs::Permissions::from_mode(0o555)).unwrap();
    let failed = host.open_project(&project);
    std::fs::set_permissions(&milagre, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(failed.is_err(), "the save didn't fail");
    assert!(!host.is_project_ready(&project));
    let saved = std::fs::read_to_string(milagre.join("coordination.json")).unwrap()
        + &String::from_utf8_lossy(&std::fs::read(milagre.join("chats.db")).unwrap_or_default());
    assert!(!saved.contains("\"failed\""), "saved by the failed open");
    assert!(host
        .take_notices()
        .iter()
        .all(|n| !matches!(n, Notice::Broadcast { .. })));
    host.open_project(&project).unwrap();
    let notices = host.take_notices();
    let ready_at = notices
        .iter()
        .position(|n| matches!(n, Notice::ProjectReady { .. }))
        .unwrap();
    assert_eq!(
        notices[ready_at..]
            .iter()
            .filter(|n| matches!(n, Notice::Broadcast { .. }))
            .count(),
        1,
        "the recovery wasn't published once: {notices:?}"
    );
    let saved = std::fs::read_to_string(milagre.join("coordination.json")).unwrap()
        + &String::from_utf8_lossy(&std::fs::read(milagre.join("chats.db")).unwrap_or_default());
    assert!(saved.contains("\"failed\""), "the recovery wasn't saved");
    host.open_project(&project).unwrap();
    assert!(host
        .take_notices()
        .iter()
        .all(|n| !matches!(n, Notice::Broadcast { .. })));
}

/// The budget is shared, its overflow isolated: one Project overflowing drops only its own events and ends only its
/// own turns; the other's stay kept, in order, and are handled once when it opens.
#[test]
fn an_overflow_in_one_project_leaves_another_projects_events_kept() {
    let base = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(&base.path().join("copies"), &Policy::default()).unwrap();
    let mut projects = Vec::new();
    for name in ["p", "q"] {
        let project = isolation.project(Path::new(name)).unwrap();
        std::fs::create_dir_all(project.join(".milagre")).unwrap();
        let state = json!({ "next_id": 10, "worktrees": { "1": { "id": 1, "path": "/tmp/wt", "name": "main" } },
            "sessions": { "1": { "id": 1, "worktree_id": 1 } }, "messages": [] });
        std::fs::write(
            project.join(".milagre/coordination.json"),
            state.to_string(),
        )
        .unwrap();
        projects.push(project);
    }
    let mut host = ChatHost::new(ProjectStates::new(isolation, Timing::default(), 0));
    let kiro = MockProvider::new("kiro");
    host.register(Box::new(kiro.clone()));
    let chats: Vec<String> = projects
        .iter()
        .map(|p| format!("{}#1", p.display()))
        .collect();
    for project in &projects {
        host.open_project(project).unwrap();
        host.send(&json!({ "projectPath": project.display().to_string(), "sessionId": 1, "provider": "kiro", "model": "m", "body": "go", "clientMessageId": "c1" })).unwrap();
    }
    assert!(host.pump().is_empty());
    for project in &projects {
        let moved = project.with_file_name("moved");
        std::fs::rename(project, &moved).unwrap();
        symlink(&moved, project).unwrap();
        assert!(host.require_project_ready(project).is_err());
        std::fs::remove_file(project).unwrap();
        std::fs::rename(&moved, project).unwrap();
    }
    host.set_parked_budget_for_tests(4, usize::MAX);
    let (p, q) = (&chats[0], &chats[1]);
    let delta = |text: &str| json!({ "type": "text-delta", "text": text });
    for text in ["a0 ", "a1 ", "a2 "] {
        kiro.emit(p, delta(text));
    }
    kiro.emit(q, delta("b0 "));
    assert!(host.pump().is_empty());
    assert_eq!(host.parked_for_tests().0, 4);
    // q's next event doesn't fit: q fails closed, p keeps its three.
    kiro.emit(q, delta("b1 "));
    assert_eq!(host.pump().len(), 1);
    assert_eq!(host.parked_for_tests().0, 3);
    assert!(kiro.state.lock().unwrap().closed.contains(q));
    assert!(!kiro.state.lock().unwrap().closed.contains(p));
    // Room again for p: its fourth fits the shared budget, and more once the budget allows.
    kiro.emit(p, delta("a3 "));
    assert!(host.pump().is_empty());
    assert_eq!(host.parked_for_tests().0, 4);
    host.set_parked_budget_for_tests(MAX_PARKED_EVENTS, usize::MAX);
    kiro.emit(p, json!({ "type": "turn-completed" }));
    assert!(host.pump().is_empty());
    host.open_project(&projects[0]).unwrap();
    assert!(host.pump().is_empty());
    let reply = |host: &ChatHost, project: &Path| {
        host.states
            .current(project)
            .unwrap()
            .message_list()
            .iter()
            .map(|m| m.value().clone())
            .rev()
            .find(|m| m["role"] == json!("assistant"))
            .unwrap()
    };
    assert_eq!(reply(&host, &projects[0])["body"], json!("a0 a1 a2 a3"));
    assert!(!host.is_busy(p));
    assert!(host.is_busy(q), "q's turn ended before q opened");
    host.take_notices();
    host.open_project(&projects[1]).unwrap();
    assert!(host.pump().is_empty());
    assert!(!host.is_busy(q));
    assert_eq!(Copy::turn_ends(&host.take_notices()), 1);
    assert!(
        !reply(&host, &projects[1])["body"]
            .as_str()
            .unwrap_or("")
            .contains("b0"),
        "q's dropped event was replayed"
    );
}

/// Opens that release refused events again and again without a pump keep at most `MAX_RELEASED_ERRORS` of them, the
/// rest counted in one summary error.
#[test]
fn released_refusals_stay_bounded_between_pumps() {
    let mut c = copy(false);
    let chat = c.chat();
    for _ in 0..3 {
        c.lose_readiness();
        for _ in 0..200 {
            c.host
                .deliver(ProviderEvent::Agent {
                    chat: chat.clone(),
                    turn: TurnId(1),
                    event: milagre_owner_store::jsjson::RawJson(
                        json!({ "type": "text-delta", "text": "late" }),
                    ),
                })
                .unwrap();
        }
        c.host.open_project(&c.project).unwrap();
    }
    let errors = c.host.pump();
    assert_eq!(errors.len(), MAX_RELEASED_ERRORS + 1);
    let summary = errors.last().unwrap().to_string();
    assert!(
        summary.contains(&(600 - MAX_RELEASED_ERRORS).to_string()),
        "{summary}"
    );
    assert!(c.host.pump().is_empty());
}

/// The budget counts an estimate of the heap an event holds, not its JSON: a list of 100,000 zeros (about 200 KB as
/// JSON) doesn't fit a 1 MiB budget.
#[test]
fn the_byte_budget_counts_heap_not_json() {
    let mut c = copy(false);
    c.send("one").unwrap();
    assert!(c.host.pump().is_empty());
    c.lose_readiness();
    c.host.set_parked_budget_for_tests(usize::MAX, 1 << 20);
    let chat = c.chat();
    let zeros = vec![0; 100_000];
    assert!(serde_json::to_vec(&zeros).unwrap().len() < 1 << 20);
    c.kiro.emit(
        &chat,
        json!({ "type": "text-delta", "text": "x", "padding": zeros }),
    );
    assert_eq!(c.host.pump().len(), 1, "a heap-heavy event was kept");
    assert_eq!(c.host.parked_for_tests(), (0, 0));
}
