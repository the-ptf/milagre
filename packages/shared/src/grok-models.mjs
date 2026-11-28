const PREFIX = "grok:";

const FULL = ["low", "medium", "high", "xhigh"];

// The models Grok Build 1.0.92 lists for a signed-in account, for a computer where `grok` isn't signed in yet.
// A signed-in agent reports its own list and each model's efforts, and that list wins.
export const GROK_AGENT_OPTIONS = Object.freeze([
  { value: "grok-4.7", name: "Grok 4.7", description: "The latest frontier model", efforts: FULL },
  { value: "grok-4.7-build-fast", name: "Grok 4.7 Fast", description: "Fast variant at twice the price", efforts: FULL },
  { value: "grok-4.6", name: "Grok 4.6", description: "", efforts: FULL },
  { value: "grok-4.5", name: "Grok 4.5", description: "", efforts: ["low", "medium", "high"] },
]);

export const GROK_TEXT_MODEL = "grok-4.6";

export const grokModelId = (value) => `${PREFIX}${value}`;

/** Grok's own model id for Milagre's `grok:` id; an id without the prefix is passed on as it is. */
export function resolveGrokModel(model) {
  if (typeof model !== "string" || !model) return undefined;
  return model.startsWith(PREFIX) ? model.slice(PREFIX.length) : model;
}

const lightestFirst = (levels) => FULL.filter((level) => levels.includes(level));

/**
 * What `session/new` reports under `models.availableModels` as the options `grokModels` takes: each model's id, name
 * and description, with its `reasoningEfforts` as `efforts` and the one marked default as `defaultEffort`.
 */
export function grokOptionsFrom(available) {
  return (Array.isArray(available) ? available : [])
    .filter((model) => typeof model?.modelId === "string" && model.modelId)
    .map(({ modelId, name, description, _meta: meta }) => {
      const reported = Array.isArray(meta?.reasoningEfforts) ? meta.reasoningEfforts : [];
      const efforts = lightestFirst(reported.map((item) => item?.id));
      const defaultEffort = reported.find((item) => item?.default && efforts.includes(item.id))?.id;
      return {
        value: modelId,
        name,
        description,
        efforts: meta?.supportsReasoningEffort === false ? [] : efforts,
        ...(defaultEffort ? { defaultEffort } : {}),
      };
    });
}

/** Grok's models as Milagre's models, in Grok's order with the first one recommended. */
export function grokModels(options) {
  const valid = (Array.isArray(options) ? options : []).filter((option) => typeof option?.value === "string" && option.value);
  return (valid.length ? valid : GROK_AGENT_OPTIONS).map((option, index) => ({
    id: grokModelId(option.value),
    name: option.name?.trim() || option.value,
    description: option.description?.trim() ?? "",
    recommended: index === 0,
    efforts: Array.isArray(option.efforts) ? lightestFirst(option.efforts) : [...FULL],
    ...(option.defaultEffort ? { defaultEffort: option.defaultEffort } : {}),
    ultracode: false,
    fastMode: false,
  }));
}
