//! The handoff brief's model: a separate, nonblocking boundary, not `Provider` (Node asks the left provider's small
//! model in a one-shot call, `createHandoverModels`, not the Chat's session). Contract agreed with the runtime:
//!
//! - **One brief per handoff.** A [`BriefId`] belongs to one Chat and the turn its handoff reserved (its generation).
//! - **`ask` only enqueues.** `Err` refuses at once: [`BriefRefused::NoModel`] or [`BriefRefused::AtCapacity`], both
//!   answered with the minimal brief (Node's path with no model), nothing new for the user.
//! - **`cancel` is advisory.** It never claims the model's work is undone; whatever comes back later for a cancelled,
//!   settled or timed-out id is dropped.
//! - **Typed text.** [`BriefRequest`] carries the Chat and the provider as strict identities (an unpaired surrogate is
//!   refused, never replaced) and the system prompt and transcript as free text, decoded once, lossy (U+FFFD). Adapters
//!   pass them on as they are. A reply is raw text, encoded once where it enters the host.
//! - **Bounded.** A request is at most [`crate::handover::MAX_BRIEF_PROMPT_BYTES`] of prompt; a reply over
//!   [`MAX_BRIEF_REPLY_BYTES`] counts as failed (a deliberate deviation: Node has no cap); at most [`MAX_BRIEFS`] are
//!   out at once; each has [`crate::handover::BRIEF_TIMEOUT_MS`] (the host's clock) before it counts as failed.

use crate::chat_host::TurnId;
use crate::handover::BriefRequest as Prompt;
use crate::jsjson;
use crate::{Result, StoreError};

/// The longest reply read (UTF-8 bytes); a longer one counts as failed.
pub const MAX_BRIEF_REPLY_BYTES: usize = 64 << 10;
/// Briefs out at once; past it the minimal brief is written at once.
pub const MAX_BRIEFS: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct BriefId(pub u64);

/// What the brief's model is asked. Identities exact; text decoded once (lossy). Never decoded again downstream.
#[derive(Clone, Debug, PartialEq)]
pub struct BriefRequest {
    pub brief: BriefId,
    pub chat: String,
    pub turn: TurnId,
    pub provider: String,
    pub catch_up: bool,
    pub system: String,
    pub prompt: String,
}

const PROVIDERS: [&str; 4] = ["claude", "codex", "antigravity", "kiro"];

