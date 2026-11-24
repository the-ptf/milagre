const assert = require("node:assert/strict");
const test = require("node:test");
const { ollamaProvider, ollamaUrl, readOllamaModels } = require("./ollama.cjs");
const { ROUTES, fakeOllama } = require("./fixtures/fake-ollama.cjs");

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

test("Pi's ollama provider lists only the models that can call tools", async () => {
  const { fetchImpl } = fakeOllama(ROUTES);
  const provider = ollamaProvider(await readOllamaModels({ env: {}, fetchImpl }), {});
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

test("OLLAMA_HOST picks the local server's address", () => {
  assert.equal(ollamaUrl({}), "http://127.0.0.1:11434");
  assert.equal(ollamaUrl({ OLLAMA_HOST: "0.0.0.0" }), "http://127.0.0.1:11434");
  assert.equal(ollamaUrl({ OLLAMA_HOST: "127.0.0.1:11500" }), "http://127.0.0.1:11500");
  assert.equal(ollamaUrl({ OLLAMA_HOST: "not a url::" }), "http://127.0.0.1:11434");
});
