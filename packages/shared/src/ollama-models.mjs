// Ollama's models as Milagre models. The host reads them from the local Ollama server (/api/tags, /api/show,
// /api/ps) and Pi runs them. Only models Ollama says can call tools are listed: an agent without tools can't work.

const PREFIX = "ollama:";
const THINKING_EFFORTS = Object.freeze(["low", "medium", "high"]);

export const ollamaModelId = (name) => `${PREFIX}${name}`;

/** Ollama's own model name for Milagre's `ollama:` id; an id without the prefix is passed on as it is. */
export function resolveOllamaModel(model) {
  if (typeof model !== "string" || !model) return undefined;
  return model.startsWith(PREFIX) ? model.slice(PREFIX.length) : model;
}

export function formatContext(tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) return "";
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  return `${Math.round(tokens / 1024)}K`;
}

function description(entry) {
  const parts = [entry.parameterSize, entry.quantization, entry.contextWindow ? `${formatContext(entry.contextWindow)} context` : ""];
  return parts.filter((part) => typeof part === "string" && part).join(" · ") || "Local model";
}

/** Milagre models for Ollama's local models, in Ollama's order (most recently changed first). */
export function ollamaModels(entries) {
  if (!Array.isArray(entries)) return [];
  const usable = entries.filter((entry) => typeof entry?.name === "string" && entry.name && entry.capabilities?.includes("tools"));
  return usable.map((entry, index) => {
    const thinking = entry.capabilities.includes("thinking");
    return {
      id: ollamaModelId(entry.name),
      name: entry.name,
      description: description(entry),
      recommended: index === 0,
      efforts: thinking ? [...THINKING_EFFORTS] : [],
      ...(thinking ? { defaultEffort: "low" } : {}),
      ...(entry.contextWindow ? { contextWindow: entry.contextWindow } : {}),
      ultracode: false,
      fastMode: false,
    };
  });
}

const seconds = (ms) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`);
const tokens = (count) => (count >= 1000 ? `${(count / 1000).toFixed(count >= 10_000 ? 0 : 1)}K` : String(count));

/** The last turn's local-model metrics as short labelled parts, the same on desktop and phone. */
export function turnMetricsParts(metrics) {
  if (!metrics) return [];
  const parts = [];
  if (Number.isFinite(metrics.ttftMs)) parts.push({ key: "ttft", text: `TTFT ${seconds(metrics.ttftMs)}`, label: "Time to first token" });
  if (Number.isFinite(metrics.outputTps)) parts.push({ key: "tps", text: `${metrics.outputTps} tok/s`, label: "Output tokens per second" });
  if (Number.isFinite(metrics.prefillTps))
    parts.push({ key: "prefill", text: `prefill ${Math.round(metrics.prefillTps)} tok/s`, label: "Prompt tokens read per second" });
  if (Number.isFinite(metrics.inputTokens) || Number.isFinite(metrics.outputTokens))
    parts.push({ key: "tokens", text: `${tokens(metrics.inputTokens ?? 0)} in · ${tokens(metrics.outputTokens ?? 0)} out`, label: "Prompt and output tokens" });
  if (Number.isFinite(metrics.durationMs)) parts.push({ key: "duration", text: seconds(metrics.durationMs), label: "Whole turn" });
  return parts;
}
