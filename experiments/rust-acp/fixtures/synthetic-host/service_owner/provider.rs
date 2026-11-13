use super::{Error, Result};
use milagre_owner_store::{
    chat_host::{AnswerId, Provider, ProviderError, ProviderErrorKind, ProviderEvent, TurnId},
    jsjson::RawJson,
};
use std::sync::{Arc, Mutex};

pub(super) struct Start {
    pub(super) turn: TurnId,
    pub(super) request: RawJson,
}
#[derive(Default)]
pub(super) struct Mailbox {
    pub(super) start: Option<Start>,
    pub(super) events: Vec<ProviderEvent>,
    pub(super) closed: bool,
}
pub(super) type SharedMailbox = Arc<Mutex<Mailbox>>;
pub(super) struct CaptureProvider {
    pub(super) mailbox: SharedMailbox,
}
fn refused() -> ProviderError {
    ProviderError::new(ProviderErrorKind::Refused, "The fixed synthetic fixture refused this provider operation.")
}
impl Provider for CaptureProvider {
    fn name(&self) -> &str {
        "kiro"
    }
    fn start_turn(&mut self, turn: TurnId, request: &RawJson) -> std::result::Result<(), ProviderError> {
        let mut mailbox = self.mailbox.lock().map_err(|_| refused())?;
        if mailbox.closed || mailbox.start.is_some() || validate(request).is_err() {
            return Err(refused());
        }
        mailbox.start = Some(Start { turn, request: request.clone() });
        Ok(())
    }
    fn interrupt(&mut self, _: &str, _: TurnId) -> std::result::Result<(), ProviderError> {
        Ok(())
    }
    fn close_chat(&mut self, _: &str, _: TurnId) -> std::result::Result<(), ProviderError> {
        Ok(())
    }
    fn shutdown(&mut self) {
        if let Ok(mut mailbox) = self.mailbox.lock() {
            mailbox.closed = true;
        }
    }
    fn take_events(&mut self) -> Vec<ProviderEvent> {
        self.mailbox.lock().map(|mut m| std::mem::take(&mut m.events)).unwrap_or_default()
    }
    fn respond_permission(&mut self, _: &str, _: TurnId, _: AnswerId, _: &str, _: &str) -> std::result::Result<(), ProviderError> {
        Err(refused())
    }
    fn answer_question(&mut self, _: &str, _: TurnId, _: AnswerId, _: &str, _: &RawJson) -> std::result::Result<(), ProviderError> {
        Err(refused())
    }
}
fn validate(request: &RawJson) -> Result<()> {
    let value = &request.0;
    let object = value.as_object().ok_or(Error::Request)?;
    let allowed = [
        "provider",
        "model",
        "permissionMode",
        "effort",
        "ultracode",
        "fastMode",
        "replies",
        "tldrEnabled",
        "prompt",
        "chatId",
        "cwd",
        "images",
        "resumeId",
    ];
    if object.keys().any(|key| !allowed.contains(&key.as_str()))
        || value["provider"] != "kiro"
        || value["model"] != "kiro:auto"
        || value["permissionMode"] != "ask"
        || value.get("effort").is_some_and(|v| !v.is_null())
        || value.get("resumeId").is_some_and(|v| !v.is_null())
        || value.get("images").is_some_and(|v| v.as_array().is_none_or(|v| !v.is_empty()))
        || !value["prompt"].as_str().is_some_and(|v| v.len() <= 64 * 1024)
        || !value["cwd"].as_str().is_some_and(|v| v.len() <= 4096)
        || !value["chatId"].as_str().is_some_and(|v| v.len() <= 4352)
    {
        return Err(Error::Request);
    }
    Ok(())
}
pub(super) fn reject(mailbox: &SharedMailbox, chat: &str, turn: TurnId) -> Result<()> {
    let mut mailbox = mailbox.lock().map_err(|_| Error::Worker)?;
    if !mailbox.events.is_empty() {
        return Err(Error::Bounds);
    }
    mailbox.events.push(ProviderEvent::StartFailed { chat: chat.into(), turn, error: refused() });
    Ok(())
}
