/** Picker order and the names used by every client and CLI notice. */
export const PROVIDERS = Object.freeze(["codex", "claude", "antigravity", "kiro", "pi"]);
const names = {
  codex: { name: "Codex", cli: "Codex" },
  claude: { name: "Claude", cli: "Claude Code" },
  antigravity: { name: "Antigravity", cli: "Antigravity" },
  kiro: { name: "Kiro", cli: "Kiro CLI" },
  pi: { name: "Pi", cli: "Pi" },
};
/** The provider id for one saved before a rename: Pi's Chats were Ollama's until Pi ran hosted models too. */
export const currentProvider = (provider) => (provider === "ollama" ? "pi" : provider);

/** The model id for one saved before Pi ran hosted models: `ollama:qwen3` is `pi:ollama/qwen3`. */
export const currentModelId = (model) => (typeof model === "string" && model.startsWith("ollama:") ? `pi:ollama/${model.slice("ollama:".length)}` : model);

/** The same object with each provider key under its current id. */
export const withCurrentProviders = (record) =>
  record && typeof record === "object" && !Array.isArray(record)
    ? Object.fromEntries(Object.entries(record).map(([provider, value]) => [currentProvider(provider), value]))
    : record;

export const providerName = (provider) => (names[provider] ?? names.claude).name;
export const cliName = (provider) => (names[provider] ?? names.claude).cli;

/**
 * The provider tabs the model picker shows: every provider whose CLI is installed, plus the ones in `keep` (the
 * Chat's own and the open tab) so a Chat on a missing one still has its tab and notice. An agent installed later
 * (Accounts settings or by hand) appears once the status is checked again. Until it is known, every provider shows.
 */
export const pickerProviders = (status, ...keep) => PROVIDERS.filter((provider) => keep.includes(provider) || status?.[provider]?.state !== "missing");

/** Public account categories shared by desktop and mobile. Unknown plans get no badge. */
export function accountType(plan) {
  const value = typeof plan === "string" ? plan.trim().toLowerCase() : "";
  if (["business", "enterprise", "self_serve_business", "self_serve_business_polite"].includes(value)) return "Business";
  if (value === "team") return "Team";
  if (["free", "plus", "pro", "max", "go", "personal"].includes(value)) return "Personal";
  return null;
}
