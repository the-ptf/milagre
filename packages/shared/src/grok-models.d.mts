import type { ReportedModel } from "./model.ts";

/** One entry of Grok's `model` config option, as session/new reports it. */
export interface GrokAgentOption {
  value: string;
  name?: string;
  description?: string;
  efforts?: readonly string[];
  defaultEffort?: string;
}

export const GROK_AGENT_OPTIONS: readonly GrokAgentOption[];
export const GROK_TEXT_MODEL: "grok-4.6";
export function grokModelId(value: string): string;
export function resolveGrokModel(model: string | undefined): string | undefined;
/** `session/new`'s `models.availableModels` as the options `grokModels` takes. */
export function grokOptionsFrom(available: unknown): GrokAgentOption[];
export function grokModels(options: readonly GrokAgentOption[] | null | undefined): ReportedModel[];
