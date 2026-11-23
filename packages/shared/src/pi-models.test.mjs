import assert from "node:assert/strict";
import test from "node:test";
import {
  formatContext,
  isLocalPiModel,
  ollamaModels,
  piCloudModels,
  piModelId,
  piModels,
  piStatsParts,
  resolvePiModel,
  turnMetricsParts,
  unlistedPiModel,
} from "./pi-models.mjs";
import { currentModelId, currentProvider } from "./providers.mjs";
import { contextWindowFor, modelMatches } from "./model-options.ts";

test("ids name Pi's provider and model; the ids Ollama Chats saved still resolve", () => {
  assert.equal(piModelId("openrouter", "z-ai/glm-4.6"), "pi:openrouter/z-ai/glm-4.6");
  assert.deepEqual(resolvePiModel("pi:openrouter/z-ai/glm-4.6"), { provider: "openrouter", id: "z-ai/glm-4.6" });
  assert.deepEqual(resolvePiModel("pi:ollama/qwen3:8b"), { provider: "ollama", id: "qwen3:8b" });
  assert.deepEqual(resolvePiModel("ollama:qwen3:8b"), { provider: "ollama", id: "qwen3:8b" });
  assert.deepEqual(resolvePiModel("llama3"), { provider: "ollama", id: "llama3" });
  assert.equal(resolvePiModel("pi:broken"), undefined);
  assert.equal(resolvePiModel(undefined), undefined);
  assert.equal(isLocalPiModel("ollama:qwen3:8b"), true);
  assert.equal(isLocalPiModel("pi:groq/llama-3.1-8b-instant"), false);
  assert.equal(currentModelId("ollama:qwen3:8b"), "pi:ollama/qwen3:8b");
  assert.equal(currentProvider("ollama"), "pi");
  assert.equal(currentProvider("claude"), "claude");
});

test("only tool-calling local models are offered; thinking ones get efforts, the newest is recommended", () => {
  const models = ollamaModels([
    { name: "qwen3:8b", parameterSize: "8.2B", quantization: "Q4_K_M", capabilities: ["completion", "tools", "thinking"], contextWindow: 40960 },
    { name: "embed", capabilities: ["embedding"] },
    { name: "coder", capabilities: ["tools"] },
  ]);
  assert.deepEqual(
    models.map(({ id, description, recommended, efforts, defaultEffort, contextWindow, group, local }) => ({
      id,
      description,
      recommended,
      efforts,
      defaultEffort,
      contextWindow,
      group,
      local,
    })),
    [
      {
        id: "pi:ollama/qwen3:8b",
        description: "8.2B · Q4_K_M · 40K context",
        recommended: true,
        efforts: ["low", "medium", "high"],
        defaultEffort: "low",
        contextWindow: 40960,
        group: "Ollama",
        local: true,
      },
      {
        id: "pi:ollama/coder",
        description: "Local model",
        recommended: false,
        efforts: [],
        defaultEffort: undefined,
        contextWindow: undefined,
        group: "Ollama",
        local: true,
      },
    ],
  );
});

const GLM = {
  id: "z-ai/glm-4.6",
  name: "Z.ai: GLM 4.6",
  provider: "openrouter",
  reasoning: true,
  contextWindow: 202752,
  cost: { input: 0.4, output: 1.75 },
};

test("hosted models carry their provider, price and the thinking levels they map", () => {
  const [glm, gpt, llama] = piCloudModels([
    GLM,
    {
      id: "gpt-5.6",
      name: "GPT-5.6",
      provider: "openai",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", minimal: null },
      contextWindow: 400000,
      cost: { input: 1.25, output: 10 },
    },
    { id: "llama-3.1-8b-instant", name: "Llama 3.1 8B", provider: "groq", reasoning: false, contextWindow: 131072, cost: { input: 0.05, output: 0.08 } },
    { id: "qwen3:8b", provider: "ollama" },
    GLM,
  ]);
  assert.equal(glm.id, "pi:openrouter/z-ai/glm-4.6");
  assert.equal(glm.group, "OpenRouter");
  assert.equal(glm.description, "OpenRouter · 198K context · $0.4 in · $1.75 out per 1M tokens");
  assert.deepEqual(glm.efforts, ["minimal", "low", "medium", "high"]);
  assert.equal(glm.defaultEffort, "medium");
  assert.deepEqual(gpt.efforts, ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(llama.efforts, []);
  assert.equal(llama.local, undefined);
  assert.equal(piCloudModels([{ id: "free", provider: "openrouter", cost: { input: 0, output: 0 } }])[0].description, "OpenRouter · Free");
});

test("local models come first; without one, the first hosted model is recommended", () => {
  const local = [{ name: "qwen3:8b", capabilities: ["tools"] }];
  assert.deepEqual(
    piModels(local, [GLM]).map((model) => [model.id, model.recommended]),
    [
      ["pi:ollama/qwen3:8b", true],
      ["pi:openrouter/z-ai/glm-4.6", false],
    ],
  );
  assert.equal(piModels(null, [GLM])[0].recommended, true);
  assert.deepEqual(piModels(null, []), []);
});

test("a Chat's model that isn't listed stays its model, marked as unavailable", () => {
  assert.equal(unlistedPiModel("ollama:llama3").id, "pi:ollama/llama3");
  assert.equal(unlistedPiModel("ollama:llama3").local, true);
  assert.equal(unlistedPiModel("pi:openrouter/z-ai/glm-4.6").description, "OpenRouter isn't connected to Pi right now");
});

test("the picker shows a Pi model's context window and finds it by its provider", () => {
  assert.equal(contextWindowFor({ provider: "pi", id: "pi:ollama/qwen3:8b", contextWindow: 65536 }), 65536);
  assert.equal(contextWindowFor({ provider: "pi", id: "pi:ollama/qwen3:8b" }), undefined);
  assert.equal(formatContext(65536), "64K");
  assert.equal(modelMatches({ name: "GLM 4.6", id: "pi:openrouter/z-ai/glm-4.6", group: "OpenRouter" }, "openrouter"), true);
  assert.equal(modelMatches({ name: "GLM 4.6", id: "pi:openrouter/z-ai/glm-4.6", group: "OpenRouter" }, "groq"), false);
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

test("the line under a Pi Chat: metrics for a local model, spend once a paid model cost something", () => {
  const usage = { used: 10, size: 100, metrics: { outputTps: 30 }, cost: 0.4237 };
  assert.deepEqual(
    piStatsParts(usage, { local: true }).map((part) => part.text),
    ["30 tok/s", "$0.42 spent"],
  );
  assert.deepEqual(
    piStatsParts(usage, { local: false }).map((part) => part.text),
    ["$0.42 spent"],
  );
  assert.deepEqual(
    piStatsParts({ used: 1, size: 2, cost: 0.004 }, { local: false }).map((part) => part.text),
    ["<$0.01 spent"],
  );
  assert.deepEqual(piStatsParts({ used: 1, size: 2 }, { local: false }), []);
});
