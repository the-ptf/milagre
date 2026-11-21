const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ollamaUrl, piModelsConfig, readOllamaModels, syncOllamaModels } = require("./ollama.cjs");

function fakeOllama(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const route = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ route, body });
    const answer = routes[route];
    const value = typeof answer === "function" ? answer(body) : answer;
    if (value === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => value };
  };
  return { fetchImpl, calls };
}

const ROUTES = {
  "/api/tags": {
    models: [
      { name: "embed:latest", modified_at: "2026-11-01T00:00:00Z", details: { parameter_size: "0.3B" } },
      { name: "qwen3:8b", modified_at: "2026-11-20T00:00:00Z", details: { parameter_size: "8.2B", quantization_level: "Q4_K_M" } },
      { name: "coder:64k", modified_at: "2026-11-10T00:00:00Z", details: { parameter_size: "27B", quantization_level: "Q4_K_M" } },
    ],
  },
  "/api/ps": { models: [{ name: "qwen3:8b", context_length: 40960 }] },
  "/api/show": ({ model }) =>
    ({
      "embed:latest": { capabilities: ["embedding"], model_info: {} },
      "qwen3:8b": { capabilities: ["completion", "tools", "thinking"], model_info: { "qwen3.context_length": 131072 } },
      "coder:64k": { capabilities: ["completion", "tools", "vision"], parameters: "temperature 1\nnum_ctx 65536", model_info: { "x.context_length": 262144 } },
    })[model],
};

test("models come newest first, with the context Ollama runs them with", async () => {
  const { fetchImpl } = fakeOllama(ROUTES);
  const entries = await readOllamaModels({ env: {}, fetchImpl });
  assert.deepEqual(
    entries.map(({ name, contextWindow, loaded }) => [name, contextWindow, loaded]),
    [
      ["qwen3:8b", 40960, true],
      ["coder:64k", 65536, false],
      ["embed:latest", 32768, false],
    ],
  );
});

test("Pi's models.json lists only the models that can call tools, as an Ollama provider", async () => {
  const { fetchImpl } = fakeOllama(ROUTES);
  const config = piModelsConfig(await readOllamaModels({ env: {}, fetchImpl }), {});
  const provider = config.providers.ollama;
  assert.equal(provider.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(provider.api, "openai-completions");
  assert.deepEqual(
    provider.models.map(({ id, reasoning, input, contextWindow, maxTokens }) => [id, reasoning, input, contextWindow, maxTokens]),
    [
      ["qwen3:8b", true, ["text"], 40960, 10240],
      ["coder:64k", false, ["text", "image"], 65536, 16384],
    ],
  );
});

test("syncing writes the profile once and returns Milagre's models", async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-ollama-profile-"));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const { fetchImpl } = fakeOllama(ROUTES);
  const models = await syncOllamaModels({ profile, env: {}, fetchImpl });
  assert.deepEqual(
    models.map(({ id, efforts, recommended }) => [id, efforts, recommended]),
    [
      ["ollama:qwen3:8b", ["low", "medium", "high"], true],
      ["ollama:coder:64k", [], false],
    ],
  );
  const written = JSON.parse(fs.readFileSync(path.join(profile, "models.json"), "utf8"));
  assert.equal(written.providers.ollama.models.length, 2);
});

test("OLLAMA_HOST picks the local server's address", () => {
  assert.equal(ollamaUrl({}), "http://127.0.0.1:11434");
  assert.equal(ollamaUrl({ OLLAMA_HOST: "0.0.0.0" }), "http://127.0.0.1:11434");
  assert.equal(ollamaUrl({ OLLAMA_HOST: "127.0.0.1:11500" }), "http://127.0.0.1:11500");
  assert.equal(ollamaUrl({ OLLAMA_HOST: "not a url::" }), "http://127.0.0.1:11434");
});
