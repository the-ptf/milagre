// Kiro (docs/adr/0007-kiro-over-acp.md) reports each model in its `model` config option with what it costs and which
// efforts it takes, in `_meta.kiro`: { rateMultiplier, rateUnit: "Credit", effortLevels, defaultEffortLevel }. Milagre's
// ids carry a `kiro:` prefix, so a Claude or GPT model run on Kiro's credits never turns into the same model on its
// own provider (a saved default, a model id read back from a Chat).

const PREFIX = "kiro:";

/**
 * What kiro-cli 2.34.2 (engine v3) offered an Enterprise account on 2026-10-30, a short list in its order. The picker
 * shows these until a session reports the account's own list. Multipliers are relative to Auto, as Kiro bills them.
 */
export const KIRO_AGENT_OPTIONS = Object.freeze([
  { value: "auto", name: "Auto", description: "Models chosen by task for optimal usage and consistent quality", _meta: { kiro: { rateMultiplier: 1 } } },
  {
    value: "claude-opus-5.5",
    name: "Claude Opus 5.5",
    description: "Claude Opus 5.5 model with 1M context window",
    _meta: { kiro: { rateMultiplier: 2, effortLevels: ["low", "medium", "high", "xhigh", "max"], defaultEffortLevel: "medium" } },
  },
  {
    value: "claude-sonnet-5.5",
    name: "Claude Sonnet 5.5",
    description: "Claude Sonnet 5.5 model with 1M context window",
    _meta: { kiro: { rateMultiplier: 1.3, effortLevels: ["low", "medium", "high", "xhigh", "max"], defaultEffortLevel: "high" } },
  },
  { value: "claude-haiku-4.5", name: "Claude Haiku 4.5", description: "The latest Claude Haiku model", _meta: { kiro: { rateMultiplier: 0.4 } } },
  {
    value: "gpt-5.6-sol",
    name: "GPT 5.6 Sol",
    description: "OpenAI GPT 5.6 Sol with 1M context window",
    _meta: { kiro: { rateMultiplier: 4.4, effortLevels: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffortLevel: "high" } },
  },
  {
    value: "gpt-5.6-luna",
    name: "GPT 5.6 Luna",
    description: "OpenAI GPT 5.6 Luna with 1M context window",
    _meta: { kiro: { rateMultiplier: 0.6, effortLevels: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffortLevel: "high" } },
  },
]);

/** The model the text generator asks (chat titles, commit messages): cheap, and without an effort to choose. */
export const KIRO_TEXT_MODEL = "claude-haiku-4.5";

/** Milagre's id for one of Kiro's model ids. */
export const kiroModelId = (value) => `${PREFIX}${value}`;

/** Kiro's own model id for Milagre's `kiro:` id; an id without the prefix is passed on as it is. */
export function resolveKiroModel(model) {
  if (typeof model !== "string" || !model) return undefined;
  return model.startsWith(PREFIX) ? model.slice(PREFIX.length) : model;
}

// "none" turns a GPT model's reasoning off; Milagre's efforts are thinking levels, so it isn't offered.
const effortsOf = (meta) => (Array.isArray(meta?.effortLevels) ? meta.effortLevels.filter((level) => typeof level === "string" && level !== "none") : []);

/**
 * Kiro's `model` options as Milagre's models, in Kiro's order with Auto recommended. `credits` is the model's credit
 * multiplier; `efforts` its thinking levels, lightest first, with Kiro's default as the default.
 */
export function kiroModels(options) {
  const valid = (Array.isArray(options) ? options : []).filter((option) => typeof option?.value === "string" && option.value);
  return (valid.length ? valid : KIRO_AGENT_OPTIONS).map((option) => {
    const { _meta: own } = option;
    const meta = own?.kiro;
    const efforts = effortsOf(meta);
    const defaultEffort = efforts.includes(meta?.defaultEffortLevel) ? meta.defaultEffortLevel : undefined;
    return {
      id: kiroModelId(option.value),
      name: option.name?.trim() || option.value,
      description: option.description?.trim() ?? "",
      recommended: option.value === "auto",
      efforts,
      ...(defaultEffort ? { defaultEffort } : {}),
      ultracode: false,
      fastMode: false,
      ...(typeof meta?.rateMultiplier === "number" && meta.rateMultiplier > 0 ? { credits: meta.rateMultiplier } : {}),
    };
  });
}

/** "2×", "1.3×", "0.06×": a credit multiplier as the picker shows it. */
export function formatCredits(multiplier) {
  return `${Number(multiplier.toFixed(2))}×`;
}
