/**
 * What each provider's agent can do, so behavior asks for a capability instead of a provider name. Every flag
 * says what Milagre does when it is false. Per-model options (efforts, fast mode, Ultracode) live with the models.
 */
const flags = (values) => Object.freeze(values);

/** A provider Milagre doesn't know gets the fallback of every flag. */
export const DEFAULT_CAPABILITIES = flags({
  // false: a message sent while a turn runs waits for that turn to end and starts the next one (a queue).
  steer: false,
  // false: no Compact action; the provider's own /compact is never sent.
  compact: false,
  // false: every subagent ends with the turn that started it; none wakes the chat later with a turn of its own.
  backgroundSubagents: false,
  // false: a subagent whose outcome was lost (a quit or crash mid-run) stays unknown; nothing is read back from the provider's history.
  subagentRecovery: false,
  // false: the provider can't host an analysis-only advisor; advisors pick another provider.
  advisor: false,
  // false: the user installs the CLI; Milagre only offers an update once it is outdated.
  managedInstall: false,
  // false: the only Account is the one the CLI is signed in to; Milagre adds none and signs none in.
  addAccounts: false,
});

const table = {
  // Claude Code steers at the next tool boundary, takes /compact, and runs background Agents.
  claude: flags({ ...DEFAULT_CAPABILITIES, steer: true, compact: true, backgroundSubagents: true, advisor: true, addAccounts: true }),
  // Codex steers through turn/steer; its children are read back from its rollout history.
  codex: flags({ ...DEFAULT_CAPABILITIES, steer: true, subagentRecovery: true, advisor: true, addAccounts: true }),
  // ACP has no steering; Antigravity's children are read back from its transcripts, and Milagre installs its CLI.
  antigravity: flags({ ...DEFAULT_CAPABILITIES, subagentRecovery: true, managedInstall: true, addAccounts: true }),
  // ACP has no steering; Kiro's children aren't read back yet. The user installs kiro-cli and signs in with it
  // (an Identity Center sign-in needs the organization's start URL), so its one Account is kiro-cli's.
  kiro: flags({ ...DEFAULT_CAPABILITIES }),
};

/** The provider's capabilities, frozen; an unknown provider gets DEFAULT_CAPABILITIES. */
export function providerCapabilities(provider) {
  return typeof provider === "string" && Object.hasOwn(table, provider) ? table[provider] : DEFAULT_CAPABILITIES;
}
