// Pi's models as Milagre models, ids `pi:<provider>/<model>`. Local models come from the computer's Ollama server
// (/api/tags, /api/show, /api/ps); every other model comes from Pi's `get_available_models`, which lists only the
// providers Pi has credentials for. Only Ollama models that can call tools are listed: an agent without tools can't work.

const PREFIX = "pi:";
// The id Ollama Chats saved before the provider became Pi.
const LEGACY_PREFIX = "ollama:";
export const LOCAL_PROVIDER = "ollama";
const LOCAL_EFFORTS = Object.freeze(["low", "medium", "high"]);
const PI_LEVELS = Object.freeze(["minimal", "low", "medium", "high", "xhigh", "max"]);

const LABELS = {
  ollama: "Ollama",
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google Gemini",
  "google-vertex": "Google Vertex AI",
  groq: "Groq",
  xai: "xAI",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  cerebras: "Cerebras",
  fireworks: "Fireworks",
  together: "Together AI",
  baseten: "Baseten",
  nvidia: "NVIDIA NIM",
  huggingface: "Hugging Face",
  "github-copilot": "GitHub Copilot",
  "amazon-bedrock": "Amazon Bedrock",
  "azure-openai-responses": "Azure OpenAI",
  "vercel-ai-gateway": "Vercel AI Gateway",
  "cloudflare-workers-ai": "Cloudflare Workers AI",
  minimax: "MiniMax",
  moonshotai: "Moonshot AI",
  zai: "Z.ai",
  opencode: "OpenCode",
};

export const piModelId = (provider, id) => `${PREFIX}${provider}/${id}`;

/** Pi's provider and model for Milagre's id. An `ollama:` id, or one without a prefix, is a local Ollama model. */
export function resolvePiModel(model) {
  if (typeof model !== "string" || !model) return undefined;
  if (model.startsWith(PREFIX)) {
    const rest = model.slice(PREFIX.length);
    const at = rest.indexOf("/");
    return at > 0 && at < rest.length - 1 ? { provider: rest.slice(0, at), id: rest.slice(at + 1) } : undefined;
  }
  return { provider: LOCAL_PROVIDER, id: model.startsWith(LEGACY_PREFIX) ? model.slice(LEGACY_PREFIX.length) : model };
}

/** A Pi Chat's model that isn't listed right now (Ollama stopped, a key removed). Pi never swaps in another one: a
 * local Chat must not move to a paid model on its own. */
export function unlistedPiModel(model) {
  const resolved = resolvePiModel(model);
  if (!resolved) return undefined;
  const local = resolved.provider === LOCAL_PROVIDER;
  return {
    id: piModelId(resolved.provider, resolved.id),
    name: resolved.id,
    provider: "pi",
    description: local ? "Ollama isn't serving this model right now" : `${piProviderLabel(resolved.provider)} isn't connected to Pi right now`,
    group: piProviderLabel(resolved.provider),
    ...(local ? { local: true } : {}),
    efforts: [],
    ultracode: false,
    fastMode: false,
  };
}

export const isLocalPiModel = (model) => resolvePiModel(model)?.provider === LOCAL_PROVIDER;

export function piProviderLabel(provider) {
  if (LABELS[provider]) return LABELS[provider];
  return String(provider)
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

export function formatContext(tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) return "";
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  return `${Math.round(tokens / 1024)}K`;
}

const dollars = (value) => `$${value >= 10 ? Math.round(value) : Number(value.toFixed(2))}`;

function price(cost) {
  const input = Number(cost?.input);
  const output = Number(cost?.output);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return "";
  if (input === 0 && output === 0) return "Free";
  return `${dollars(input)} in · ${dollars(output)} out per 1M tokens`;
}

function localDescription(entry) {
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
      id: piModelId(LOCAL_PROVIDER, entry.name),
      name: entry.name,
      description: localDescription(entry),
      recommended: index === 0,
      efforts: thinking ? [...LOCAL_EFFORTS] : [],
      ...(thinking ? { defaultEffort: "low" } : {}),
      ...(entry.contextWindow ? { contextWindow: entry.contextWindow } : {}),
      group: piProviderLabel(LOCAL_PROVIDER),
      local: true,
      ultracode: false,
      fastMode: false,
    };
  });
}

// xhigh and max only where the model maps them; Pi refuses set_thinking_level for a level the model lacks.
function thinkingLevels(model) {
  if (model?.reasoning !== true) return [];
  const map = model.thinkingLevelMap && typeof model.thinkingLevelMap === "object" ? model.thinkingLevelMap : {};
  return PI_LEVELS.filter((level) => map[level] !== null && (level === "xhigh" || level === "max" ? map[level] !== undefined : true));
}

/** Milagre models for the hosted models Pi reported, grouped by provider in Pi's order. */
export function piCloudModels(models) {
  if (!Array.isArray(models)) return [];
  const seen = new Set();
  const listed = [];
  for (const model of models) {
    const provider = typeof model?.provider === "string" ? model.provider.trim() : "";
    const id = typeof model?.id === "string" ? model.id.trim() : "";
    if (!provider || !id || provider === LOCAL_PROVIDER) continue;
    const key = piModelId(provider, id);
    if (seen.has(key)) continue;
    seen.add(key);
    const label = piProviderLabel(provider);
    const contextWindow = Number(model.contextWindow) > 0 ? Number(model.contextWindow) : undefined;
    const efforts = thinkingLevels(model);
    listed.push({
      id: key,
      name: typeof model.name === "string" && model.name.trim() ? model.name.trim() : id,
      description: [label, contextWindow ? `${formatContext(contextWindow)} context` : "", price(model.cost)].filter(Boolean).join(" · "),
      recommended: false,
      efforts,
      ...(efforts.length ? { defaultEffort: efforts.includes("medium") ? "medium" : efforts[0] } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      group: label,
      ultracode: false,
      fastMode: false,
    });
  }
  const order = [...new Set(listed.map((model) => model.group))];
  return listed.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}

/** Local models first (the newest recommended), then each hosted provider's. */
export function piModels(local, cloud) {
  const models = [...ollamaModels(local), ...piCloudModels(cloud)];
  if (models.length && !models.some((model) => model.recommended)) models[0] = { ...models[0], recommended: true };
  return models;
}

const seconds = (ms) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`);
const tokens = (count) => (count >= 1000 ? `${(count / 1000).toFixed(count >= 10_000 ? 0 : 1)}K` : String(count));

/** What a Chat has spent on hosted models through Pi, in US dollars. Nothing for a Chat that spent nothing. */
export function spendText(cost) {
  if (!Number.isFinite(cost) || cost <= 0) return "";
  if (cost < 0.01) return "<$0.01";
  return `$${cost < 100 ? cost.toFixed(2) : Math.round(cost)}`;
}

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

/** The line under a Pi Chat's composer: a local model's metrics, then what the Chat has spent on hosted models. */
export function piStatsParts(usage, { local }) {
  const parts = local ? turnMetricsParts(usage?.metrics) : [];
  const spent = spendText(usage?.cost);
  return spent ? [...parts, { key: "cost", text: `${spent} spent`, label: "What this Chat has cost on paid models" }] : parts;
}
