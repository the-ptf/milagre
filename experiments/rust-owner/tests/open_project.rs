//! `ChatHost::open_project`, the only ready transition, required before any send, queued start, Send now, answer
//! or provider event: a failed recovery save leaves the Project not ready (everything refused, locks kept) until an
//! explicit retry, which saves and tells `ProjectReady` once; a repeat open is a fast check; a replaced root makes a
//! ready Project not ready with no writes or starts; quitting and closing refuse; another owner's handover store
//! refuses with its own code.

use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use milagre_owner_store::chat_host::{ChatHost, MockProvider, Notice, ProviderEvent, TurnId};
use milagre_owner_store::isolation::{Isolation, Policy};
use milagre_owner_store::jsjson::RawJson;
use milagre_owner_store::ownership;
use milagre_owner_store::states::{ProjectStates, Timing};
use serde_json::json;

struct Copy {
    base: tempfile::TempDir,
    project: PathBuf,
    host: ChatHost,
    kiro: MockProvider,
}

/// A Project with a divider left preparing by a crash (recovery has something to save).
fn copy() -> Copy {
    let base = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(&base.path().join("copies"), &Policy::default()).unwrap();
    let project = isolation.project(Path::new("p")).unwrap();
    std::fs::create_dir_all(project.join(".milagre")).unwrap();
    let state = json!({ "next_id": 10, "worktrees": { "1": { "id": 1, "path": "/tmp/wt" } },
        "sessions": { "1": { "id": 1, "worktree_id": 1, "provider": "kiro", "native_session_id": "n1" } },
        "messages": [
            { "id": 1, "session_id": 1, "role": "user", "body": "hi" },
            { "id": 2, "session_id": 1, "role": "assistant", "body": "", "context": { "kind": "handoff", "from": { "provider": "kiro" }, "to": { "provider": "kiro" }, "status": "preparing" } },
        ] });
    std::fs::write(
        project.join(".milagre/coordination.json"),
        state.to_string(),
    )
    .unwrap();
    let mut host = ChatHost::new(ProjectStates::new(isolation, Timing::default(), 0));
    let kiro = MockProvider::new("kiro");
    host.register(Box::new(kiro.clone()));
    Copy {
        base,
        project,
        host,
        kiro,
    }
}

impl Copy {
    fn send(
        &mut self,
        client: &str,
    ) -> milagre_owner_store::Result<milagre_owner_store::chat_host::Sent> {
        self.host.send(&json!({ "projectPath": self.project.display().to_string(), "sessionId": 1, "provider": "kiro", "model": "m", "body": "next", "clientMessageId": client }))
    }

    fn chat(&self) -> String {
        format!("{}#1", self.project.display())
    }

    fn ready_notices(&mut self) -> usize {
        self.host
            .take_notices()
            .iter()
            .filter(|notice| matches!(notice, Notice::ProjectReady { .. }))
            .count()
    }

    fn saved(&self) -> String {
        let mut text = std::fs::read_to_string(self.project.join(".milagre/coordination.json"))
            .unwrap_or_default();
        text.push_str(&String::from_utf8_lossy(
            &std::fs::read(self.project.join(".milagre/chats.db")).unwrap_or_default(),
        ));
        text
    }
}

