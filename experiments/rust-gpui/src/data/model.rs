//! Domain types, after `packages/shared/src/model.ts`.

use gpui::Rgba;

use crate::theme::hex;

/// The agent a Chat runs on (`ModelProvider` in `model.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Provider {
    Claude,
    Codex,
    Antigravity,
    Kiro,
}

impl Provider {
    pub const ALL: [Provider; 4] = [Provider::Claude, Provider::Codex, Provider::Antigravity, Provider::Kiro];

    /// The name the UI shows (`PROVIDER_NAMES`).
    pub fn name(self) -> &'static str {
        match self {
            Provider::Claude => "Claude",
            Provider::Codex => "Codex",
            Provider::Antigravity => "Antigravity",
            Provider::Kiro => "Kiro",
        }
    }

    /// The provider's identity colour (DESIGN.md: identity colours keep their meaning everywhere).
    pub fn brand_color(self) -> Rgba {
        match self {
            Provider::Claude => hex("#d97757"),
            Provider::Codex => hex("#7a9dff"),
            Provider::Antigravity => hex("#3186ff"),
            Provider::Kiro => hex("#9046ff"),
        }
    }
}
