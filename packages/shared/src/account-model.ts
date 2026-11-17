import type { ModelProvider } from "./model.js";

export type ProviderAccount = {
  missing?: boolean;
  id: string;
  provider: ModelProvider;
  label: string;
  state: "unknown" | "ready" | "signed-out" | "signing-in" | "error";
  email?: string;
  plan?: string;
  message?: string;
  signInUrl?: string;
  /** When the account hit its plan's usage limit in a Chat: the time it can be used again (ISO). Project accounts only. */
  limitedUntil?: string;
};
export type AccountsSnapshot = { providers: { provider: ModelProvider; installed?: boolean; selectedId: string; accounts: ProviderAccount[] }[] };

export type ProjectAccountScope = {
  key: string;
  name: string;
  kind: "project" | "link";
  projects: { id: string; path: string; name: string }[];
  chatsHome?: true;
};
export type ProjectAccountsSnapshot = {
  scopeKey: string;
  providers: { provider: ModelProvider; accountId: string | null; effectiveId: string; defaultId: string; accounts: ProviderAccount[] }[];
};
