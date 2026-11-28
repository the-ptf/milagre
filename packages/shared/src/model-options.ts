import type { ModelOption, ModelCapabilities, ModelCapability, EffortLevel, PermissionMode } from "./model.ts";

// Claude Code 2.1.288 offers fast mode on these; a guess until Claude reports its own list.
const CLAUDE_FAST_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]);

export function capabilityFor(model: ModelOption, capabilities: ModelCapabilities | null): ModelCapability {
  const reported = capabilities?.[model.provider][model.id];
  if (reported) return reported;
  // Every GPT model codex-cli 0.160.0 lists has the "priority" tier.
  if (model.provider === "codex") return { efforts: ["low", "medium", "high"], ultracode: false, fastMode: true };
  // Antigravity reports one model per thinking level; the catalog's families carry those levels as efforts. No fast tier.
  if (model.provider === "antigravity") {
    const family = antigravityFamilies(ANTIGRAVITY_AGENT_OPTIONS).find((item) => item.id === model.id);
    return { efforts: family?.efforts ?? [], ...(family?.defaultEffort ? { defaultEffort: family.defaultEffort } : {}), ultracode: false, fastMode: false };
  }
  // Kiro reports each model's efforts with its list; the catalog's entries carry the ones kiro-cli 2.34.2 reported.
  if (model.provider === "kiro") {
    const known = kiroModels(KIRO_AGENT_OPTIONS).find((item) => item.id === model.id);
    return known
      ? { efforts: known.efforts, ...(known.defaultEffort ? { defaultEffort: known.defaultEffort } : {}), ultracode: false, fastMode: false }
      : { efforts: [], ultracode: false, fastMode: false };
  }
  // Pi's models are whatever Ollama has pulled and Pi's providers offer; until the host lists them, none has an effort.
  if (model.provider === "pi") return { efforts: [], ultracode: false, fastMode: false };
  const fastMode = CLAUDE_FAST_MODELS.has(model.id);
  if (model.id.includes("haiku")) return { efforts: [], ultracode: false, fastMode };
  const modern = /claude-(opus|sonnet|fable)-5/.test(model.id);
  return { efforts: modern ? ["low", "medium", "high", "xhigh", "max"] : ["low", "medium", "high", "max"], ultracode: modern, fastMode };
}

// Neither agent reports a model's context window before a turn, so these are read off the agents themselves.
// Claude Code 2.1.293's model table gives every Claude model from Opus 4.7 on 1M; these older ones have 200K.
const CLAUDE_200K = /^claude-(3-|haiku-4|sonnet-4|opus-4(-[0-6])?$)/;
// codex-cli 0.160.0's models cache gives every GPT model 272K; Gemini models in Antigravity report 1,048,576.
const CODEX_WINDOW = 272_000;
const GEMINI_WINDOW = 1_048_576;

/** Whether a picker row matches the search: its name, id, or the provider behind it (OpenRouter, Ollama). */
export function modelMatches(model: Pick<ModelOption, "name" | "id" | "group">, query: string): boolean {
  return `${model.name} ${model.id} ${model.group ?? ""}`.toLowerCase().includes(query.trim().toLowerCase());
}

/** The model's context window in tokens, or undefined when it isn't known. */
export function contextWindowFor(model: Pick<ModelOption, "provider" | "id" | "contextWindow">): number | undefined {
  if (model.provider === "pi") return model.contextWindow;
  if (model.provider === "claude") return CLAUDE_200K.test(model.id) ? 200_000 : 1_000_000;
  if (model.provider === "codex") return CODEX_WINDOW;
  return model.id.startsWith("gemini") ? GEMINI_WINDOW : undefined;
}

export function effortFor(capability: ModelCapability, effort: EffortLevel): EffortLevel | undefined {
  const { efforts } = capability;
  if (efforts.length === 0) return undefined;
  if (efforts.includes(effort)) return effort;
  if (capability.defaultEffort && efforts.includes(capability.defaultEffort)) return capability.defaultEffort;
  return efforts.includes("high") ? "high" : efforts[Math.floor(efforts.length / 2)];
}

/**
 * What a message runs with, from the composer's picks: the model and permission mode as picked, the effort the model
 * takes, Ultracode and fast mode only where the model has them, and the reply style. The Chat's composer, the
 * outbox and a Chat open on the canvas all send these the same way.
 */
export function runChoices(
  model: ModelOption,
  capabilities: ModelCapabilities | null,
  picks: { permissionMode: PermissionMode; effort: EffortLevel; ultracode: boolean; fastMode: boolean },
  style: { claudeReplies: "concise" | "normal"; tldrEnabled: boolean },
) {
  const capability = capabilityFor(model, capabilities);
  return {
    provider: model.provider,
    model: model.id,
    permissionMode: picks.permissionMode,
    effort: effortFor(capability, picks.effort),
    ultracode: capability.ultracode && picks.ultracode,
    fastMode: capability.fastMode && picks.fastMode,
    replies: style.claudeReplies,
    tldrEnabled: style.tldrEnabled,
  };
}

export {
  ANTIGRAVITY_AGENT_OPTIONS,
  ANTIGRAVITY_FAMILY_COPY,
  antigravityFamilies,
  familySlug,
  resolveAntigravityModel,
  splitModelName,
} from "./antigravity-models.mjs";
import { ANTIGRAVITY_AGENT_OPTIONS, antigravityFamilies } from "./antigravity-models.mjs";
import { KIRO_AGENT_OPTIONS, kiroModels } from "./kiro-models.mjs";

export { MODEL_CATALOG } from "./model-catalog.mjs";
