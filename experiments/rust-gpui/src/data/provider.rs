//! The agent a Chat runs on: `ModelProvider` in `packages/shared/src/model.ts`, ordered and named as
//! `packages/shared/src/providers.mjs` (through `logic::identity::providers`).

use gpui::Rgba;

use crate::logic::identity::providers::{provider_from_id, provider_id, provider_name};
use crate::theme::hex;

/// `ModelProvider`: `"codex" | "claude" | "antigravity" | "kiro"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Provider {
    Codex,
    Claude,
    Antigravity,
    Kiro,
}

impl Provider {
    /// Picker order, the order every list of providers uses (`PROVIDERS` in `providers.mjs`).
    pub const ALL: [Provider; 4] = [Provider::Codex, Provider::Claude, Provider::Antigravity, Provider::Kiro];

    /// The id the wire uses (`"claude"`).
    pub fn id(self) -> &'static str {
        provider_id(self)
    }

    /// The provider an id names; `None` for one this build does not know.
    pub fn from_id(id: &str) -> Option<Provider> {
        provider_from_id(id)
    }

    /// What a saved Chat's `provider` means: absent (a Chat saved before providers were recorded) or unknown is
    /// Claude, as the TypeScript reads it.
    pub fn of_session(id: Option<&str>) -> Provider {
        id.and_then(Provider::from_id).unwrap_or(Provider::Claude)
    }

    /// The name the UI shows (`PROVIDER_NAMES`).
    pub fn name(self) -> &'static str {
        provider_name(Some(self.id()))
    }

    /// The provider's identity colour (DESIGN.md: identity colours keep their meaning everywhere): the
    /// mark's fill, or the middle of its gradient.
    pub fn brand_color(self) -> Rgba {
        match self {
            Provider::Claude => hex("#d97757"),
            Provider::Codex => hex("#7a9dff"),
            Provider::Antigravity => hex("#3186ff"),
            Provider::Kiro => hex("#9046ff"),
        }
    }
}
