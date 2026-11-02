import type { ReportedModel } from "./model.ts";

/** One entry of Kiro's `model` config option, as session/new reports it. */
export interface KiroAgentOption {
  value: string;
  name?: string;
  description?: string;
  _meta?: { kiro?: { rateMultiplier?: number; rateUnit?: string; effortLevels?: string[]; defaultEffortLevel?: string } };
}

export const KIRO_AGENT_OPTIONS: readonly KiroAgentOption[];
export const KIRO_TEXT_MODEL: "claude-haiku-4.5";
export function kiroModelId(value: string): string;
export function resolveKiroModel(model: string | undefined): string | undefined;
export function kiroModels(options: readonly KiroAgentOption[] | null | undefined): ReportedModel[];
export function formatCredits(multiplier: number): string;
