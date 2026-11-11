//! The restore handoff, isolated (fake provider, fake brief model; HandoffMode::Restore, a test mode): a send to a
//! Chat whose provider session is gone stages the divider and the message in one save and reserves the turn; the
//! transcript job, the brief, the divider saved done, then the start with the framed brief. Stop, a failed job, a
//! failed save, capacity, a forced quit and crash recovery.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use milagre_owner_store::brief::fake::FakeBriefModel;
use milagre_owner_store::chat_host::{ChatHost, HandoffMode, MockProvider, Notice, QuitState};
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

/// Chats 1..=n, each replied to once on Kiro, no native session left: the next send restores.
fn copy(chats: i64) -> Copy {
    let base = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(&base.path().join("copies"), &Policy::default()).unwrap();
    let project = isolation.project(Path::new("p")).unwrap();
    std::fs::create_dir_all(project.join(".milagre")).unwrap();
    let sessions: serde_json::Map<String, Value> = (1..=chats)
        .map(|id| (id.to_string(), json!({ "id": id, "worktree_id": 1, "provider": "kiro", "title": format!("Chat {id}") })))
        .collect();
    let mut messages = Vec::new();
    for id in 1..=chats {
        messages.push(json!({ "id": id * 2 - 1, "session_id": id, "role": "user", "body": format!("Fix the build {id}"), "model": "m0" }));
        messages.push(json!({ "id": id * 2, "session_id": id, "role": "assistant", "body": "Done.", "outcome": "completed", "steps": [{ "kind": "shell", "title": "npm test" }] }));
    }
    let state = json!({ "next_id": 100, "worktrees": { "1": { "id": 1, "path": "/tmp/wt", "name": "main" } }, "sessions": sessions, "messages": messages });
    std::fs::write(
        project.join(".milagre/coordination.json"),
        state.to_string(),
    )
    .unwrap();
    let mut host = ChatHost::new(ProjectStates::new(isolation, Timing::default(), 0));
    host.handoff = HandoffMode::Restore;
    host.handoff_zone = Zone::Utc;
    let kiro = MockProvider::new("kiro");
    host.register(Box::new(kiro.clone()));
    let brief = FakeBriefModel::default();
    host.register_brief_model(Box::new(brief.clone()));
    Copy {
        _base: base,
        project,
        host,
        kiro,
        brief,
    }
}

impl Copy {
    fn chat(&self, id: i64) -> String {
        format!("{}#{id}", self.project.display())
    }