#[test]
fn a_failed_recovery_save_keeps_the_project_not_ready_until_a_retry() {
    let mut c = copy();
    assert!(!c.host.is_project_ready(&c.project));
    // Before any open, everything is refused and nothing is loaded.
    assert_eq!(c.send("c0").unwrap_err().code(), Some("PROJECT_NOT_READY"));
    assert!(!c.host.states.has(&c.project));
    // The recovery's save fails (deterministic fault, not file modes).
    c.host.states.fail_next_commit("disk full");
    let failed = c.host.open_project(&c.project).unwrap_err();
    assert!(failed.to_string().contains("disk full"), "{failed}");
    assert!(!c.host.is_project_ready(&c.project));
    assert!(
        c.host.states.has(&c.project),
        "the loaded state wasn't kept"
    );
    assert!(
        ownership::project_lock(&c.project).exists(),
        "the lock wasn't kept"
    );
    assert_eq!(c.ready_notices(), 0);
    // Not ready: a send, a queued send, an answer and a provider event are all refused; nothing is saved or started.
    let before = c.saved();
    assert_eq!(c.send("c1").unwrap_err().code(), Some("PROJECT_NOT_READY"));
    let answer = c
        .host
        .respond_permission(&json!({ "chatId": c.chat(), "requestId": "p1", "decision": "allow" }));
    assert_eq!(answer.unwrap_err().code(), Some("PROJECT_NOT_READY"));
    let event = c.host.deliver(ProviderEvent::Agent {
        chat: c.chat(),
        turn: TurnId(1),
        event: RawJson(json!({ "type": "text-delta", "text": "late" })),
    });
    assert_eq!(event.unwrap_err().code(), Some("PROJECT_NOT_READY"));
    assert_eq!(c.saved(), before);
    assert!(c.kiro.state.lock().unwrap().turns.is_empty());
    assert!(
        c.host
            .take_notices()
            .iter()
            .all(|n| !matches!(n, Notice::Broadcast { .. })),
        "published while not ready"
    );
    // The retry recovers, saves durably and tells ProjectReady once (with the recovery's broadcast after it).
    c.host.open_project(&c.project).unwrap();
    assert!(c.host.is_project_ready(&c.project));
    let notices = c.host.take_notices();
    assert_eq!(
        notices
            .iter()
            .filter(|n| matches!(n, Notice::ProjectReady { .. }))
            .count(),
        1
    );
    let ready_at = notices
        .iter()
        .position(|n| matches!(n, Notice::ProjectReady { .. }))
        .unwrap();
    assert!(notices[ready_at..]
        .iter()
        .any(|n| matches!(n, Notice::Broadcast { .. })));
    assert!(notices[..ready_at]
        .iter()
        .all(|n| !matches!(n, Notice::Broadcast { .. })));
    assert!(
        c.saved().contains("\"failed\""),
        "the recovery wasn't saved before ready"
    );
    c.send("c2").unwrap();
    assert_eq!(c.kiro.state.lock().unwrap().turns.len(), 1);
    // A repeat open is the fast path: no recovery, no save, no notice.
    c.host.take_notices();
    c.host.open_project(&c.project).unwrap();
    assert_eq!(c.ready_notices(), 0);
    c.host.require_project_ready(&c.project).unwrap();
}

/// A ready Project whose folder was moved away and replaced by a link: the checks make it not ready (no writes, no
/// starts), its locks stay, and opening again fails the same way.
#[test]
fn a_replaced_root_makes_a_ready_project_not_ready() {
    let mut c = copy();
    c.host.open_project(&c.project).unwrap();
    let moved = c.base.path().join("moved");
    std::fs::rename(&c.project, &moved).unwrap();
    symlink(&moved, &c.project).unwrap();
    let before = std::fs::read(moved.join(".milagre/coordination.json")).unwrap();
    assert!(c.host.require_project_ready(&c.project).is_err());
    assert!(!c.host.is_project_ready(&c.project));
    assert!(
        c.host.open_project(&c.project).is_err(),
        "a repeat open passed on an untrusted root"
    );
    assert_eq!(c.send("c1").unwrap_err().code(), Some("PROJECT_NOT_READY"));
    assert!(c.kiro.state.lock().unwrap().turns.is_empty());
    assert_eq!(
        std::fs::read(moved.join(".milagre/coordination.json")).unwrap(),
        before,
        "something was written"
    );
    assert!(moved.join(".milagre/runtime.lock/owner.json").exists());
    std::fs::remove_file(&c.project).unwrap();
    std::fs::rename(&moved, &c.project).unwrap();
}

/// Quitting or a Project being closed refuses the open (OWNER_CLOSING); after a completed forget, an explicit open
/// reopens it.
#[test]
fn closing_and_quitting_refuse_the_open() {
    let mut c = copy();
    c.host.open_project(&c.project).unwrap();
    c.host.forget(&c.project, false).unwrap();
    assert!(!c.host.is_project_ready(&c.project));
    c.host.open_project(&c.project).unwrap();
    assert!(c.host.is_project_ready(&c.project));
    c.host.shutdown(true).unwrap();
    assert_eq!(
        c.host.open_project(&c.project).unwrap_err().code(),
        Some("OWNER_CLOSING")
    );
}

/// Another owner holding the handover store: HANDOVER_STORE_BUSY, the Project loaded, locked and not ready; once that
/// owner lets go, the retry opens it.
#[test]
fn another_owners_handover_store_refuses_until_it_lets_go() {
    let mut c = copy();
    // Another owner's jobs table over the same copy holds the store's lease.
    let isolation = Isolation::open(c.project.parent().unwrap(), &Policy::default()).unwrap();
    let other = milagre_owner_store::transcripts::TranscriptJobs::new(&isolation).unwrap();
    let refused = c.host.open_project(&c.project).unwrap_err();
    assert_eq!(refused.code(), Some("HANDOVER_STORE_BUSY"), "{refused}");
    assert!(!c.host.is_project_ready(&c.project));
    assert!(c.host.states.has(&c.project));
    assert!(ownership::project_lock(&c.project).exists());
    drop(other);
    c.host.open_project(&c.project).unwrap();
    assert!(c.host.is_project_ready(&c.project));
}
