/** Picker order and the names used by every client and CLI notice. */
export const PROVIDERS = Object.freeze(["codex", "claude", "antigravity", "kiro"]);
const names = {
  codex: { name: "Codex", cli: "Codex" },
  claude: { name: "Claude", cli: "Claude Code" },
  antigravity: { name: "Antigravity", cli: "Antigravity" },
  kiro: { name: "Kiro", cli: "Kiro CLI" },
};
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
