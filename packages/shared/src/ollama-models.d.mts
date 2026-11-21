import type { ReportedModel, TurnMetrics } from "./model.ts";

/** One local Ollama model, as the host reads it from the Ollama server. */
export interface OllamaModelEntry {
  name: string;
  parameterSize?: string;
  quantization?: string;
  capabilities: string[];
  contextWindow?: number;
}

export function ollamaModelId(name: string): string;
export function resolveOllamaModel(model: string | undefined): string | undefined;
export function formatContext(tokens: number): string;
export function ollamaModels(entries: readonly OllamaModelEntry[] | null | undefined): ReportedModel[];
export function turnMetricsParts(metrics: TurnMetrics | null | undefined): { key: string; text: string; label: string }[];
