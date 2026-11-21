const fs = require("node:fs/promises");
const path = require("node:path");
const { ollamaModels } = require("@milagre/shared/ollama-models");
const { OLLAMA_DOWN_MESSAGE } = require("./events.cjs");

const DEFAULT_URL = "http://127.0.0.1:11434";
const REQUEST_TIMEOUT_MS = 5_000;
// Ollama runs a model without num_ctx with 4K, 32K or 256K depending on VRAM; 32K is the middle guess.
const GUESSED_CONTEXT = 32_768;
const MAX_OUTPUT_TOKENS = 16_384;

const NO_MODELS_MESSAGE = "Ollama has no model that can call tools. Pull one with `ollama pull qwen3`, then send your message again.";

function ollamaUrl(env = process.env) {
  const host = typeof env.OLLAMA_HOST === "string" ? env.OLLAMA_HOST.trim() : "";
  if (!host) return DEFAULT_URL;
  const withScheme = /^https?:\/\//.test(host) ? host : `http://${host}`;
  try {
    const url = new URL(withScheme);
    if (!url.port) url.port = "11434";
    if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
    return url.origin;
  } catch {
    return DEFAULT_URL;
  }
}

async function call(base, route, { body, fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl(`${base}${route}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Ollama answered ${route} with ${response.status}.`);
  return response.json();
}

const numCtx = (parameters) => Number(/(?:^|\n)\s*num_ctx\s+(\d+)/.exec(typeof parameters === "string" ? parameters : "")?.[1]) || undefined;

function nativeContext(info) {
  const entry = Object.entries(info ?? {}).find(([key]) => key.endsWith(".context_length"));
  return Number(entry?.[1]) || undefined;
}

/** The local models, newest first, with what Ollama says each can do and the context it runs them with. */
async function readOllamaModels({ env = process.env, fetchImpl = fetch } = {}) {
  const base = ollamaUrl(env);
  const [tags, running] = await Promise.all([call(base, "/api/tags", { fetchImpl }), call(base, "/api/ps", { fetchImpl }).catch(() => ({ models: [] }))]);
  const loaded = new Map((running.models ?? []).map((model) => [model.name, Number(model.context_length) || undefined]));
  const models = Array.isArray(tags.models) ? tags.models : [];
  const sorted = [...models].sort((a, b) => String(b.modified_at ?? "").localeCompare(String(a.modified_at ?? "")));
  return Promise.all(
    sorted.map(async (model) => {
      const shown = await call(base, "/api/show", { body: { model: model.name }, fetchImpl }).catch(() => null);
      const native = nativeContext(shown?.model_info);
      const contextWindow = loaded.get(model.name) ?? numCtx(shown?.parameters) ?? (native ? Math.min(native, GUESSED_CONTEXT) : GUESSED_CONTEXT);
      return {
        name: model.name,
        parameterSize: model.details?.parameter_size,
        quantization: model.details?.quantization_level,
        capabilities: Array.isArray(shown?.capabilities) ? shown.capabilities : [],
        contextWindow,
        loaded: loaded.has(model.name),
      };
    }),
  );
}

/** Pi's models.json for the Milagre-owned Pi profile: one `ollama` provider over Ollama's OpenAI-compatible API. */
function piModelsConfig(entries, env = process.env) {
  return {
    providers: {
      ollama: {
        baseUrl: `${ollamaUrl(env)}/v1`,
        api: "openai-completions",
        apiKey: "ollama",
        compat: { supportsDeveloperRole: false },
        models: entries
          .filter((entry) => entry.capabilities.includes("tools"))
          .map((entry) => ({
            id: entry.name,
            name: entry.name,
            reasoning: entry.capabilities.includes("thinking"),
            input: entry.capabilities.includes("vision") ? ["text", "image"] : ["text"],
            contextWindow: entry.contextWindow,
            maxTokens: Math.min(MAX_OUTPUT_TOKENS, Math.floor(entry.contextWindow / 4)),
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          })),
      },
    },
  };
}

async function writeIfChanged(file, text) {
  const current = await fs.readFile(file, "utf8").catch(() => null);
  if (current === text) return;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, text, { mode: 0o600 });
  await fs.rename(temporary, file);
}

/** Whether the Ollama server answers on this computer. */
async function ollamaRunning({ env = process.env, fetchImpl = fetch } = {}) {
  try {
    await call(ollamaUrl(env), "/api/version", { fetchImpl });
    return true;
  } catch {
    return false;
  }
}

/** Lists Ollama's models and writes them to the Pi profile, so the next Pi process can run any of them. */
async function syncOllamaModels({ profile, env = process.env, fetchImpl = fetch } = {}) {
  const entries = await readOllamaModels({ env, fetchImpl });
  await writePiModels(profile, entries, env);
  return ollamaModels(entries);
}

async function writePiModels(profile, entries, env = process.env) {
  if (profile) await writeIfChanged(path.join(profile, "models.json"), `${JSON.stringify(piModelsConfig(entries, env), null, 2)}\n`);
}

module.exports = {
  NO_MODELS_MESSAGE,
  OLLAMA_DOWN_MESSAGE,
  ollamaRunning,
  ollamaUrl,
  piModelsConfig,
  readOllamaModels,
  syncOllamaModels,
  writeIfChanged,
  writePiModels,
};
