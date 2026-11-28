const PREFIX = "grok:";

// The models Grok Build lists for a signed-in account, for a computer where `grok` isn't signed in yet. A signed-in
// agent reports its own list in the `model` option of `session/new`, and that list wins.
export const GROK_AGENT_OPTIONS = Object.freeze([
  { value: "grok-4.7", name: "Grok 4.7", description: "xAI's newest model" },
  { value: "grok-4.6", name: "Grok 4.6", description: "xAI's previous model" },
  { value: "grok-4.5", name: "Grok 4.5", description: "xAI's earlier reasoning model" },
]);

// Grok's `reasoning_effort` ids are minimal, low, medium, high and xhigh; Milagre offers the four thinking levels.
const EFFORTS = Object.freeze(["low", "medium", "high", "xhigh"]);

export const GROK_TEXT_MODEL = "grok-4.6";

export const grokModelId = (value) => `${PREFIX}${value}`;

/** Grok's own model id for Milagre's `grok:` id; an id without the prefix is passed on as it is. */
export function resolveGrokModel(model) {
  if (typeof model !== "string" || !model) return undefined;
  return model.startsWith(PREFIX) ? model.slice(PREFIX.length) : model;
}

/** Grok's `model` options as Milagre's models, in Grok's order with the first one recommended. */
export function grokModels(options) {
  const valid = (Array.isArray(options) ? options : []).filter((option) => typeof option?.value === "string" && option.value);
  return (valid.length ? valid : GROK_AGENT_OPTIONS).map((option, index) => ({
    id: grokModelId(option.value),
    name: option.name?.trim() || option.value,
    description: option.description?.trim() ?? "",
    recommended: index === 0,
    efforts: [...EFFORTS],
    ultracode: false,
    fastMode: false,
  }));
}
