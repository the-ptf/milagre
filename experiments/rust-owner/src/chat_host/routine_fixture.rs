//! Trusted fixture-only schedule admission. No wire method selects this path.
use super::*;

pub(super) struct UnreadReceipt {
    pub(super) turn: TurnId,
    pub(super) marked: Option<std::sync::Weak<serde_json::Map<String, Value>>>,
}

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
        if self.routine_unread.len() >= 64 && !self.routine_unread.contains_key(&chat) {
            return Err(RoutineFixtureError::Refused(gate(
                "Routine unread tracking capacity full",
            )));
        }
        let sent = self
            .send_admitted(&request, SendAdmission::RoutineFixture)
            .map_err(RoutineFixtureError::Dispatch)?;
        if let Some(turn) = sent.turn {
            self.routine_unread
                .insert(chat, UnreadReceipt { turn, marked: None });
        }
        Ok(sent)
    }
    /// An admitted explicit read/unread action supersedes terminal rollback,
    /// even when its value equals the saved value and produces no new snapshot.
    pub fn routine_fixture_unread_intent(&mut self, project: &Path, session: i64) {
        let chat = agent_runs::chat_key(&project.to_string_lossy(), &json!(session));
        if let Some(receipt) = self.routine_unread.get_mut(&chat) {
            receipt.marked = None;
        }
    }
    /// Legacy saved-effects entrypoint: it holds no turn receipt, so unread is
    /// untouched. The scheduler uses the exact-turn variant below. No model naming authority is minted.
    pub fn finish_claimed_routine_fixture_chat(
        &mut self,
        project: &Path,
        chat: &str,
        run_id: &str,
        quiet_summary: Option<&str>,
        quiet_title: Option<&str>,
    ) -> Result<()> {
        self.finish_claimed_routine_fixture_chat_for_turn(
            project,
            chat,
            run_id,
            quiet_summary,
            quiet_title,
            None,
        )
    }
    #[allow(clippy::too_many_arguments)] // Exact captured turn is independent authority, not caller state.
    pub fn finish_claimed_routine_fixture_chat_for_turn(
        &mut self,
        project: &Path,
        chat: &str,
        run_id: &str,
        quiet_summary: Option<&str>,
        quiet_title: Option<&str>,
        turn: Option<TurnId>,
    ) -> Result<()> {
        let (resolved, sid) = self.canonical_chat(chat)?;
        if resolved != project
            || self.active_turn(chat).is_some()
            || turn.is_some_and(|t| self.latest.get(chat).is_some_and(|latest| *latest != t))
        {
            return Err(gate("Routine completion no longer owns an idle Chat"));
        }
        self.require_project_ready(project)?;
        let marked = self
            .routine_unread
            .get(chat)
            .filter(|receipt| Some(receipt.turn) == turn)
            .and_then(|receipt| receipt.marked.as_ref())
            .and_then(std::sync::Weak::upgrade);
        self.states
            .try_update(project, Some(&[sid]), true, |latest| {
                let mut messages = latest.message_list().to_vec();
                let index = messages
                    .iter()
                    .rposition(|m| {
                        m.value()["session_id"] == sid
                            && m.value()["context"]["kind"] == "routine-run"
                            && m.value()["context"]["runId"] == run_id
                    })
                    .ok_or_else(|| gate("Routine completion divider disappeared"))?;
                if messages[index + 1..]
                    .iter()
                    .any(|m| m.value()["session_id"] == sid && m.value()["role"] == "user")
                {
                    return Err(gate("Routine completion observed a successor user turn"));
                }
                let mut message = messages[index].value().clone();
                message["context"]["quiet"] = json!(quiet_summary.is_some());
                if let Some(summary) = quiet_summary {
                    message["context"]["summary"] = json!(summary);
                }
                messages[index] = Msg::new(message);
                let mut next = latest.with_messages(messages);
                let mut session = latest
                    .sessions()
                    .and_then(|ss| ss.get(&sid.to_string()))
                    .and_then(Value::as_object)
                    .cloned()
                    .ok_or_else(|| gate("Routine Chat disappeared"))?;
                if quiet_summary.is_some()
                    && marked
                        .as_ref()
                        .is_some_and(|rest| std::sync::Arc::ptr_eq(rest, &latest.rest))
                {
                    session.insert("unread".into(), json!(false));
                }
                next = agent_runs::with_session(&next, sid, session.clone());
                if session
                    .get("routine")
                    .is_some_and(|origin| origin["runId"] == run_id)
                {
                    if let Some(title) = quiet_title {
                        if session
                            .get("title")
                            .and_then(Value::as_str)
                            .is_none_or(|s| crate::tool_activity::js_trim(s).is_empty())
                        {
                            session.insert("generatedTitle".into(), json!(title));
                        }
                    }
                    if quiet_summary.is_some() {
                        session.insert("archived".into(), json!(true));
                    }
                    next = agent_runs::with_session(&next, sid, session);
                }
                Ok(Some(next))
            })?;
        self.states.flush(Some(project))?;
        self.routine_unread.remove(chat);
        Ok(())
    }
    /// Creates only a fresh primary-Project fixture Chat. The durable scheduler
    /// must attach the returned identities before calling trusted send.
    pub fn create_claimed_routine_fixture_chat(
        &mut self,
        project: &Path,
        claim: &Value,
        configured_model: &str,
    ) -> std::result::Result<(String, String), RoutineFixtureError> {
        let routine = &claim["routine"];
        if routine["target"]["kind"] != "new-chat"
            || routine["target"]["workspace"] != "project"
            || routine["target"]["projectPath"].as_str() != project.to_str()
        {
            return Err(RoutineFixtureError::Refused(gate(
                "Only primary Project new-Chat fixtures",
            )));
        }
        validate_claim(claim, configured_model).map_err(RoutineFixtureError::Refused)?;
        self.require_project_ready(project)
            .map_err(RoutineFixtureError::Refused)?;
        let mut identities = None;
        self.states
            .try_update(project, Some(&[]), true, |latest| {
                let worktrees = latest
                    .get("worktrees")
                    .and_then(Value::as_object)
                    .ok_or_else(|| gate("An unavailable Routine Project"))?;
                let primary = jsjson::js_entries(worktrees)
                    .into_iter()
                    .map(|(_, w)| w)
                    .filter(|w| {
                        w["path"].as_str() == project.to_str()
                            && !jsjson::truthy(w.get("sharedChat"))
                    })
                    .collect::<Vec<_>>();
                if primary.len() != 1 {
                    return Err(gate("An ambiguous or missing primary Routine Worktree"));
                }
                let worktree = primary[0];
                let wid = worktree["id"]
                    .as_i64()
                    .filter(|v| *v >= 0)
                    .ok_or_else(|| gate("Invalid primary Routine Worktree identity"))?;
                if worktrees.get(&wid.to_string()) != Some(worktree) {
                    return Err(gate("Invalid primary Routine Worktree key"));
                }
                let sid = latest
                    .get("next_id")
                    .and_then(Value::as_i64)
                    .filter(|v| (0..9_007_199_254_740_991).contains(v))
                    .ok_or_else(|| gate("Invalid new Routine Chat identity"))?;
                if latest
                    .sessions()
                    .is_some_and(|ss| ss.contains_key(&sid.to_string()))
                {
                    return Err(gate("A colliding new Routine Chat identity"));
                }
                let mut session = json!({"id":sid,"worktree_id":wid,"status":"Created",
                "routine":{"routineId":routine["id"],"runId":claim["run"]["id"],"hidden":true},
                "generatedTitle":routine["name"]});
                if let Some(name) = worktree.get("name") {
                    session["agent_name"] = name.clone();
                }
                identities = Some((
                    agent_runs::chat_key(&project.to_string_lossy(), &json!(sid)),
                    wid.to_string(),
                ));
                Ok(Some(
                    agent_runs::with_session(latest, sid, session.as_object().unwrap().clone())
                        .with_field("next_id", json!(sid + 1)),
                ))
            })
            .map_err(RoutineFixtureError::Dispatch)?;
        self.states
            .flush(Some(project))
            .map_err(RoutineFixtureError::Dispatch)?;
        identities
            .ok_or_else(|| RoutineFixtureError::Dispatch(gate("New Routine Chat was not saved")))
    }
    fn prepare_claimed_routine_fixture(
        &mut self,
        project: &Path,
        claim: &Value,
        configured_model: &str,
    ) -> Result<(Value, String)> {
        let routine = &claim["routine"];
        let run = &claim["run"];
        validate_claim(claim, configured_model)?;
        if routine["target"]["kind"] != "chat" {
            return Err(gate("Only existing fixture Chat delivery"));
        }
        let id = routine["id"].as_str().unwrap();
        let run_id = run["id"].as_str().unwrap();
        let body = routine["prompt"].as_str().unwrap();
        let at = run["startedAt"].as_i64().unwrap();
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
        let mut request = json!({"projectPath":project,"sessionId":session_id,"worktreeId":worktree["id"],
            "provider":"claude","model":configured_model,"permissionMode":"ask","body":body,
            "prompt":format!("{body}{ROUTINE_PASS_HINT}"),"images":[],"files":[],
            "context":{"kind":"routine-run","routineId":id,"runId":run_id,"name":routine["name"],"at":at}});
        if session["routine"]["routineId"] == id && session["routine"]["runId"] == run_id {
            request["context"]["label"] = json!(format!(
                "Routine · {}",
                routine["name"].as_str().unwrap_or("")
            ));
        }
        Ok((request, chat.to_owned()))
    }
}

