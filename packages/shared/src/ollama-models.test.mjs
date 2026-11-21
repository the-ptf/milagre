import assert from "node:assert/strict";
import test from "node:test";
import { formatContext, ollamaModelId, ollamaModels, resolveOllamaModel, turnMetricsParts } from "./ollama-models.mjs";
import { contextWindowFor } from "./model-options.ts";

test("ids carry the ollama: prefix and resolve back to Ollama's name", () => {
  assert.equal(ollamaModelId("qwen3:8b"), "ollama:qwen3:8b");
  assert.equal(resolveOllamaModel("ollama:qwen3:8b"), "qwen3:8b");
  assert.equal(resolveOllamaModel("llama3"), "llama3");
  assert.equal(resolveOllamaModel(undefined), undefined);
});

test("only tool-calling models are offered; thinking ones get efforts, the newest is recommended", () => {
  const models = ollamaModels([
    { name: "qwen3:8b", parameterSize: "8.2B", quantization: "Q4_K_M", capabilities: ["completion", "tools", "thinking"], contextWindow: 40960 },
    { name: "embed", capabilities: ["embedding"] },
    { name: "coder", capabilities: ["tools"] },
  ]);
  assert.deepEqual(
    models.map(({ id, description, recommended, efforts, defaultEffort, contextWindow }) => ({
      id,
      description,
      recommended,
      efforts,
      defaultEffort,
      contextWindow,
    })),
    [
      {
        id: "ollama:qwen3:8b",
        description: "8.2B · Q4_K_M · 40K context",
        recommended: true,
        efforts: ["low", "medium", "high"],
        defaultEffort: "low",
        contextWindow: 40960,
      },
      { id: "ollama:coder", description: "Local model", recommended: false, efforts: [], defaultEffort: undefined, contextWindow: undefined },
    ],
  );
});

test("the picker shows an Ollama model's own context window", () => {
  assert.equal(contextWindowFor({ provider: "ollama", id: "ollama:qwen3:8b", contextWindow: 65536 }), 65536);
  assert.equal(contextWindowFor({ provider: "ollama", id: "ollama:qwen3:8b" }), undefined);
  assert.equal(formatContext(65536), "64K");
});

test("a turn's metrics read as short parts", () => {
  assert.deepEqual(
    turnMetricsParts({ ttftMs: 4210, outputTps: 31.5, prefillTps: 819.6, inputTokens: 22865, outputTokens: 87, calls: 3, durationMs: 61_000 }).map(
      (part) => part.text,
    ),
    ["TTFT 4.2s", "31.5 tok/s", "prefill 820 tok/s", "23K in · 87 out", "61s"],
  );
  assert.deepEqual(turnMetricsParts(null), []);
  assert.deepEqual(
    turnMetricsParts({ outputTokens: 5 }).map((part) => part.text),
    ["0 in · 5 out"],
  );
});
