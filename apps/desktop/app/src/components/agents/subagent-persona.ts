import type { Subagent } from "@milagre/shared/model";

const names = [
  "Moses",
  "Noah",
  "Esther",
  "Jonah",
  "Ruth",
  "David",
  "Mary",
  "Daniel",
  "Deborah",
  "Elijah",
  "Sarah",
  "Gideon",
  "Miriam",
  "Isaac",
  "Ezekiel",
  "Solomon",
];
export function subagentName(index: number): string {
  return `${names[index % names.length]}${index >= names.length ? ` ${Math.floor(index / names.length) + 1}` : ""}`;
}

/** The subagents' cursor colours, given out in turn. */
const SUBAGENT_COLORS = ["mint", "blue", "peach", "lilac"] as const;
export type SubagentColor = (typeof SUBAGENT_COLORS)[number];
export const SUBAGENT_TINTS: Record<SubagentColor, string> = { mint: "#b4dccb", blue: "#b8d5fb", peach: "#eec9a6", lilac: "#d1c3ef" };
export const subagentColor = (index: number): SubagentColor => SUBAGENT_COLORS[index % SUBAGENT_COLORS.length]!;

/**
 * A subagent as a live design's cursor shows it, by its place among the Chat's subagents: its name, its colour and
 * the task it was given. Null for one the Chat doesn't list.
 */
export function subagentPersona(agents: readonly Subagent[], id: string): { name: string; color: SubagentColor; task: string } | null {
  const index = agents.findIndex((agent) => agent.id === id);
  if (index === -1) return null;
  return { name: subagentName(index), color: subagentColor(index), task: agents[index]!.title };
}
