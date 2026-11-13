//! What each provider's agent can do, so behaviour asks for a capability instead of a provider name
//! (`packages/shared/src/provider-capabilities.mjs`). Every flag says what Milagre does when it is false.

/// A provider Milagre doesn't know gets the fallback of every flag.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Capabilities {
    /// false: a message sent while a turn runs waits for that turn to end and starts the next one (a queue).
    pub steer: bool,
    /// false: no Compact action; the provider's own /compact is never sent.
    pub compact: bool,
    /// false: every subagent ends with the turn that started it; none wakes the chat later with a turn of its own.
    pub background_subagents: bool,
    /// false: a subagent whose outcome was lost (a quit or crash mid-run) stays unknown; nothing is read back from
    /// the provider's history.
    pub subagent_recovery: bool,
    /// false: the provider can't host an analysis-only advisor; advisors pick another provider.
    pub advisor: bool,
    /// false: the user installs the CLI; Milagre only offers an update once it is outdated.
    pub managed_install: bool,
    /// false: the only Account is the one the CLI is signed in to; Milagre adds none and signs none in.
    pub add_accounts: bool,
}

pub const DEFAULT_CAPABILITIES: Capabilities = Capabilities {
    steer: false,
    compact: false,
    background_subagents: false,
    subagent_recovery: false,
    advisor: false,
    managed_install: false,
    add_accounts: false,
};

/// Claude Code steers at the next tool boundary, takes /compact, and runs background Agents.
const CLAUDE: Capabilities =
    Capabilities { steer: true, compact: true, background_subagents: true, advisor: true, add_accounts: true, ..DEFAULT_CAPABILITIES };
/// Codex steers through turn/steer; its children are read back from its rollout history.
const CODEX: Capabilities =
    Capabilities { steer: true, subagent_recovery: true, advisor: true, add_accounts: true, ..DEFAULT_CAPABILITIES };
/// ACP has no steering; Antigravity's children are read back from its transcripts, and Milagre installs its CLI.
const ANTIGRAVITY: Capabilities =
    Capabilities { subagent_recovery: true, managed_install: true, add_accounts: true, ..DEFAULT_CAPABILITIES };
/// ACP has no steering; Kiro's children aren't read back yet. The user installs kiro-cli and signs in with it, so
/// its one Account is kiro-cli's.
const KIRO: Capabilities = DEFAULT_CAPABILITIES;

/// The provider's capabilities; an unknown provider (or none) gets [`DEFAULT_CAPABILITIES`].
pub fn provider_capabilities(provider: Option<&str>) -> Capabilities {
    match provider {
        Some("claude") => CLAUDE,
        Some("codex") => CODEX,
        Some("antigravity") => ANTIGRAVITY,
        Some("kiro") => KIRO,
        _ => DEFAULT_CAPABILITIES,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logic::identity::providers::PROVIDERS;

    #[test]
    fn an_unknown_provider_gets_the_conservative_defaults() {
        for provider in [Some("gemini"), Some(""), None, Some("toString"), Some("__proto__"), Some("Claude")] {
            assert_eq!(provider_capabilities(provider), DEFAULT_CAPABILITIES, "{provider:?}");
        }
        assert_eq!(
            DEFAULT_CAPABILITIES,
            Capabilities {
                steer: false,
                compact: false,
                background_subagents: false,
                subagent_recovery: false,
                advisor: false,
                managed_install: false,
                add_accounts: false,
            }
        );
    }

    #[test]
    fn the_flags_match_what_each_providers_agent_does() {
        let flags = |provider: &str| {
            let c = provider_capabilities(Some(provider));
            [c.steer, c.compact, c.background_subagents, c.subagent_recovery, c.advisor, c.managed_install, c.add_accounts]
        };
        // steer, compact, backgroundSubagents, subagentRecovery, advisor, managedInstall, addAccounts
        assert_eq!(flags("codex"), [true, false, false, true, true, false, true]);
        assert_eq!(flags("claude"), [true, true, true, false, true, false, true]);
        assert_eq!(flags("antigravity"), [false, false, false, true, false, true, true]);
        assert_eq!(flags("kiro"), [false, false, false, false, false, false, false]);
        for provider in PROVIDERS {
            assert!(PROVIDERS.contains(&provider));
        }
    }
}
