export type ProviderCapabilities = Readonly<{
  /** Can steer a running turn; without it a message sent mid-turn waits for the next one. */
  steer: boolean;
  /** Takes a native /compact between turns. */
  compact: boolean;
  /** Subagents can outlive the turn that started them and wake the chat later. */
  backgroundSubagents: boolean;
  /** Lost subagent outcomes can be read back from the provider's own history. */
  subagentRecovery: boolean;
  /** Can host an analysis-only advisor. */
  advisor: boolean;
  /** Milagre installs the CLI itself. */
  managedInstall: boolean;
}>;
export type ProviderCapability = keyof ProviderCapabilities;
export const DEFAULT_CAPABILITIES: ProviderCapabilities;
export function providerCapabilities(provider: string | null | undefined): ProviderCapabilities;