fn validate_claim(claim: &Value, configured_model: &str) -> Result<()> {
    let routine = &claim["routine"];
    let run = &claim["run"];
    let id = routine["id"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 256)
        .ok_or_else(|| gate("Invalid claimed Routine"))?;
    let _run_id = run["id"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 256)
        .ok_or_else(|| gate("Invalid claimed Run"))?;
    if run["routineId"] != id
        || run["status"] != "running"
        || routine["trigger"]["kind"] != "schedule"
        || !matches!(routine["provider"].as_str(), None | Some("claude"))
        || routine
            .get("model")
            .is_some_and(|v| !v.is_null() && v != configured_model)
        || routine["permissionMode"] != "ask"
        || configured_model.is_empty()
    {
        return Err(gate("Only captured Claude/Ask schedule fixtures"));
    }
    let _body = routine["prompt"]
        .as_str()
        .filter(|s| !s.contains("{{"))
        .ok_or_else(|| gate("Schedule template expansion is outside this fixture"))?;
    let _at = run["startedAt"]
        .as_i64()
        .ok_or_else(|| gate("Invalid claimed Run clock"))?;
    Ok(())
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
    fn unread_tracking_capacity_refuses_before_dispatch_and_successful_close_drains() {
        let (_root, mut host, provider, project, claim) = setup();
        for id in 0..64 {
            host.routine_unread.insert(
                format!("{}#{}", project.display(), id + 100),
                UnreadReceipt {
                    turn: TurnId(id),
                    marked: None,
                },
            );
        }
        let before = host.states.whole_state(&project).unwrap();
        assert!(matches!(
            host.send_claimed_routine_fixture(&project, &claim, "sonnet"),
            Err(RoutineFixtureError::Refused(_))
        ));
        assert_eq!(host.states.whole_state(&project).unwrap(), before);
        assert!(provider.state.lock().unwrap().turns.is_empty());
        host.forget(&project, false).unwrap();
        assert!(host.routine_unread.is_empty());
    }
    #[test]
    fn unread_receipt_clears_only_exact_terminal_mutation_without_intervening_edits() {
        for (preexisting, edited, wrong_turn, expected) in [
            (false, false, false, false),
            (true, false, false, true),
            (false, true, false, true),
            (false, false, true, true),
        ] {
            let (_root, mut host, _provider, project, claim) = setup();
            let chat = claim["routine"]["target"]["chatId"].as_str().unwrap();
            if preexisting {
                host.states
                    .try_update(&project, Some(&[1]), true, |latest| {
                        let mut session =
                            latest.sessions().unwrap()["1"].as_object().unwrap().clone();
                        session.insert("unread".into(), json!(true));
                        Ok(Some(agent_runs::with_session(latest, 1, session)))
                    })
                    .unwrap();
            }
            let sent = host
                .send_claimed_routine_fixture(&project, &claim, "sonnet")
                .unwrap();
            let turn = sent.turn.unwrap();
            host.receive(
                chat,
                turn,
                &json!({"type":"text-delta","text":"(pass) Clean"}),
            )
            .unwrap();
            let node_input = json!({"state":host.states.current(&project).unwrap().to_value(),"runs":host.runs,"chat":chat});
            let script = r#"
const {ChatHost}=require(process.argv[1]+"/packages/core/src/agents/chat-host.cjs");
const input=JSON.parse(process.argv[2]);let state=input.state;
const host={runs:input.runs,seq:0,turns:new Map(),now:()=>1790000000000,isChatFocused:()=>false,withNotes:s=>s,
states:{update:async(_p,fn)=>{const old=state;state=fn(state);return {state,changed:state!==old};}}};
ChatHost.prototype.fold.call(host,input.chat,{type:"turn-completed"}).then(({event,state})=>console.log(JSON.stringify({marked:event.markedUnread===true,enumerable:Object.keys(event).includes("markedUnread"),unread:state.sessions[1].unread}))).catch(e=>{console.error(e);process.exitCode=1});
"#;
            let output = std::process::Command::new("node")
                .arg("-e")
                .arg(script)
                .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
                .arg(node_input.to_string())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let oracle: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(
                oracle,
                json!({"marked":!preexisting,"enumerable":false,"unread":true})
            );
            host.receive(chat, turn, &json!({"type":"turn-completed"}))
                .unwrap();
            assert_eq!(
                host.routine_unread[chat].marked.is_some(),
                oracle["marked"].as_bool().unwrap()
            );
            assert_eq!(
                host.states.current(&project).unwrap().rest["sessions"]["1"]["unread"],
                true
            );
            if edited {
                for unread in [false, true] {
                    host.states
                        .try_update(&project, Some(&[1]), true, |latest| {
                            let mut session =
                                latest.sessions().unwrap()["1"].as_object().unwrap().clone();
                            session.insert("unread".into(), json!(unread));
                            Ok(Some(agent_runs::with_session(latest, 1, session)))
                        })
                        .unwrap();
                }
            }
            let result = host.finish_claimed_routine_fixture_chat_for_turn(
                &project,
                chat,
                "abc00002",
                Some("Clean"),
                Some("Clean"),
                Some(if wrong_turn { TurnId(turn.0 + 1) } else { turn }),
            );
            assert_eq!(result.is_err(), wrong_turn);
            assert_eq!(
                host.states.current(&project).unwrap().rest["sessions"]["1"]["unread"],
                expected
            );
            if !wrong_turn {
                assert!(host.routine_unread.is_empty());
            }
        }
    }
    #[test]
    fn saved_quiet_context_and_title_match_actual_node_methods() {
        for user_title in [
            None,
            Some("User chosen title"),
            Some("\u{feff}"),
            Some("\u{85}"),
        ] {
            let (_root, mut host, _provider, project, mut claim) = setup();
            claim["routine"]["target"] =
                json!({"kind":"new-chat","projectPath":project,"workspace":"project"});
            let (chat, _) = host
                .create_claimed_routine_fixture_chat(&project, &claim, "sonnet")
                .unwrap();
            let (_, sid) = host.canonical_chat(&chat).unwrap();
            host.states.try_update(&project, Some(&[sid]), true, |latest| {
                let mut session=latest.sessions().unwrap()[&sid.to_string()].as_object().unwrap().clone();
                if let Some(title)=user_title { session.insert("title".into(),json!(title)); }
                let next=agent_runs::with_session(latest,sid,session);
                Ok(Some(next.with_messages(vec![Msg::new(json!({"id":101,"session_id":sid,"role":"user","body":"Check","context":{"kind":"routine-run","runId":"abc00002"}}))])))
            }).unwrap();
            let before = host.states.whole_state(&project).unwrap();
            let script = r#"
const {ChatHost}=require(process.argv[1]+"/packages/core/src/agents/chat-host.cjs");
const {compactProjectState}=require(process.argv[1]+"/packages/core/src/project-store.cjs");
const input=JSON.parse(process.argv[2]);let state=input.state;
const chats={states:{update:async(_p,change)=>{state=await compactProjectState(_p,change(state),state);return {state,changed:true};}},broadcast(){}};
(async()=>{await ChatHost.prototype.patchMessageContext.call(chats,"p",input.sid,m=>m.context?.runId==="abc00002",{quiet:true,summary:"All clean"});
await ChatHost.prototype.nameRunChat.call(chats,"p",input.sid,"abc00002","All clean");console.log(JSON.stringify(state));})().catch(e=>{console.error(e);process.exitCode=1});
"#;
            let output = std::process::Command::new("node")
                .arg("-e")
                .arg(script)
                .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
                .arg(json!({"state":before,"sid":sid}).to_string())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let node: Value = serde_json::from_slice(&output.stdout).unwrap();
            host.finish_claimed_routine_fixture_chat(
                &project,
                &chat,
                "abc00002",
                Some("All clean"),
                Some("All clean"),
            )
            .unwrap();
            let after = host.states.whole_state(&project).unwrap();
            assert_eq!(after["messages"], node["messages"]);
            assert_eq!(
                after["sessions"][sid.to_string()]["generatedTitle"],
                node["sessions"][sid.to_string()]["generatedTitle"]
            );
            assert_eq!(
                after["sessions"][sid.to_string()]["title"],
                node["sessions"][sid.to_string()]["title"]
            );
            assert_eq!(after["sessions"][sid.to_string()]["archived"], true);
            host.states
                .try_update(&project, Some(&[sid]), true, |latest| {
                    let mut list = latest.message_list().to_vec();
                    list.push(Msg::new(
                        json!({"id":102,"session_id":sid,"role":"user","body":"User successor"}),
                    ));
                    Ok(Some(latest.with_messages(list)))
                })
                .unwrap();
            let before_refusal = host.states.whole_state(&project).unwrap();
            assert!(host
                .finish_claimed_routine_fixture_chat(
                    &project,
                    &chat,
                    "abc00002",
                    Some("Changed"),
                    Some("Changed")
                )
                .is_err());
            assert_eq!(host.states.whole_state(&project).unwrap(), before_refusal);
        }
    }
    #[test]
    fn fresh_primary_chat_matches_actual_node_empty_chat_and_context() {
        let (_root, mut host, provider, project, mut claim) = setup();
        claim["routine"]["target"] =
            json!({"kind":"new-chat","projectPath":project,"workspace":"project"});
        let before = host.states.whole_state(&project).unwrap();
        let script = r#"
const {ChatHost}=require(process.argv[1]+"/packages/core/src/agents/chat-host.cjs");
const {routineChats}=require(process.argv[1]+"/packages/core/src/routines/runtime-adapter.cjs");
const {compactProjectState}=require(process.argv[1]+"/packages/core/src/project-store.cjs");
const input=JSON.parse(process.argv[2]); let state=input.state;
const chats={ states:{update:async(_p,change)=>{state=await compactProjectState(_p,change(state),state);return {state,changed:true};}},broadcast(){} };
chats.emptyChat=(...args)=>ChatHost.prototype.emptyChat.call(chats,...args);
const adapter=routineChats({chats,cachedState:()=>state,openState:async()=>state,isClosing:()=>false,
 worktrees:{projectWorktree:async()=>1},archiveChat:async()=>{},now:()=>input.claim.run.startedAt});
(async()=>{const made=await adapter.startChat(input.claim);console.log(JSON.stringify({state,made}));})().catch(e=>{console.error(e);process.exitCode=1});
"#;
        let output = std::process::Command::new("node")
            .arg("-e")
            .arg(script)
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
            .arg(json!({"state":before,"claim":claim}).to_string())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let node: Value = serde_json::from_slice(&output.stdout).unwrap();
        let (chat, wid) = host
            .create_claimed_routine_fixture_chat(&project, &claim, "sonnet")
            .unwrap();
        let created = host.states.whole_state(&project).unwrap();
        assert_eq!(created["sessions"], node["state"]["sessions"]);
        assert_eq!(created["next_id"], node["state"]["next_id"]);
        assert_eq!(chat, node["made"]["chatId"]);
        assert_eq!(wid, node["made"]["worktreeId"]);
        assert!(provider.state.lock().unwrap().turns.is_empty());
        claim["routine"]["target"] = json!({"kind":"chat","chatId":chat});
        let sent = host
            .send_claimed_routine_fixture(&project, &claim, "sonnet")
            .unwrap();
        assert_eq!(sent.session_id, 10);
        let saved = host.states.whole_state(&project).unwrap();
        assert_eq!(saved["messages"][0]["context"], node["made"]["context"]);
        assert_eq!(saved["messages"][0]["body"], node["made"]["body"]);
        host.shutdown(true).unwrap();
    }
    #[test]
    fn fresh_chat_does_not_queue_or_steer_into_a_busy_starter() {
        let (_root, mut host, provider, project, mut claim) = setup();
        let user = host.send(&json!({"projectPath":project,"sessionId":1,"worktreeId":1,"provider":"claude","model":"sonnet","permissionMode":"ask","body":"User's active turn"})).unwrap();
        let user_chat = format!("{}#1", project.display());
        claim["routine"]["target"] =
            json!({"kind":"new-chat","projectPath":project,"workspace":"project"});
        let (chat, _) = host
            .create_claimed_routine_fixture_chat(&project, &claim, "sonnet")
            .unwrap();
        claim["routine"]["target"] = json!({"kind":"chat","chatId":chat});
        let sent = host
            .send_claimed_routine_fixture(&project, &claim, "sonnet")
            .unwrap();
        assert!(!sent.queued && !sent.steering && sent.turn.is_some());
        assert_ne!(sent.session_id, user.session_id);
        assert_eq!(host.active_turn(&user_chat), user.turn);
        assert_eq!(provider.state.lock().unwrap().turns.len(), 2);
        let state = host.states.whole_state(&project).unwrap();
        assert_eq!(state["messages"][0]["body"], "User's active turn");
        assert_eq!(state["messages"][1]["session_id"], sent.session_id);
        host.shutdown(true).unwrap();
    }
    #[test]
    fn new_chat_refuses_foreign_worktree_and_malformed_claims_before_write() {
        let (_root, mut host, provider, project, mut claim) = setup();
        claim["routine"]["target"] =
            json!({"kind":"new-chat","projectPath":project,"workspace":"project"});
        let before = host.states.whole_state(&project).unwrap();
        for kind in ["foreign", "worktree", "run", "template", "mode", "model"] {
            let mut bad = claim.clone();
            match kind {
                "foreign" => bad["routine"]["target"]["projectPath"] = json!("/foreign"),
                "worktree" => bad["routine"]["target"]["workspace"] = json!("worktree"),
                "run" => bad["run"]["status"] = json!("acted"),
                "template" => bad["routine"]["prompt"] = json!("{{date}}"),
                "mode" => bad["routine"]["permissionMode"] = json!("full"),
                _ => bad["routine"]["model"] = json!("other"),
            }
            assert!(
                matches!(
                    host.create_claimed_routine_fixture_chat(&project, &bad, "sonnet"),
                    Err(RoutineFixtureError::Refused(_))
                ),
                "{kind}"
            );
            assert_eq!(host.states.whole_state(&project).unwrap(), before);
            assert!(provider.state.lock().unwrap().turns.is_empty());
        }
        host.shutdown(true).unwrap();
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