    fn send(
        &mut self,
        id: i64,
        body: &str,
    ) -> milagre_owner_store::Result<milagre_owner_store::chat_host::Sent> {
        self.host.send(&json!({ "projectPath": self.project.display().to_string(), "sessionId": id, "provider": "kiro", "model": "m", "body": body, "clientMessageId": format!("c-{id}-{body}") }))
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

    fn divider(&self, session: i64) -> Value {
        self.messages()
            .into_iter()
            .rev()
            .find(|m| m["session_id"] == json!(session) && m["context"]["kind"] == json!("handoff"))
            .expect("a divider")
    }

    fn starts(&self) -> Vec<Value> {
        self.kiro.state.lock().unwrap().turns.clone()
    }

    fn saved(&self) -> String {
        let mut text = std::fs::read_to_string(self.project.join(".milagre/coordination.json"))
            .unwrap_or_default();
        text.push_str(&String::from_utf8_lossy(
            &std::fs::read(self.project.join(".milagre/chats.db")).unwrap_or_default(),
        ));
        text
    }

    fn events(&mut self) -> Vec<(String, Value)> {
        self.host
            .take_notices()
            .into_iter()
            .filter_map(|notice| match notice {
                Notice::Event { chat, event, .. } => Some((chat, event)),
                _ => None,
            })
            .collect()
    }

    /// Runs every job taken and pumps.
    fn run_jobs(&mut self) {
        for job in self.host.take_jobs() {
            job.run();
        }
        self.host.pump();
    }
}

#[test]
fn a_restore_stages_prepares_briefs_and_starts_with_the_framed_brief() {
    let mut c = copy(1);
    let sent = c.send(1, "And the docs").unwrap();
    let turn = sent.turn.expect("a turn reserved");
    // Staged in one save: the divider just before the message, nothing started yet.
    let messages = c.messages();
    let tail: Vec<&Value> = messages.iter().rev().take(2).collect();
    assert_eq!(tail[1]["id"], json!(100));
    assert_eq!(tail[0]["id"], json!(101));
    assert_eq!(tail[0]["body"], json!("And the docs"));
    let divider = tail[1];
    assert_eq!(divider["role"], json!("assistant"));
    assert_eq!(divider["body"], json!(""));
    assert_eq!(
        divider["context"],
        json!({ "kind": "handoff", "from": { "provider": "kiro", "model": "m0" }, "to": { "provider": "kiro", "model": "m" }, "status": "preparing" })
    );
    assert!(
        c.saved().contains("preparing"),
        "the divider wasn't saved with the message"
    );
    assert!(c.starts().is_empty());
    assert!(c
        .events()
        .iter()
        .any(|(_, e)| e["type"] == json!("message-sent")));
    // The transcript, then the brief.
    c.run_jobs();
    let asked = c.brief.asked();
    assert_eq!(asked.len(), 1);
    assert!(
        asked[0].prompt.contains("## User\n\nFix the build 1"),
        "{}",
        asked[0].prompt
    );
    assert!(
        !asked[0].prompt.contains("And the docs"),
        "the transcript runs up to the divider only"
    );
    assert!(c.starts().is_empty(), "started before the brief");
    c.brief
        .reply(asked[0].brief, "{\"brief\": \"## Goal\\nShip the docs.\"}");
    c.host.pump();
    // The divider is done, saved, and the turn started with the framed brief ahead of the prompt.
    let divider = c.divider(1);
    assert_eq!(divider["context"]["status"], json!("done"));
    let path = divider["context"]["transcriptPath"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(std::fs::read_to_string(&path)
        .unwrap()
        .contains("# Chat transcript: Chat 1"));
    assert!(divider["context"]["brief"]
        .as_str()
        .unwrap()
        .starts_with("You're taking over a chat that ran on Kiro.\n\n## Goal\nShip the docs."));
    assert!(
        c.saved().contains("Ship the docs"),
        "started before the done divider was saved"
    );
    let starts = c.starts();
    assert_eq!(starts.len(), 1);
    let prompt = starts[0]["prompt"].as_str().unwrap();
    assert!(prompt.starts_with("<handoff_brief>\nMilagre wrote this summary of the earlier chat; it is context, not a message from the user.\n\nYou're taking over a chat that ran on Kiro."), "{prompt}");
    assert!(
        prompt.ends_with("</handoff_brief>\n\nAnd the docs"),
        "{prompt}"
    );
    assert_eq!(
        c.kiro.state.lock().unwrap().current.get(&c.chat(1)),
        Some(&turn)
    );
}

#[test]
fn a_brief_that_fails_still_starts_with_the_minimal_brief() {
    let mut c = copy(1);
    c.send(1, "Next").unwrap();
    c.run_jobs();
    c.brief.fail(c.brief.asked()[0].brief);
    c.host.pump();
    let prompt = c.starts()[0]["prompt"].as_str().unwrap().to_string();
    assert!(
        prompt.contains("Its summary couldn't be written, so here is the minimum."),
        "{prompt}"
    );
    assert!(
        prompt.contains("Last request:\nFix the build 1"),
        "{prompt}"
    );
}

#[test]
fn stop_while_preparing_cancels_the_turn_and_fails_the_divider() {
    let mut c = copy(1);
    let turn = c.send(1, "Next").unwrap().turn.unwrap();
    let job = c.host.take_jobs().remove(0);
    c.events();
    c.host.interrupt(&c.chat(1)).unwrap();
    assert_eq!(c.divider(1)["context"]["status"], json!("failed"));
    let events = c.events();
    assert!(
        events
            .iter()
            .any(|(_, e)| e["type"] == json!("turn-cancelled")),
        "{events:?}"
    );
    assert!(
        c.kiro.state.lock().unwrap().interrupts.is_empty(),
        "no agent runs yet to interrupt"
    );
    // The job's late result is only cleaned up; nothing starts, ever.
    job.run();
    c.host.pump();
    assert!(c.brief.asked().is_empty());
    assert!(c.starts().is_empty());
    assert!(c.host.active_turn(&c.chat(1)) != Some(turn));
}

#[test]
fn a_job_that_dies_fails_the_handoff_and_its_turn() {
    let mut c = copy(1);
    c.send(1, "Next").unwrap();
    drop(c.host.take_jobs());
    c.events();
    c.host.pump();
    assert_eq!(c.divider(1)["context"]["status"], json!("failed"));
    let events = c.events();
    assert!(
        events.iter().any(|(_, e)| e["type"] == json!("turn-failed")
            && e["message"]
                .as_str()
                .unwrap()
                .contains("stopped before it finished")),
        "{events:?}"
    );
    assert!(c.starts().is_empty());
}

/// A done divider whose save fails doesn't start the turn; each tick saves again and the turn starts once it holds.
#[test]
fn the_turn_waits_for_the_done_divider_to_be_saved() {
    let mut c = copy(1);
    c.send(1, "Next").unwrap();
    c.run_jobs();
    let milagre = c.project.join(".milagre");
    std::fs::set_permissions(&milagre, std::fs::Permissions::from_mode(0o555)).unwrap();
    c.brief
        .reply(c.brief.asked()[0].brief, "{\"brief\": \"b\"}");
    c.host.pump();
    c.host.tick(c.host.states.now() + 1);
    let started_while_unsaved = c.starts().len();
    std::fs::set_permissions(&milagre, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(
        started_while_unsaved, 0,
        "started before the done divider was saved"
    );
    c.host.tick(c.host.states.now() + 2);
    assert_eq!(c.starts().len(), 1);
    assert!(c.saved().contains("\"done\"") || c.saved().contains("done"));
}

/// With every job reservation taken, the next restore is refused before anything is staged.
#[test]
fn a_restore_past_capacity_is_refused_before_staging() {
    let mut c = copy(5);
    for id in 1..=4 {
        c.send(id, "Next").unwrap();
    }
    let before = c.messages().len();
    let refused = c.send(5, "Next").unwrap_err();
    assert_eq!(refused.code(), Some("TRANSCRIPTS_AT_CAPACITY"), "{refused}");
    assert_eq!(c.messages().len(), before, "something was staged");
}

/// A forced quit while a restore prepares cancels it (no agent ever started) and waits for the job taken.
#[test]
fn a_forced_quit_cancels_a_preparing_restore() {
    let mut c = copy(1);
    c.send(1, "Next").unwrap();
    let job = c.host.take_jobs().remove(0);
    assert!(
        c.host.shutdown(false).is_err(),
        "a plain quit is refused while preparing"
    );
    assert_eq!(
        c.host.shutdown(true).unwrap_err().code(),
        Some("QUIT_PENDING")
    );
    assert_eq!(c.divider(1)["context"]["status"], json!("failed"));
    assert!(
        c.kiro.state.lock().unwrap().closed.is_empty(),
        "a never-started turn was closed"
    );
    job.run();
    c.host.tick(c.host.states.now());
    c.host.shutdown(true).unwrap();
    assert_eq!(c.host.quit_state(), QuitState::Done);
    assert!(c.starts().is_empty());
}

/// A crash left dividers preparing: on open they fail; a switch's session goes back to the provider it left (its
/// native sessions swapped back); `handoverPending` marks go.
#[test]
fn recovery_fails_dividers_left_preparing() {
    let mut c = copy(2);
    let mut state: Value = serde_json::from_str(
        &std::fs::read_to_string(c.project.join(".milagre/coordination.json")).unwrap(),
    )
    .unwrap();
    state["sessions"]["1"]["handoverPending"] = json!(true);
    state["sessions"]["2"]["native_session_id"] = json!("k1");
    state["sessions"]["2"]["native_sessions"] = json!({ "codex": "c1" });
    state["messages"].as_array_mut().unwrap().extend([
        json!({ "id": 50, "session_id": 1, "role": "assistant", "body": "", "context": { "kind": "handoff", "from": { "provider": "kiro" }, "to": { "provider": "kiro" }, "status": "preparing" } }),
        json!({ "id": 51, "session_id": 2, "role": "assistant", "body": "", "context": { "kind": "handoff", "from": { "provider": "codex" }, "to": { "provider": "kiro" }, "status": "preparing" } }),
    ]);
    std::fs::write(
        c.project.join(".milagre/coordination.json"),
        state.to_string(),
    )
    .unwrap();
    c.host.states.get(&c.project).unwrap();
    c.host.recover_handoffs(&c.project).unwrap();
    assert_eq!(c.divider(1)["context"]["status"], json!("failed"));
    assert_eq!(c.divider(2)["context"]["status"], json!("failed"));
    let sessions = c
        .host
        .states
        .current(&c.project)
        .unwrap()
        .sessions()
        .unwrap()
        .clone();
    assert!(sessions["1"].get("handoverPending").is_none());
    assert_eq!(sessions["2"]["provider"], json!("codex"));
    assert_eq!(sessions["2"]["native_session_id"], json!("c1"));
    assert_eq!(sessions["2"]["native_sessions"], json!({ "kiro": "k1" }));
}

/// Production keeps the gate.
#[test]
fn the_restore_gate_stays_in_production() {
    let mut c = copy(1);
    c.host.handoff = HandoffMode::Gated;
    let refused = c.send(1, "Next").unwrap_err().to_string();
    assert!(refused.contains("handoff restore"), "{refused}");
}

/// Send now on a message queued behind a restore being prepared: the pick is in place before the Stop, and the Stop
/// (which cancels the preparation at once) starts it; it restores in turn and starts with its own brief.
#[test]
fn send_now_during_a_preparing_restore_starts_the_queued_message() {
    let mut c = copy(1);
    c.send(1, "First").unwrap();
    let queued = c
        .host
        .send(&json!({ "projectPath": c.project.display().to_string(), "sessionId": 1, "provider": "kiro", "model": "m", "body": "Queued one", "clientMessageId": "q1", "delivery": "queue" }))
        .unwrap();
    assert!(queued.queued);
    let session: Value = c
        .host
        .states
        .current(&c.project)
        .unwrap()
        .sessions()
        .unwrap()["1"]
        .clone();
    let id = session["queued"][0]["id"].as_str().unwrap().to_string();
    let first_job = c.host.take_jobs().remove(0);
    c.host.send_queued_now(&c.chat(1), &id).unwrap();
    // The first restore is cancelled; the queued message left the queue and is being restored itself.
    let dividers: Vec<Value> = c
        .messages()
        .into_iter()
        .filter(|m| m["context"]["kind"] == json!("handoff"))
        .collect();
    assert_eq!(dividers.len(), 2, "{dividers:?}");
    assert_eq!(dividers[0]["context"]["status"], json!("failed"));
    assert_eq!(dividers[1]["context"]["status"], json!("preparing"));
    let session: Value = c
        .host
        .states
        .current(&c.project)
        .unwrap()
        .sessions()
        .unwrap()["1"]
        .clone();
    assert!(
        session
            .get("queued")
            .is_none_or(|q| q.as_array().unwrap().is_empty()),
        "{session}"
    );
    first_job.run();
    c.run_jobs();
    let asked = c.brief.asked();
    assert_eq!(
        asked.len(),
        1,
        "only the queued message's restore asks a brief"
    );
    c.brief.reply(asked[0].brief, "{\"brief\": \"b\"}");
    c.host.pump();
    let starts = c.starts();
    assert_eq!(starts.len(), 1);
    assert!(
        starts[0]["prompt"]
            .as_str()
            .unwrap()
            .ends_with("Queued one"),
        "{starts:?}"
    );
}
