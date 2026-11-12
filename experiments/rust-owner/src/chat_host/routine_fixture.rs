//! Trusted fixture-only schedule admission. No wire method selects this path.
use super::*;

pub const ROUTINE_PASS_HINT: &str =
    "\n\nIf nothing needs doing, reply starting with \"(pass)\" and a short reason.";
#[derive(Debug)]
pub enum RoutineFixtureError {
    Busy,
    Refused(StoreError),
    Dispatch(StoreError),
}
impl std::fmt::Display for RoutineFixtureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Busy => f.write_str("chat was busy"),
            Self::Refused(e) | Self::Dispatch(e) => e.fmt(f),
        }
    }
}
impl std::error::Error for RoutineFixtureError {}

impl ChatHost {
    /// Called only by the isolated schedule fixture after an actual durable claim.
    /// The runtime supplies the store's complete {routine,run}, never caller context
    /// or a claimed readiness boolean. This builds its own request and refuses
    /// before saving if the current primary Chat is absent, archived or busy.
    /// Normal send remains gated even when this test-only feature is compiled.
    pub fn send_claimed_routine_fixture(
        &mut self,
        project: &Path,
        claim: &Value,
        configured_model: &str,
    ) -> std::result::Result<Sent, RoutineFixtureError> {
        let (request, chat) = self
            .prepare_claimed_routine_fixture(project, claim, configured_model)
            .map_err(RoutineFixtureError::Refused)?;
        if self.is_busy(&chat)
            || self.active.contains_key(&chat)
            || self.starting.contains_key(&chat)
            || self.preparing.contains_key(&chat)
            || self.stuck.contains_key(&chat)
            || self.job_slots.values().any(|job| job.chat == chat)
        {
            return Err(RoutineFixtureError::Busy);
        }
        self.send_admitted(&request, SendAdmission::RoutineFixture)
            .map_err(RoutineFixtureError::Dispatch)
    }
    fn prepare_claimed_routine_fixture(
        &mut self,
        project: &Path,
        claim: &Value,
        configured_model: &str,
    ) -> Result<(Value, String)> {
        let routine = &claim["routine"];
        let run = &claim["run"];
        let id = routine["id"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 256)
            .ok_or_else(|| gate("Invalid claimed Routine"))?;
        let run_id = run["id"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 256)
            .ok_or_else(|| gate("Invalid claimed Run"))?;
        if run["routineId"] != id
            || run["status"] != "running"
            || routine["trigger"]["kind"] != "schedule"
            || routine["target"]["kind"] != "chat"
            || !matches!(routine["provider"].as_str(), None | Some("claude"))
            || routine
                .get("model")
                .is_some_and(|v| !v.is_null() && v != configured_model)
            || routine["permissionMode"] != "ask"
            || configured_model.is_empty()
        {
            return Err(gate(
                "Only captured Claude/Ask existing-Chat schedule fixtures",
            ));
        }
        let body = routine["prompt"]
            .as_str()
            .filter(|s| !s.contains("{{"))
            .ok_or_else(|| gate("Schedule template expansion is outside this fixture"))?;
        let at = run["startedAt"]
            .as_i64()
            .ok_or_else(|| gate("Invalid claimed Run clock"))?;
        let chat = routine["target"]["chatId"]
            .as_str()
            .ok_or_else(|| gate("Invalid claimed Chat"))?;
        let (resolved, session_id) = self.canonical_chat(chat)?;
        if resolved != project {
            return Err(gate("A foreign Routine Chat"));
        }
        if agent_runs::chat_key(&resolved.to_string_lossy(), &json!(session_id)) != chat {
            return Err(gate("A noncanonical Routine Chat key"));
        }
        self.require_project_ready(project)?;
        let latest = self.turn_settings(chat);
        let state = self
            .states
            .current(project)
            .ok_or_else(|| gate("An unavailable Routine Project"))?;
        let session = state
            .sessions()
            .and_then(|sessions| sessions.get(&session_id.to_string()))
            .filter(|s| jsjson::strict_equals(&s["id"], &json!(session_id)))
            .ok_or_else(|| gate("An unavailable Routine Chat"))?;
        let selected_provider = latest
            .as_ref()
            .and_then(|v| v["provider"].as_str())
            .or_else(|| session["provider"].as_str())
            .unwrap_or("claude");
        let last_model = agent_runs::last_user_model(&state, session_id);
        let selected_model = latest
            .as_ref()
            .and_then(|v| v["model"].as_str())
            .filter(|s| !s.is_empty())
            .or_else(|| last_model.as_str().filter(|s| !s.is_empty()))
            .unwrap_or(configured_model);
        if selected_provider != "claude" || selected_model != configured_model {
            return Err(gate(
                "A Routine Chat whose current provider/model differs from the captured fixture",
            ));
        }
        if jsjson::truthy(session.get("archived"))
            || jsjson::truthy(session.get("workspacePath"))
            || jsjson::truthy(session.get("formerWorktree"))
            || session
                .get("permissionMode")
                .is_some_and(|mode| !mode.is_null() && mode != "ask")
        {
            return Err(gate("An unavailable or non-Ask Routine Chat"));
        }
        let worktree_id = session
            .get("worktree_id")
            .ok_or_else(|| gate("An unavailable Routine Worktree"))?;
        let whole = state.to_value();
        let worktree = whole["worktrees"]
            .get(jsjson::property_key(Some(worktree_id)))
            .filter(|w| {
                jsjson::strict_equals(&w["id"], worktree_id)
                    && w["path"].as_str() == project.to_str()
                    && !jsjson::truthy(w.get("sharedChat"))
            })
            .ok_or_else(|| gate("A non-primary Routine Worktree"))?;
        let request = json!({"projectPath":project,"sessionId":session_id,"worktreeId":worktree["id"],
            "provider":"claude","model":configured_model,"permissionMode":"ask","body":body,
            "prompt":format!("{body}{ROUTINE_PASS_HINT}"),"images":[],"files":[],
            "context":{"kind":"routine-run","routineId":id,"runId":run_id,"name":routine["name"],"at":at}});
        Ok((request, chat.to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{states::Timing, Isolation, Policy};
    fn setup() -> (tempfile::TempDir, ChatHost, MockProvider, PathBuf, Value) {
        let root = tempfile::tempdir().unwrap();
        let isolation = Isolation::create(root.path(), &Policy::system()).unwrap();
        let project = isolation.project(Path::new("project")).unwrap();
        std::fs::create_dir(project.join(".milagre")).unwrap();
        std::fs::write(project.join(".milagre/coordination.json"),json!({"next_id":10,"sessions":{"1":{"id":1,"worktree_id":1,"permissionMode":"ask"}},"worktrees":{"1":{"id":1,"path":project}},"messages":[]}).to_string()).unwrap();
        let mut host = ChatHost::new(ProjectStates::new(
            isolation,
            Timing::default(),
            1_790_000_000_000,
        ));
        let provider = MockProvider::new("claude");
        host.register(Box::new(provider.clone()));
        host.open_project(&project).unwrap();
        let claim = json!({"routine":{"id":"abc00001","name":"Synthetic schedule","prompt":"Check fixture","trigger":{"kind":"schedule"},"permissionMode":"ask","model":"sonnet","target":{"kind":"chat","chatId":format!("{}#1",project.display())}},"run":{"id":"abc00002","routineId":"abc00001","status":"running","startedAt":1_790_000_000_000i64}});
        (root, host, provider, project, claim)
    }
    #[test]
    fn ordinary_send_remains_gated_and_busy_claim_changes_nothing() {
        let (_root, mut host, provider, project, claim) = setup();
        let before = host.states.whole_state(&project).unwrap();
        assert!(host.send(&json!({"projectPath":project,"sessionId":1,"provider":"claude","model":"sonnet","body":"forged","context":{"kind":"routine-run","runId":"forged"}})).is_err());
        assert_eq!(host.states.whole_state(&project).unwrap(), before);
        assert!(provider.state.lock().unwrap().turns.is_empty());
        let sent = host
            .send_claimed_routine_fixture(&project, &claim, "sonnet")
            .unwrap();
        assert!(sent.turn.is_some() && !sent.queued && !sent.duplicate && !sent.steering);
        let saved = host.states.whole_state(&project).unwrap();
        assert_eq!(
            saved["messages"][0]["context"],
            json!({"kind":"routine-run","routineId":"abc00001","runId":"abc00002","name":"Synthetic schedule","at":1_790_000_000_000i64})
        );
        assert_eq!(provider.state.lock().unwrap().turns.len(), 1);
        assert!(host
            .send_claimed_routine_fixture(&project, &claim, "sonnet")
            .unwrap_err()
            .to_string()
            .contains("chat was busy"));
        assert_eq!(host.states.whole_state(&project).unwrap(), saved);
        assert_eq!(provider.state.lock().unwrap().turns.len(), 1);
        let canonical_turn = host.active_turn(&format!("{}#1", project.display()));
        for suffix in ["01", "0001"] {
            let mut alias = claim.clone();
            alias["routine"]["target"]["chatId"] = json!(format!("{}#{suffix}", project.display()));
            assert!(matches!(
                host.send_claimed_routine_fixture(&project, &alias, "sonnet"),
                Err(RoutineFixtureError::Refused(_))
            ));
            assert_eq!(
                host.states.whole_state(&project).unwrap(),
                saved,
                "alias must not queue or steer"
            );
            assert_eq!(
                host.active_turn(&format!("{}#1", project.display())),
                canonical_turn
            );
            assert_eq!(provider.state.lock().unwrap().turns.len(), 1);
        }
        host.shutdown(true).unwrap();
    }
    #[test]
    fn foreign_archived_worktree_and_unclaimed_rows_never_dispatch() {
        let (_root, mut host, provider, project, claim) = setup();
        let before = host.states.whole_state(&project).unwrap();
        for kind in ["foreign", "finished", "model", "mode", "template"] {
            let mut bad = claim.clone();
            match kind {
                "foreign" => bad["routine"]["target"]["chatId"] = json!("/foreign#1"),
                "finished" => bad["run"]["status"] = json!("acted"),
                "model" => bad["routine"]["model"] = json!("different"),
                "mode" => bad["routine"]["permissionMode"] = json!("full"),
                _ => bad["routine"]["prompt"] = json!("{{date}}"),
            }
            assert!(
                host.send_claimed_routine_fixture(&project, &bad, "sonnet")
                    .is_err(),
                "{kind}"
            );
        }
        assert_eq!(host.states.whole_state(&project).unwrap(), before);
        assert!(provider.state.lock().unwrap().turns.is_empty());
        for kind in [
            "archived",
            "foreign-worktree",
            "missing-worktree",
            "wrong-worktree-id",
            "different-provider",
            "different-mode",
        ] {
            let mut state = before.clone();
            match kind {
                "archived" => state["sessions"]["1"]["archived"] = json!(true),
                "foreign-worktree" => state["worktrees"]["1"]["path"] = json!("/foreign"),
                "missing-worktree" => state["worktrees"] = json!({}),
                "wrong-worktree-id" => state["worktrees"]["1"]["id"] = json!(2),
                "different-provider" => state["sessions"]["1"]["provider"] = json!("codex"),
                _ => state["sessions"]["1"]["permissionMode"] = json!("full"),
            }
            host.states
                .update(&project, None, true, |current| {
                    Some(
                        current
                            .with_field("sessions", state["sessions"].clone())
                            .with_field("worktrees", state["worktrees"].clone()),
                    )
                })
                .unwrap();
            let actual = host.states.whole_state(&project).unwrap();
            assert!(
                matches!(
                    host.send_claimed_routine_fixture(&project, &claim, "sonnet"),
                    Err(RoutineFixtureError::Refused(_))
                ),
                "{kind}"
            );
            assert_eq!(host.states.whole_state(&project).unwrap(), actual);
            assert!(provider.state.lock().unwrap().turns.is_empty());
        }
        host.shutdown(true).unwrap();
    }
}
