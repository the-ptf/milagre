import type { EffortLevel } from "./model.ts";

/** One entry of the agent's `model` config option, as session/new reports it. */
export interface AgentModelOption {
  value: string;
  name?: string;
  description?: string;
}

/** One model family: Milagre's id for it, its efforts lightest first, and the agent id for each effort. */
export interface AntigravityFamily {
  id: string;
  name: string;
  efforts: EffortLevel[];
  defaultEffort?: EffortLevel;
  /** The agent model id for each effort; a family without levels has its one id under "". */
  variants: Record<EffortLevel, string>;
  options: AgentModelOption[];
}

export const ANTIGRAVITY_AGENT_OPTIONS: readonly AgentModelOption[];
export const ANTIGRAVITY_FAMILY_COPY: Record<string, { description: string; recommended?: boolean }>;
export const ANTIGRAVITY_TEXT_FAMILY: { readonly model: "gemini-3.8-flash"; readonly effort: "low" };
export function familySlug(name: string): string;
export function splitModelName(name: string): { family: string; level: EffortLevel | null };
export function antigravityFamilies(options: readonly AgentModelOption[] | null | undefined, current?: string | null): AntigravityFamily[];
export function resolveAntigravityModel(families: readonly AntigravityFamily[], model: string | undefined, effort?: EffortLevel | null): string | undefined;
