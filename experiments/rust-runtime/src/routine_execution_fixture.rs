//! Fixture-only primary Project Chat scheduling. Actor activation additionally requires the captured synthetic-root marker.
use milagre_owner_store::{
    chat_host::{ChatHost, RoutineFixtureError, TurnId},
    jsjson,
};
use milagre_routines::{OwnerCheck, RoutineStore, RunFinishStatus, StoreCommand};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
type Result<T> = std::result::Result<T, String>;
struct Pending {
    chat: String,
    turn: Option<TurnId>,
    interrupt_sent: bool,
}
pub(crate) struct Scheduler {
    pub(crate) store: RoutineStore,
    project: PathBuf,
    model: String,
    pending: BTreeMap<String, Pending>,
    stopped: bool,
    fenced: Option<String>,
    owner: OwnerCheck,
    changed: bool,
    content: Option<std::sync::Arc<crate::claude_content::SharedContent>>,
    #[cfg(test)]
    pub(crate) before_attach: Option<Box<dyn FnOnce() + Send>>,
    #[cfg(test)]
    pub(crate) before_dispatch: Option<Box<dyn FnOnce() + Send>>,
}
impl Scheduler {
    pub(crate) fn open(
        root: &Path,
        project: PathBuf,
        model: String,
        owner: OwnerCheck,
        now: i64,
        content: Option<std::sync::Arc<crate::claude_content::SharedContent>>,
    ) -> Result<Self> {
        let mut store = RoutineStore::open(root, owner.clone(), now).map_err(|e| e.to_string())?;
        // Once per owner lifetime, before any claim. A retained running row is failed,
        // never dispatched again, even if the former launch result was unknown.
        let recovered = store
            .execute(StoreCommand::RecoverInterrupted, now)
            .map_err(|e| e.to_string())?;
        Ok(Self {
            store,
            project,
            model,
            pending: BTreeMap::new(),
            stopped: false,
            fenced: None,
            owner,
            changed: recovered.changed,
            content,
            #[cfg(test)]
            before_attach: None,
            #[cfg(test)]
            before_dispatch: None,
        })
    }
    pub(crate) fn content(&self) -> Option<std::sync::Arc<crate::claude_content::SharedContent>> {
        self.content.clone()
    }
    pub(crate) fn model(&self) -> &str {
        &self.model
    }
    pub(crate) fn is_fenced(&self) -> bool {
        self.fenced.is_some()
    }
    pub(crate) fn has_active(&self, host: &ChatHost) -> bool {
        self.pending.values().any(|pending| {
            pending.turn.is_some() && host.active_turn(&pending.chat) == pending.turn
        })
    }

    pub(crate) fn close_for_recovery(&mut self, host: &ChatHost) -> Result<()> {
        if self.pending.values().any(|pending| {
            pending.turn.is_some() && host.active_turn(&pending.chat) == pending.turn
        }) {
            return Err("Actual scheduled/native work remains active".into());
        }
        self.store.close().map_err(|e| e.to_string())?;
        self.pending.clear();
        Ok(())
    }

