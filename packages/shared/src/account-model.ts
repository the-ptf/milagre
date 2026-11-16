import type { ModelProvider, ProviderAccount } from "./model.js";

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
