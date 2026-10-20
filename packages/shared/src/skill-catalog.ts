import type { ShadowedSkill, SkillOption } from "./model.ts";

export type SkillScope = SkillOption["scope"];

/** The Settings groups, in order. A group with no skills is not shown. */
export const SKILL_SCOPES: Array<{ scope: SkillScope; label: string }> = [
  { scope: "workspace", label: "Project" },
  { scope: "user", label: "User" },
  { scope: "bundled", label: "Built-in" },
];

/** The CLI folders discovery reads (`.claude/skills`…), as filter choices. */
export const SKILL_PROVIDERS = [
  { provider: "claude", label: "Claude" },
  { provider: "codex", label: "Codex" },
  { provider: "agents", label: "Agents" },
  { provider: "gemini", label: "Gemini" },
];

export function skillProviderLabel(provider: string) {
  return SKILL_PROVIDERS.find((item) => item.provider === provider)?.label ?? (provider === "milagre" ? "Milagre" : provider);
}

export interface SkillFilter {
  query: string;
  scope: SkillScope | "all";
  provider: string;
}

/** Search matches name and description like the `/` menu; scope and provider ("all" for any) narrow it further. */
export function filterSkills<T extends SkillOption>(skills: T[], { query, scope, provider }: SkillFilter) {
  const needle = query.trim().toLowerCase();
  return skills.filter(
    (skill) =>
      (scope === "all" || skill.scope === scope) &&
      (provider === "all" || skill.provider === provider) &&
      `${skill.name} ${skill.description}`.toLowerCase().includes(needle),
  );
}

/**
 * How well a command or skill answers what was typed after `/`: 0 when its name starts with it (the part after a
 * plugin prefix counts too), 1 when the name contains it, 2 when only the description does, -1 for no match.
 */
export function skillMatchRank(name: string, description: string, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const full = name.replace(/^\//, "").toLowerCase();
  const short = full.slice(full.lastIndexOf(":") + 1);
  if (full.startsWith(needle) || short.startsWith(needle)) return 0;
  if (full.includes(needle)) return 1;
  return `${full} ${description}`.toLowerCase().includes(needle) ? 2 : -1;
}

/** The items matching `query`, name-prefix matches first, then name matches, then description matches; ties keep their order. */
export function rankSkillMatches<T>(items: readonly T[], query: string, read: (item: T) => { name: string; description: string }): T[] {
  return (
    items
      .map((item, index) => ({ item, index, rank: skillMatchRank(read(item).name, read(item).description, query) }))
      .filter((entry) => entry.rank >= 0)
      // Sorts the array the map above just made (Hermes, which also reads this package, has no toSorted).
      // oxlint-disable-next-line unicorn/no-array-sort
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((entry) => entry.item)
  );
}

export function groupSkills<T extends SkillOption>(skills: T[]) {
  return SKILL_SCOPES.map((group) => ({ ...group, skills: skills.filter((skill) => skill.scope === group.scope) })).filter((group) => group.skills.length > 0);
}

/** The same-named skills a winner hides. */
export function shadowedBy(shadowed: ShadowedSkill[] | undefined, skill: SkillOption) {
  return (shadowed ?? []).filter((item) => item.shadowedBy === skill.path);
}

/** A SKILL.md without its frontmatter, which the page shows as the name and description instead. */
export function skillBody(content: string) {
  return content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
}

// ponytail: guesses the home folder from the path (macOS and Linux layouts); pass the real one if a host ever reports it.
// Also shortens the paths inside a discovery warning.
export function shortenHome(text: string) {
  return text.replace(/(^|\s)\/(?:Users|home)\/[^/\s]+(?=\/|\s|$)/g, "$1~");
}
