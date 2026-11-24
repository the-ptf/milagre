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

// Agents people add on purpose: they show only once their CLI is known to be installed, never while the status loads.
const OPT_IN = new Set(["pi"]);

/**
 * The provider tabs the model picker shows: every provider whose CLI is installed, plus the ones in `keep` (the
 * Chat's own and the open tab) so a Chat on a missing one still has its tab and notice. An agent installed later
 * (Accounts settings or by hand) appears once the status is checked again. Until it is known, every provider shows,
 * except an opt-in one (Pi), which waits for its status.
 */
export const pickerProviders = (status, ...keep) =>
  PROVIDERS.filter((provider) => {
    if (keep.includes(provider)) return true;
    const state = status?.[provider]?.state;
    return OPT_IN.has(provider) ? Boolean(state) && state !== "missing" : state !== "missing";
  });

/** The provider a new Chat starts on: the saved default, unless its CLI is missing on this computer, then the first one there. */
export function startingProvider(saved, status) {
  if (status?.[saved]?.state !== "missing") return saved;
  return pickerProviders(status)[0] ?? saved;
}

/** What the picker offers to install instead of a tab: opt-in agents whose CLI is missing on this computer. */
export const installableProviders = (status) => PROVIDERS.filter((provider) => OPT_IN.has(provider) && status?.[provider]?.state === "missing");

/** The install card for an opt-in agent, the same on desktop and phone. */
export const INSTALL_OFFERS = Object.freeze({
  pi: Object.freeze({
    title: "Run more models with Pi",
    detail: "Pi runs your local Ollama models and the providers you connect to it: OpenRouter, Groq, xAI, DeepSeek, Mistral and more.",
    command: "npm install -g @earendil-works/pi-coding-agent",
    after: "Then connect a provider with pi auth login <provider> in a terminal, or start Ollama.",
  }),
});

/** Public account categories shared by desktop and mobile. Unknown plans get no badge. */
export function accountType(plan) {
  const value = typeof plan === "string" ? plan.trim().toLowerCase() : "";
  if (["business", "enterprise", "self_serve_business", "self_serve_business_polite"].includes(value)) return "Business";
  if (value === "team") return "Team";
  if (["free", "plus", "pro", "max", "go", "personal"].includes(value)) return "Personal";
  return null;
}
