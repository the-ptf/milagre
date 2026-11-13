//! Typed writes for one configured Claude connection. No raw RPC escape hatch.
use super::*;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendTarget {
    Existing(u64),
    NewProjectChat,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PermissionMode {
    #[default]
    Ask,
    Auto,
    Full,
}
impl PermissionMode {
    fn wire(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Auto => "auto",
            Self::Full => "full",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PermissionDecision {
    AllowOnce,
    AllowForChat,
    Deny,
}
impl PermissionDecision {
    fn wire(self) -> &'static str {
        match self {
            Self::AllowOnce => "allow",
            Self::AllowForChat => "allow-for-chat",
            Self::Deny => "deny",
        }
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ReplyStyle {
    #[default]
    Concise,
    Normal,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SendOptions {
    pub permission_mode: PermissionMode,
    pub effort: Option<String>,
    pub replies: ReplyStyle,
    pub tldr_enabled: bool,
    pub ultracode: bool,
    pub fast_mode: bool,
    /// Queue on an active turn rather than attempting steering.
    pub queue: bool,
}
impl Default for SendOptions {
    fn default() -> Self {
        Self {
            permission_mode: PermissionMode::Ask,
            effort: None,
            replies: ReplyStyle::Concise,
            tldr_enabled: true,
            ultracode: false,
            fast_mode: false,
            queue: false,
        }
    }
}
/// Plain question choices/free text. No secret, bug-report or attached-image API.
pub type QuestionAnswers = BTreeMap<String, Vec<String>>;

/// Weak capability for a specific Client, selected account and model. It never
/// connects, replays, or keeps a dropped Client alive while waiting for a receipt.
#[derive(Clone)]
pub struct ChatActions {
    handle: Weak<Handle>,
    provider: &'static str,
    model: String,
}
impl Client {
    pub(crate) fn owned_actions_for(
        &self,
        authority: &Arc<Authority>,
        model: &str,
    ) -> Result<ChatActions> {
        if self.handle.stop.load(Ordering::Acquire) {
            return Err(Error::Disconnected);
        }
        if !Weak::ptr_eq(&self.handle.authority, &Arc::downgrade(authority)) {
            return Err(Error::InvalidScope);
        }
        Ok(ChatActions {
            handle: Arc::downgrade(&self.handle),
            provider: "claude",
            model: model.to_owned(),
        })
    }
    #[cfg(feature = "installed-owner")]
    pub(crate) fn installed_actions_for(
        &self,
        authority: &Arc<Authority>,
        provider: &str,
        model: &str,
    ) -> Result<ChatActions> {
        let provider = match provider {
            "claude" => "claude",
            "codex" => "codex",
            "antigravity" => "antigravity",
            "kiro" => "kiro",
            _ => {
                return Err(input(
                    "provider",
                    "Expected claude, codex, antigravity or kiro",
                ))
            }
        };
        if model.is_empty() || model.len() > 128 || model.contains('\0') {
            return Err(input("model", "Expected 1..=128 UTF-8 bytes without NUL"));
        }
        let mut actions = self.owned_actions_for(authority, model)?;
        actions.provider = provider;
        Ok(actions)
    }
}
fn identifier(value: &str, field: &'static str) -> Result<()> {
    if value.is_empty() || value.len() > 128 || value.contains('\0') {
        return Err(input(field, "Expected 1..=128 UTF-8 bytes without NUL"));
    }
    Ok(())
}
impl ChatActions {
    fn client(&self) -> Result<Client> {
        let handle = self.handle.upgrade().ok_or(Error::Disconnected)?;
        if handle.stop.load(Ordering::Acquire) {
            return Err(Error::Disconnected);
        }
        if !handle.opened_view.load(Ordering::Acquire) {
            return Err(Error::ViewNotOpened);
        }
        Ok(Client { handle })
    }
    fn key(client: &Client, chat: u64) -> Result<String> {
        ScriptedActions::chat(chat)?;
        Ok(format!("{}#{chat}", client.handle.project))
    }
    fn enqueue(
        client: Client,
        method: &'static str,
        args: Value,
    ) -> Result<reply::Receiver<Value>> {
        if args.to_string().len() > 256 * 1024 {
            return Err(input("payload", "Encoded action arguments exceed 256 KiB"));
        }
        let (reply, wait) = reply::channel();
        client.submit(Kind::Call {
            method,
            args,
            reply,
        })?;
        Ok(wait)
    }
    pub async fn send(
        &self,
        target: SendTarget,
        text: &str,
        client_message_id: &str,
        options: SendOptions,
    ) -> Result<Value> {
        let client = self.client()?;
        if text.is_empty() || text.len() > 64 * 1024 {
            return Err(input("text", "Expected 1..=65536 UTF-8 bytes"));
        }
        identifier(client_message_id, "client_message_id")?;
        if options.effort.as_ref().is_some_and(|effort| {
            effort.is_empty()
                || effort.len() > 32
                || !effort
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
        }) {
            return Err(input(
                "effort",
                "Expected 1..=32 lowercase ASCII letters, digits, hyphens or underscores",
            ));
        }
        let mut request = json!({"projectPath":client.handle.project,"worktreeId":1,"provider":self.provider,"model":self.model,"body":text,"clientMessageId":client_message_id,"permissionMode":options.permission_mode.wire(),"replies":if options.replies == ReplyStyle::Concise { "concise" } else { "normal" },"tldrEnabled":options.tldr_enabled,"ultracode":options.ultracode,"fastMode":options.fast_mode});
        if let SendTarget::Existing(chat) = target {
            ScriptedActions::chat(chat)?;
            request["sessionId"] = json!(chat);
        }
        if let Some(effort) = options.effort {
            request["effort"] = json!(effort);
        }
        if options.queue {
            request["delivery"] = json!("queue");
        }
        Self::enqueue(client, "chat:send", json!([request]))?.await
    }
    pub async fn send_status(&self, client_message_id: &str) -> Result<Value> {
        let client = self.client()?;
        identifier(client_message_id, "client_message_id")?;
        let args = json!([client.handle.project, client_message_id]);
        Self::enqueue(client, "chat:send-status", args)?.await
    }
    pub async fn interrupt(&self, chat: u64) -> Result<Value> {
        let client = self.client()?;
        let key = Self::key(&client, chat)?;
        Self::enqueue(client, "agent:interrupt", json!([key]))?.await
    }
    pub async fn respond_permission(
        &self,
        chat: u64,
        request_id: &str,
        decision: PermissionDecision,
    ) -> Result<Value> {
        let client = self.client()?;
        let key = Self::key(&client, chat)?;
        identifier(request_id, "request_id")?;
        Self::enqueue(
            client,
            "agent:respond-permission",
            json!([{"chatId":key,"requestId":request_id,"decision":decision.wire()}]),
        )?
        .await
    }
    pub async fn answer_question(
        &self,
        chat: u64,
        request_id: &str,
        answers: Option<QuestionAnswers>,
        summary: Option<&str>,
    ) -> Result<Value> {
        let client = self.client()?;
        let key = Self::key(&client, chat)?;
        identifier(request_id, "request_id")?;
        if summary.is_some_and(|value| value.len() > 64 * 1024) {
            return Err(input("summary", "Summary exceeds 64 KiB"));
        }
        if let Some(answers) = &answers {
            if answers.len() > 20 {
                return Err(input("answers", "At most 20 questions are admitted"));
            }
            for (question, choices) in answers {
                identifier(question, "question_id")?;
                if choices.len() > 20 || choices.iter().any(|choice| choice.len() > 10_000) {
                    return Err(input(
                        "answers",
                        "At most 20 answers of 10000 UTF-8 bytes per question",
                    ));
                }
            }
        }
        Self::enqueue(
            client,
            "agent:answer-question",
            json!([{"chatId":key,"requestId":request_id,"answers":answers,"summary":summary}]),
        )?
        .await
    }
    pub async fn set_permission_mode(&self, chat: u64, mode: PermissionMode) -> Result<Value> {
        let client = self.client()?;
        let key = Self::key(&client, chat)?;
        Self::enqueue(
            client,
            "agent:set-permission-mode",
            json!([{"chatId":key,"mode":mode.wire()}]),
        )?
        .await
    }
    async fn queued(&self, chat: u64, queued_id: &str, method: &'static str) -> Result<Value> {
        let client = self.client()?;
        let key = Self::key(&client, chat)?;
        identifier(queued_id, "queued_id")?;
        Self::enqueue(client, method, json!([key, queued_id]))?.await
    }
    pub async fn send_queued_now(&self, chat: u64, queued_id: &str) -> Result<Value> {
        self.queued(chat, queued_id, "chat:queue-send").await
    }
    pub async fn remove_queued(&self, chat: u64, queued_id: &str) -> Result<Value> {
        self.queued(chat, queued_id, "chat:queue-remove").await
    }
    pub async fn mark_unread(&self, chat: u64, unread: bool) -> Result<Value> {
        let client = self.client()?;
        ScriptedActions::chat(chat)?;
        let args = json!([client.handle.project, chat, {"unread":unread}]);
        Self::enqueue(client, "chat:patch", args)?.await
    }
}
