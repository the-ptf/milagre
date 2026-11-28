import { ANTIGRAVITY_AGENT_OPTIONS, ANTIGRAVITY_FAMILY_COPY, antigravityFamilies } from "./antigravity-models.mjs";
import { GROK_AGENT_OPTIONS, grokModels } from "./grok-models.mjs";
import { KIRO_AGENT_OPTIONS, kiroModels } from "./kiro-models.mjs";

function antigravityCatalog() {
  return antigravityFamilies(ANTIGRAVITY_AGENT_OPTIONS).map((family) => {
    const copy = ANTIGRAVITY_FAMILY_COPY[family.id];
    return {
      id: family.id,
      name: family.name,
      provider: "antigravity",
      description: copy?.description ?? "",
      ...(copy?.recommended ? { recommended: true } : {}),
    };
  });
}

/** The maintained list, recommended model first: the picker shows it until the agents report their own lists. */
export const MODEL_CATALOG = [
  { id: "gpt-6.1-sol", name: "GPT-6.1-Sol", provider: "codex", description: "Latest generation workhorse model", recommended: true },
  { id: "gpt-6-astra", name: "GPT-6-Astra", provider: "codex", description: "Frontier intelligence for the most demanding work" },
  { id: "gpt-6-sol", name: "GPT-6-Sol", provider: "codex", description: "Previous generation workhorse model" },
  { id: "gpt-6-luna", name: "GPT-6-Luna", provider: "codex", description: "Fast and affordable model for easier tasks" },
  { id: "gpt-5.6-sol", name: "GPT-5.6-Sol", provider: "codex", description: "Older generation workhorse model" },
  { id: "gpt-5.6-terra", name: "GPT-5.6-Terra", provider: "codex", description: "Older balanced model for straightforward work" },
  { id: "gpt-5.6-luna", name: "GPT-5.6-Luna", provider: "codex", description: "Older fast and efficient model" },
  { id: "gpt-5.5", name: "GPT-5.5", provider: "codex", description: "Legacy coding model" },
  { id: "claude-opus-5-5", name: "Opus 5.5", provider: "claude", description: "For complex work and everyday tasks", recommended: true },
  { id: "claude-fable-5-1", name: "Fable 5.1", provider: "claude", description: "For your toughest challenges" },
  { id: "claude-sonnet-5-5", name: "Sonnet 5.5", provider: "claude", description: "Most efficient for simpler tasks" },
  { id: "claude-haiku-4-5", name: "Haiku 4.5", provider: "claude", description: "Fastest for quick answers" },
  { id: "claude-sonnet-5", name: "Sonnet 5", provider: "claude", description: "Efficient for routine tasks" },
  { id: "claude-opus-5", name: "Opus 5", provider: "claude", description: "Best for everyday, complex tasks" },
  { id: "claude-fable-5", name: "Fable 5", provider: "claude", description: "Most capable for your hardest and longest-running tasks" },
  { id: "claude-opus-4-8", name: "Opus 4.8", provider: "claude", description: "Best for everyday, complex tasks" },
  { id: "claude-opus-4-7", name: "Opus 4.7", provider: "claude", description: "Best for everyday, complex tasks" },
  { id: "claude-opus-4-6", name: "Opus 4.6", provider: "claude", description: "Best for everyday, complex tasks" },
  { id: "claude-sonnet-4-6", name: "Sonnet 4.6", provider: "claude", description: "Efficient for routine tasks" },
  ...antigravityCatalog(),
  ...kiroModels(KIRO_AGENT_OPTIONS).map(({ id, name, description, recommended, credits }) => ({
    id,
    name,
    provider: "kiro",
    description,
    ...(recommended ? { recommended } : {}),
    ...(credits ? { credits } : {}),
  })),
  ...grokModels(GROK_AGENT_OPTIONS).map(({ id, name, description, recommended }) => ({
    id,
    name,
    provider: "grok",
    description,
    ...(recommended ? { recommended } : {}),
  })),
];
