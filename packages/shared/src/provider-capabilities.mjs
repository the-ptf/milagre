const flags = (values) => Object.freeze(values);

export const DEFAULT_CAPABILITIES = flags({
  steer: false,
  compact: false,
  backgroundSubagents: false,
  subagentRecovery: false,
  advisor: false,
  managedInstall: false,
  addAccounts: false,
});

const table = {
  claude: flags({ ...DEFAULT_CAPABILITIES, steer: true, compact: true, backgroundSubagents: true, advisor: true, addAccounts: true }),
  codex: flags({ ...DEFAULT_CAPABILITIES, steer: true, subagentRecovery: true, advisor: true, addAccounts: true }),
  antigravity: flags({ ...DEFAULT_CAPABILITIES, subagentRecovery: true, managedInstall: true, addAccounts: true }),
  kiro: flags({ ...DEFAULT_CAPABILITIES }),
  grok: flags({ ...DEFAULT_CAPABILITIES }),
  pi: flags({ ...DEFAULT_CAPABILITIES, steer: true, compact: true }),
};

/** The provider's capabilities, frozen; an unknown provider gets DEFAULT_CAPABILITIES. */
export function providerCapabilities(provider) {
  return typeof provider === "string" && Object.hasOwn(table, provider) ? table[provider] : DEFAULT_CAPABILITIES;
}