impl BriefRequest {
    /// The outbound request from the owner's (jsjson-encoded) values: `chat` and `provider` strictly decoded (and the
    /// provider one Milagre knows), the prompt's text decoded lossy.
    pub fn outbound(
        brief: BriefId,
        chat: &str,
        turn: TurnId,
        provider: &str,
        catch_up: bool,
        prompt: &Prompt,
    ) -> Result<BriefRequest> {
        let strict = |text: &str, what: &str| {
            jsjson::decode_text_strict(text).map_err(|_| {
                StoreError::Invalid(format!(
                    "IDENTITY_REFUSED: the brief's {what} isn't exact text."
                ))
            })
        };
        let chat = strict(chat, "Chat")?;
        let provider = strict(provider, "provider")?;
        if !PROVIDERS.contains(&provider.as_str()) {
            return Err(StoreError::Invalid(format!(
                "There's no brief model for the provider {provider}."
            )));
        }
        let request = BriefRequest {
            brief,
            chat,
            turn,
            provider,
            catch_up,
            system: jsjson::decode_text_lossy(&prompt.system),
            prompt: jsjson::decode_text_lossy(&prompt.prompt),
        };
        if request.prompt.len() > crate::handover::MAX_BRIEF_PROMPT_BYTES {
            return Err(StoreError::Invalid(
                "The brief's prompt is over its bound; it isn't sent.".into(),
            ));
        }
        Ok(request)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BriefRefused {
    NoModel,
    AtCapacity,
}

#[derive(Clone, Debug, PartialEq)]
pub enum BriefEvent {
    /// The model's reply, raw (as the model wrote it).
    Replied {
        brief: BriefId,
        reply: String,
    },
    Failed {
        brief: BriefId,
    },
}

/// The brief's model, nonblocking: every method returns at once; replies come back through `take_events`.
pub trait BriefModel: Send {
    fn ask(&mut self, request: BriefRequest) -> std::result::Result<(), BriefRefused>;
    fn cancel(&mut self, brief: BriefId);
    fn take_events(&mut self) -> Vec<BriefEvent>;
}

/// A reply as the host reads it: `None` when over the bound, else encoded once (jsjson) for `parse_brief`.
pub fn inbound_reply(reply: &str) -> Option<String> {
    (reply.len() <= MAX_BRIEF_REPLY_BYTES).then(|| jsjson::js_string(reply))
}

/// An isolated, scripted brief model for tests (no model is ever called).
#[cfg(feature = "test-fixtures")]
pub mod fake {
    use std::sync::{Arc, Mutex};

    use super::*;

    #[derive(Default)]
    pub struct FakeState {
        pub asked: Vec<BriefRequest>,
        pub cancelled: Vec<BriefId>,
        pub events: Vec<BriefEvent>,
        /// Refuse every ask with this.
        pub refuse: Option<BriefRefused>,
    }

    #[derive(Clone, Default)]
    pub struct FakeBriefModel {
        pub state: Arc<Mutex<FakeState>>,
    }

    impl FakeBriefModel {
        pub fn reply(&self, brief: BriefId, reply: &str) {
            self.state.lock().unwrap().events.push(BriefEvent::Replied {
                brief,
                reply: reply.into(),
            });
        }

        pub fn fail(&self, brief: BriefId) {
            self.state
                .lock()
                .unwrap()
                .events
                .push(BriefEvent::Failed { brief });
        }

        pub fn asked(&self) -> Vec<BriefRequest> {
            self.state.lock().unwrap().asked.clone()
        }
    }

    impl BriefModel for FakeBriefModel {
        fn ask(&mut self, request: BriefRequest) -> std::result::Result<(), BriefRefused> {
            let mut state = self.state.lock().unwrap();
            if let Some(refused) = state.refuse {
                return Err(refused);
            }
            state.asked.push(request);
            Ok(())
        }

        fn cancel(&mut self, brief: BriefId) {
            self.state.lock().unwrap().cancelled.push(brief);
        }

        fn take_events(&mut self) -> Vec<BriefEvent> {
            std::mem::take(&mut self.state.lock().unwrap().events)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identities_go_out_exact_and_text_lossy_once() {
        let lone = jsjson::from_utf16(&[0x61, 0xD83D]);
        let prompt = Prompt {
            system: "s".into(),
            prompt: format!("p {lone}"),
        };
        let ok =
            BriefRequest::outbound(BriefId(1), "/p#1", TurnId(2), "kiro", false, &prompt).unwrap();
        assert_eq!(ok.prompt, "p a\u{FFFD}");
        assert!(BriefRequest::outbound(
            BriefId(1),
            &format!("/p#1{lone}"),
            TurnId(2),
            "kiro",
            false,
            &prompt
        )
        .is_err());
        assert!(BriefRequest::outbound(
            BriefId(1),
            "/p#1",
            TurnId(2),
            &format!("kiro{lone}"),
            false,
            &prompt
        )
        .is_err());
        assert!(
            BriefRequest::outbound(BriefId(1), "/p#1", TurnId(2), "gpt", false, &prompt).is_err()
        );
        assert!(inbound_reply(&"x".repeat(MAX_BRIEF_REPLY_BYTES + 1)).is_none());
        let encoded = inbound_reply("\u{10FFFE}").unwrap();
        assert_eq!(
            jsjson::utf16_len(&encoded),
            2,
            "a real U+10FFFE stays itself"
        );
    }
}
