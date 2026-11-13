//! Private service operations for the exclusive composed actor. No native launcher
//! or authority callback lives here; the actor must retain this owner until joined Ack.
use super::*;
use milagre_owner_store::chat_host::{ProviderError, ProviderErrorKind, ProviderEvent};
use milagre_owner_store::jsjson::RawJson;

#[allow(dead_code)]
impl ServiceOwner {
    pub(crate) fn for_composition(scenario: Scenario) -> Result<Self> {
        let gate = Arc::new(Gate { scope: Arc::new(()), active: AtomicBool::new(true), cancellation: AtomicU64::new(0) });
        let mut owner = Self::create(scenario, gate)?;
        owner.native_connection = true; // Diagnostic only; never a cleanup/launch grant.
        Ok(owner)
    }
    pub(crate) fn native_start(&mut self, id: &AdmissionId) -> Result<BoundStart> {
        let evidence = self.validate(id)?;
        let capture = self.capture.as_mut().ok_or(Error::Revoked)?;
        let directories = [capture.descriptor.duplicate()?, self.home.duplicate()?, self.tmp.duplicate()?];
        let prompt = capture.prompt.take().ok_or(Error::Revoked)?;
        Ok(BoundStart { prompt, directories, evidence })
    }
    pub(crate) fn invalidate_native_admission(&mut self) -> Result<()> {
        // The actor invalidates native Control before calling this. Do not synthesize
        // a StartFailed for a running native turn; its observed lifecycle settles it.
        self.gate.cancel();
        self.seen_cancel = self.gate.cancellation.load(Ordering::Acquire);
        self.bump()
    }
    pub(crate) fn native_signals(&mut self, id: &AdmissionId, signals: Vec<Signal>, now: i64) -> std::result::Result<(), DeliveryError> {
        if self.host.is_none() {
            return Err(Error::Closed.into());
        }
        let capture = self.capture.as_ref().filter(|c| c.id == *id).ok_or(Error::Revoked)?;
        if signals.len() > 4 {
            return Err(Error::Bounds.into());
        }
        let (chat, turn) = (capture.chat.clone(), capture.turn);
        if chat.len() > 4352 {
            return Err(Error::Bounds.into());
        }
        // Include JSON escaping when reserving this closed event batch. The extra
        // 512 bytes/event covers its fixed fields, native identifier and numeric turn.
        let encoded_chat = serde_json::to_vec(&chat).map_err(|_| Error::Request)?.len();
        if signals.len().checked_mul(encoded_chat + 512).is_none_or(|bytes| bytes > 64 * 1024) {
            return Err(Error::Bounds.into());
        }
        // No arbitrary JSON/text enters this interface.
        for signal in &signals {
            if let Signal::Started(value) = signal {
                if value.len() != 72 || !value.starts_with("fixture-") || !value[8..].bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err(Error::Request.into());
                }
            }
        }
        let ending =
            signals.iter().any(|signal| matches!(signal, Signal::Completed | Signal::Cancelled | Signal::Failed | Signal::StartFailed));
        let active = self.host.as_ref().is_some_and(|h| h.active_turn(&chat) == Some(turn));
        let failure = || ProviderError::new(ProviderErrorKind::Unavailable, "The fixed native fixture ended without a successful turn.");
        let mut events = Vec::with_capacity(signals.len());
        for signal in signals {
            if !active && !matches!(signal, Signal::Exited) {
                if matches!(signal, Signal::StartFailed) {
                    continue;
                } // Validation may already have failed this exact pending turn.
                return Err(DeliveryError::Rejected(Error::Revoked));
            }
            let event = match signal {
                Signal::Started(native_turn) => {
                    ProviderEvent::Started { chat: chat.clone(), turn, result: RawJson(json!({"turnId":native_turn,"steered":false})) }
                }
                Signal::StartFailed => ProviderEvent::StartFailed { chat: chat.clone(), turn, error: failure() },
                Signal::Exited => ProviderEvent::Exited { chat: chat.clone(), turn, error: failure() },
                signal => ProviderEvent::Agent {
                    chat: chat.clone(),
                    turn,
                    event: RawJson(match signal {
                        Signal::TurnStarted => json!({"type":"turn-started"}),
                        Signal::Completed => json!({"type":"turn-completed"}),
                        Signal::Cancelled => json!({"type":"turn-cancelled"}),
                        Signal::Failed => json!({"type":"turn-failed","message":"The fixed native fixture failed."}),
                        _ => unreachable!("closed signal variants"),
                    }),
                },
            };
            events.push(event);
        }
        let mut mailbox = self.mailbox.lock().map_err(|_| Error::Worker)?;
        if mailbox.closed || !mailbox.events.is_empty() {
            return Err(Error::Closed.into());
        }
        mailbox.events = events;
        drop(mailbox);
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.host.as_mut().expect("pre-enqueue host").tick(now))) {
            Ok(errors) if errors.is_empty() && (!ending || self.host.as_ref().unwrap().active_turn(&chat) != Some(turn)) => {
                if ending {
                    self.host.as_mut().unwrap().states.flush(None).map_err(|_| DeliveryError::Retained(Error::Owner))?;
                }
                Ok(())
            }
            Ok(_) => Err(DeliveryError::Retained(Error::Owner)),
            Err(_) => Err(DeliveryError::Retained(Error::Worker)),
        }
    }
    pub(crate) fn native_started(&mut self, id: &AdmissionId, native_turn: String, now: i64) -> std::result::Result<(), DeliveryError> {
        if !self.native_active(id)? {
            return Err(Error::Revoked.into());
        }
        self.native_signals(id, vec![Signal::Started(native_turn), Signal::TurnStarted], now)
    }
    pub(crate) fn native_notices(&mut self) -> Result<Vec<Notice>> {
        match self.apply(Command::Notices)? {
            Reply::Notices(notices) => Ok(notices),
            _ => Err(Error::Worker),
        }
    }
    pub(crate) fn native_locks(&mut self) -> Result<Locks> {
        match self.apply(Command::Locks)? {
            Reply::Locks(locks) => Ok(locks),
            _ => Err(Error::Worker),
        }
    }
    pub(crate) fn native_state(&mut self) -> Result<serde_json::Value> {
        if self.project_closed {
            return Err(Error::Closed);
        }
        let project = self.project.clone();
        self.host()?.states.flush(None).map_err(|_| Error::Owner)?;
        self.host()?.states.whole_state(&project).map_err(|_| Error::Owner)
    }
    pub(crate) fn block_release_for_test(&mut self) -> Result<()> {
        self.host()?.states.flush(None).map_err(|_| Error::Owner)?;
        std::fs::write(self.project.join(".milagre/runtime.lock/fixed-extra-entry"), b"fixed composed release failure")
            .map_err(|_| Error::Storage)
    }
    pub(crate) fn record_retained_roots(&self) {
        let roots = [self.arena.as_ref().unwrap(), self.account_root.as_ref().unwrap()];
        let records: Vec<_> = roots.iter().map(|r| json!({"path":r.path,"device":r.identity().0,"inode":r.identity().1})).collect();
        println!("SERVICE_NATIVE_RETAINED_ROOTS {}", serde_json::to_string(&records).unwrap());
    }
    pub(crate) fn native_active(&self, id: &AdmissionId) -> Result<bool> {
        let capture = self.capture.as_ref().filter(|c| c.id == *id).ok_or(Error::Revoked)?;
        Ok(self.host.as_ref().is_some_and(|h| h.active_turn(&capture.chat) == Some(capture.turn)))
    }
}
