// Antigravity (docs/adr/0006-antigravity-over-acp.md) reports one model per thinking level, named "<Family> (<Level>)":
// "Gemini 3.1 Pro (High)", "Gemini 3.1 Pro (Low)". Milagre shows one model per family and offers the levels as its
// efforts, like Claude and Codex. The agent's ids are irregular ("gemini-pro-agent" is Pro at High), so each family
// keeps a table from effort to the agent's own id.

/**
 * Personal-account options reported by ACP 1.3.0 on 2026-10-18, in its order. The picker groups these until
 * a session reports its account's own list. Pro 3.1 and Flash 3.7/3.6 are now Enterprise-only:
 * https://antigravity.google/docs/models. Partner models are offered only when ACP reports them.
 */
export const ANTIGRAVITY_AGENT_OPTIONS = Object.freeze([
  { value: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
  { value: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
  { value: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)" },
  { value: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
  { value: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
  { value: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
]);

/** Milagre's wording and recommendations per family, by family id; the agent describes models only by their ids. */
export const ANTIGRAVITY_FAMILY_COPY = {
  "gemini-4-argon": { description: "For complex work", recommended: true },
  "gemini-3.8-flash": { description: "Fast", recommended: true },
  // These stay available when an Enterprise session reports them, without advertising them in the fallback.
  "gemini-3.1-pro": { description: "For complex work (Enterprise)" },
  "gemini-3.7-flash": { description: "Previous generation fast model (Enterprise)" },
  "gemini-3.6-flash": { description: "Older fast model (Enterprise)" },
};

/** The family the text generator asks, and at which effort: the fastest current model at its lightest level. */
export const ANTIGRAVITY_TEXT_FAMILY = Object.freeze({ model: "gemini-3.8-flash", effort: "low" });

const LEVEL_ORDER = ["low", "medium", "high"];
const levelRank = (level) => {
  const index = LEVEL_ORDER.indexOf(level);
  return index === -1 ? LEVEL_ORDER.length : index;
};

/** A stable id for a family name: "Gemini 3.1 Pro" -> "gemini-3.1-pro". */
export function familySlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** "Gemini 3.1 Pro (High)" -> { family: "Gemini 3.1 Pro", level: "high" }; a name without "(Level)" has no level. */
export function splitModelName(name) {
  const match = /^(.*\S)\s*\(\s*([A-Za-z][\w-]*)\s*\)$/.exec(name.trim());
  return match && match[2].toLowerCase() !== "thinking" ? { family: match[1], level: match[2].toLowerCase() } : { family: name.trim(), level: null };
}

/**
 * Groups the agent's per-level models into families, in the order the agent lists each family first. Levels are
 * ordered low < medium < high, any other level after them in the agent's order. `current` is the session's model:
 * its level becomes its family's default effort; otherwise the default is "high", else the heaviest level.
 */
export function antigravityFamilies(options, current) {
  const families = new Map();
  const levelOf = new Map();
  for (const option of options ?? []) {
    if (typeof option?.value !== "string" || !option.value) continue;
    const { family: name, level } = splitModelName(option.name?.trim() || option.value);
    const slug = familySlug(name) || option.value;
    // Partner models use Antigravity's Account and quota, even when the same model also has its own provider.
    const id = /^(claude|gpt)(-|$)/.test(slug) ? `antigravity:${slug}` : slug;
    let family = families.get(id);
    if (!family) {
      family = { id, name, efforts: [], variants: {}, options: [] };
      families.set(id, family);
    }
    const key = level ?? "";
    if (key in family.variants) continue;
    family.variants[key] = option.value;
    family.options.push(option);
    if (level) {
      family.efforts.push(level);
      levelOf.set(option.value, level);
    }
  }
  for (const family of families.values()) {
    // A family that mixes a bare name with levelled ones keeps only the levels as efforts.
    family.efforts = family.efforts
      .map((level, index) => ({ level, index }))
      .sort((a, b) => levelRank(a.level) - levelRank(b.level) || a.index - b.index)
      .map(({ level }) => level);
    if (!family.efforts.length) continue;
    const currentLevel = current && family.options.some((option) => option.value === current) ? levelOf.get(current) : undefined;
    family.defaultEffort = currentLevel ?? (family.efforts.includes("high") ? "high" : family.efforts.at(-1));
  }
  return [...families.values()];
}

/**
 * The agent model id for Milagre's `model` (a family id) at `effort`. A raw agent id (a chat saved before families)
 * is used as it is. A family without the effort uses its default. Undefined when nothing matches.
 */
export function resolveAntigravityModel(families, model, effort) {
  if (!model) return undefined;
  if (families.some((family) => Object.values(family.variants).includes(model))) return model;
  const family = families.find((item) => item.id === model || item.id === `antigravity:${model}`);
  if (!family) return undefined;
  if (!family.efforts.length) return family.variants[""] ?? family.options[0]?.value;
  const level = effort && family.efforts.includes(effort) ? effort : (family.defaultEffort ?? family.efforts.at(-1));
  return family.variants[level];
}
