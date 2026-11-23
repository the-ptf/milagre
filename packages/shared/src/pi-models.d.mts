import type { ContextUsage, ReportedModel, TurnMetrics } from "./model.ts";

/** One local Ollama model, as the host reads it from the Ollama server. */
export interface OllamaModelEntry {
  name: string;
  parameterSize?: string;
  quantization?: string;
  capabilities: string[];
  contextWindow?: number;
}

/** One model as Pi's `get_available_models` reports it. */
export interface PiReportedModel {
  id: string;
  name?: string;
  provider: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, unknown>;
  contextWindow?: number;
  cost?: { input?: number; output?: number };
}

export interface StatsPart {
  key: string;
  text: string;
  label: string;
}

export const LOCAL_PROVIDER: "ollama";
export function piModelId(provider: string, id: string): string;
export function resolvePiModel(model: string | undefined): { provider: string; id: string } | undefined;
export function isLocalPiModel(model: string | undefined): boolean;
export function piProviderLabel(provider: string): string;
export function formatContext(tokens: number): string;
export function ollamaModels(entries: readonly OllamaModelEntry[] | null | undefined): ReportedModel[];
export function piCloudModels(models: readonly PiReportedModel[] | null | undefined): ReportedModel[];
export function piModels(local: readonly OllamaModelEntry[] | null | undefined, cloud: readonly PiReportedModel[] | null | undefined): ReportedModel[];
export function spendText(cost: number | undefined): string;
export function turnMetricsParts(metrics: TurnMetrics | null | undefined): StatsPart[];
export function piStatsParts(usage: ContextUsage | null | undefined, options: { local: boolean }): StatsPart[];
export function unlistedPiModel(model: string | undefined): (ReportedModel & { provider: "pi"; group: string; local?: boolean }) | undefined;