    pub(crate) fn pending(&self) -> usize {
        self.pending.len()
    }
    fn transaction(&mut self, command: StoreCommand, now: i64) -> Result<Value> {
        match self.store.execute(command, now) {
            Ok(reply) => {
                self.changed |= reply.changed;
                Ok(reply.value)
            }
            Err(error) => self.fence(error.to_string()),
        }
    }
    fn fence<T>(&mut self, error: String) -> Result<T> {
        if self.fenced.is_none() {
            self.fenced = Some(error.chars().take(4096).collect());
        }
        Err(self.fenced.clone().unwrap())
    }
    fn check_owner(&self) -> Result<()> {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (self.owner)()))
            .map_err(|_| "Fixture dispatch owner check panicked".to_owned())?
    }
    #[cfg(test)]
    pub(crate) fn tick(&mut self, host: &mut ChatHost, now: i64) -> Result<()> {
        match self.tick_once(host, now) {
            Ok(()) => Ok(()),
            Err(error) => self.fence(error),
        }
    }
    #[cfg(test)]
    fn tick_once(&mut self, host: &mut ChatHost, now: i64) -> Result<()> {
        if let Some(error) = &self.fenced {
            return Err(error.clone());
        }
        host.require_project_ready(&self.project)
            .map_err(|e| e.to_string())?;
        let errors = host.tick(now);
        if let Some(error) = errors.first() {
            return self.fence(error.to_string());
        }
        host.take_notices(); // This fixture has no publisher; saved owner state is the terminal authority.
        self.advance(host, now)
    }
    pub(crate) fn take_changed(&mut self) -> bool {
        std::mem::take(&mut self.changed)
    }
    pub(crate) fn advance(&mut self, host: &mut ChatHost, now: i64) -> Result<()> {
        let result = self.advance_once(host, now);
        match result {
            Ok(()) => Ok(()),
            Err(error) => self.fence(error),
        }
    }
    fn advance_once(&mut self, host: &mut ChatHost, now: i64) -> Result<()> {
        if let Some(error) = &self.fenced {
            return Err(error.clone());
        }
        self.check_owner()?;
        host.require_project_ready(&self.project)
            .map_err(|e| e.to_string())?;
        self.finish_saved(host, now)?;
        if self.stopped || host.is_quitting() {
            return Ok(());
        }
        self.transaction(StoreCommand::ExpireDue { at: now }, now)?;
        let claims = self.transaction(StoreCommand::ClaimDue { at: now }, now)?;
        let claims = claims.as_array().ok_or("Invalid durable claim list")?;
        for original_claim in claims {
            let mut claim = original_claim.clone();
            let run_id = claim["run"]["id"]
                .as_str()
                .ok_or("Invalid durable Run identity")?
                .to_owned();
            let mut chat = claim["routine"]["target"]["chatId"]
                .as_str()
                .map(str::to_owned);
            if self.pending.len() >= 64 {
                return self.fence("Fixture pending capacity exceeded".into());
            }
            // The owner derives its context from this exact successful durable claim;
            // no caller context or admission proof boolean reaches it.
            self.check_owner()?;
            if claim["routine"]["target"]["kind"] == "new-chat" {
                // This always creates a fresh Chat, so starter reuse cannot bypass the
                // actual content owner's capacity. The actor serializes this with writes.
                if let Some(limit) = self.content.as_ref().and_then(|owner| owner.chat_limit()) {
                    let count = host
                        .states
                        .current(&self.project)
                        .and_then(|s| s.sessions().map(|ss| ss.len()))
                        .ok_or("Missing owned sessions")?;
                    if count >= limit {
                        self.finish(
                            run_id,
                            RunFinishStatus::Failed,
                            None,
                            Some("Configured content Chat admission is full".into()),
                            None,
                            now,
                        )?;
                        continue;
                    }
                }
                match host.create_claimed_routine_fixture_chat(&self.project, &claim, &self.model) {
                    Ok((created, worktree)) => {
                        self.check_owner()?;
                        #[cfg(test)]
                        if let Some(fault) = self.before_attach.take() {
                            fault();
                        }
                        let attached = self.transaction(
                            StoreCommand::AttachChat {
                                run_id: run_id.clone(),
                                chat_id: created.clone(),
                                worktree_id: Some(worktree),
                            },
                            now,
                        )?;
                        if attached != true {
                            return self.fence(
                                "Routine Chat attachment was not committed; no replay".into(),
                            );
                        }
                        claim["routine"]["target"] =
                            serde_json::json!({"kind":"chat","chatId":created});
                        chat = claim["routine"]["target"]["chatId"]
                            .as_str()
                            .map(str::to_owned);
                    }
                    Err(RoutineFixtureError::Refused(error)) => {
                        self.finish(
                            run_id,
                            RunFinishStatus::Failed,
                            None,
                            Some(error.to_string()),
                            None,
                            now,
                        )?;
                        continue;
                    }
                    Err(error) => return self.fence(error.to_string()),
                }
            }
            #[cfg(test)]
            if let Some(fault) = self.before_dispatch.take() {
                fault();
            }
            self.check_owner()?;
            let sent = host.send_claimed_routine_fixture(&self.project, &claim, &self.model);
            self.check_owner()?;
            match sent {
                Ok(sent) if !sent.queued && !sent.duplicate && !sent.steering => {
                    let chat = chat.ok_or("A scheduled fixture must bind its actual Chat")?;
                    if milagre_owner_store::agent_runs::chat_key(
                        &self.project.to_string_lossy(),
                        &sent.session_id,
                    ) != chat
                    {
                        return self.fence("Routine Sent Chat identity mismatch; no replay".into());
                    }
                    self.pending.insert(
                        run_id,
                        Pending {
                            chat,
                            turn: sent.turn,
                            interrupt_sent: false,
                        },
                    );
                }
                Ok(_) => {
                    return self.fence(
                        "Unexpected queued/duplicate/steered Routine delivery; no replay".into(),
                    )
                }
                Err(RoutineFixtureError::Busy) => {
                    self.finish(run_id, RunFinishStatus::SkippedBusy, chat, None, None, now)?;
                }
                Err(RoutineFixtureError::Refused(error)) => {
                    // Pre-admission fixture refusals cannot have saved or dispatched.
                    // Other store/launch errors may be uncertain: fence with the claim
                    // retained running, rather than retry or invent a terminal result.
                    self.finish(
                        run_id,
                        RunFinishStatus::Failed,
                        chat,
                        Some(error.to_string()),
                        None,
                        now,
                    )?;
                }
                Err(RoutineFixtureError::Dispatch(error)) => return self.fence(error.to_string()),
            }
        }
        Ok(())
    }
    fn finish(
        &mut self,
        run_id: String,
        status: RunFinishStatus,
        chat_id: Option<String>,
        error: Option<String>,
        summary: Option<String>,
        now: i64,
    ) -> Result<()> {
        let title = summary.as_deref().and_then(quiet_title);
        self.transaction(
            StoreCommand::FinishRun {
                run_id,
                status,
                chat_id,
                error,
                summary,
                title,
            },
            now,
        )?;
        Ok(())
    }
    fn finish_saved(&mut self, host: &mut ChatHost, now: i64) -> Result<()> {
        let state = host
            .states
            .current_whole_state(&self.project)
            .map_err(|e| e.to_string())?
            .ok_or("Project is not open")?;
        let messages = state["messages"]
            .as_array()
            .ok_or("Missing owned messages")?;
        let mut complete = Vec::new();
        for (run_id, pending) in &self.pending {
            if pending.turn.is_some() && host.active_turn(&pending.chat) == pending.turn {
                continue;
            }
            let Some(index) = messages.iter().position(|m| {
                m["role"] == "user"
                    && m["context"]["kind"] == "routine-run"
                    && m["context"]["runId"] == run_id.as_str()
            }) else {
                return self.fence("A scheduled message disappeared; no replay".into());
            };
            let session = &messages[index]["session_id"];
            let reply = messages[index + 1..]
                .iter()
                .filter(|m| jsjson::strict_equals(&m["session_id"], session))
                .take_while(|m| m["role"] != "user")
                .find(|m| m["role"] == "assistant" && m.get("context").is_none_or(Value::is_null));
            let Some(reply) = reply else {
                continue;
            };
            let (status, error, summary) = match reply["outcome"].as_str() {
                Some("completed") => match quiet_summary(reply["body"].as_str().unwrap_or(""))? {
                    Some(summary) => (RunFinishStatus::Quiet, None, Some(summary)),
                    None => (RunFinishStatus::Acted, None, None),
                },
                Some("cancelled") => (RunFinishStatus::Failed, Some("cancelled".into()), None),
                Some("failed") => (
                    RunFinishStatus::Failed,
                    Some(reply["body"].as_str().unwrap_or("turn failed").to_owned()),
                    None,
                ),
                _ => continue,
            };
            complete.push((
                run_id.clone(),
                pending.chat.clone(),
                pending.turn,
                status,
                error,
                summary,
            ));
        }
        if !complete.is_empty() {
            // The reply's kept terminal must be on disk before its Run becomes terminal.
            host.states
                .flush(Some(&self.project))
                .map_err(|e| e.to_string())?;
        }
        for (run, chat, turn, status, error, summary) in complete {
            self.check_owner()?;
            let title = summary.as_deref().and_then(quiet_title);
            host.finish_claimed_routine_fixture_chat_for_turn(
                &self.project,
                &chat,
                &run,
                summary.as_deref(),
                title.as_deref(),
                turn,
            )
            .map_err(|e| e.to_string())?;
            self.check_owner()?;
            self.finish(run.clone(), status, Some(chat), error, summary, now)?;
            self.pending.remove(&run);
        }
        Ok(())
    }
    // Revocation never fabricates finish. The durable running rows remain and
    // RecoverInterrupted classifies them only on the next verified lifetime.
    pub(crate) fn revoke(&mut self) {
        self.stopped = true;
        self.pending.clear();
    }
    pub(crate) fn stop(&mut self, host: &mut ChatHost) -> Result<()> {
        self.stopped = true;
        for pending in self.pending.values_mut() {
            if !pending.interrupt_sent
                && pending.turn.is_some()
                && host.active_turn(&pending.chat) == pending.turn
            {
                host.interrupt(&pending.chat).map_err(|e| e.to_string())?;
                pending.interrupt_sent = true;
            }
        }
        Ok(())
    }
    pub(crate) fn owns_active(&self, host: &ChatHost, chat: &str) -> bool {
        self.pending
            .values()
            .any(|p| p.chat == chat && p.turn.is_some() && host.active_turn(chat) == p.turn)
    }
    pub(crate) fn close(&mut self) -> Result<()> {
        if !self.pending.is_empty() {
            return Err("Actual scheduled turns still need terminal cleanup".into());
        }
        self.store.close().map_err(|e| e.to_string())
    }
}
fn space(unit: u16) -> bool {
    matches!(unit,0x09..=0x0d|0x20|0xa0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff)
}
pub(crate) fn quiet_summary(text: &str) -> Result<Option<String>> {
    let units = jsjson::to_utf16(text);
    let start = units
        .iter()
        .position(|u| !space(*u) && *u != b'*' as u16 && *u != b'_' as u16)
        .unwrap_or(units.len());
    let tail = &units[start..];
    if tail.len() < 6
        || !tail[..6]
            .iter()
            .zip("(pass)".bytes())
            .all(|(a, b)| *a == b as u16 || *a == (b.to_ascii_uppercase() as u16))
    {
        return Ok(None);
    }
    let rest = &tail[6..];
    let end = rest
        .iter()
        .position(|u| matches!(u, 0x0a | 0x0d | 0x2028 | 0x2029))
        .unwrap_or(rest.len());
    let line = &rest[..end];
    let begin = line
        .iter()
        .position(|u| !space(*u) && *u != b'*' as u16 && *u != b'_' as u16)
        .unwrap_or(line.len());
    let mut line = &line[begin..];
    while line.last().is_some_and(|u| space(*u)) {
        line = &line[..line.len() - 1];
    }
    let mut result = line.to_vec();
    if line.len() > 80 {
        let cut = &line[..79];
        let mut word = cut.len();
        if let Some(at) = cut.iter().rposition(|u| space(*u)) {
            word = at;
            while word > 0 && space(cut[word - 1]) {
                word -= 1;
            }
        }
        let mut selected = if word >= 40 { &cut[..word] } else { cut };
        while selected.last().is_some_and(|u| space(*u)) {
            selected = &selected[..selected.len() - 1];
        }
        result = selected.to_vec();
        result.push(0x2026);
    }
    String::from_utf16(&result)
        .map(Some)
        .map_err(|_| "Quiet summary needs a lossless UTF-16 storage boundary".into())
}

// Node summaryTitle uses JS whitespace and UTF-16 shortTitle. A split surrogate
// cannot be represented by this wire's String, so refuse naming in that case.
pub(crate) fn quiet_title(summary: &str) -> Option<String> {
    let trimmed = summary.trim_matches(|c: char| {
        let mut units = [0; 2];
        let encoded = c.encode_utf16(&mut units);
        encoded.len() == 1 && space(encoded[0])
    });
    let line = trimmed
        .split('\n')
        .next()
        .unwrap_or("")
        .trim_matches(|c: char| {
            let mut units = [0; 2];
            let encoded = c.encode_utf16(&mut units);
            encoded.len() == 1 && space(encoded[0])
        });
    if line.is_empty() {
        return None;
    }
    let units = line.encode_utf16().collect::<Vec<_>>();
    if units.len() <= 60 {
        return Some(line.into());
    }
    Some(format!("{}…", String::from_utf16(&units[..57]).ok()?))
}
