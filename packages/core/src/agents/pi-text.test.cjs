const assert = require("node:assert/strict");
const test = require("node:test");
const { textModel } = require("./pi-text.cjs");

const LOCAL = [
  { name: "coder:27b", capabilities: ["tools"], loaded: false },
  { name: "qwen3:8b", capabilities: ["tools"], loaded: true },
];
const HOSTED = [
  { provider: "openrouter", id: "z-ai/glm-4.6", cost: { input: 0.4, output: 1.75 } },
  { provider: "groq", id: "llama-3.1-8b-instant", cost: { input: 0.05, output: 0.08 } },
];

test("helper text comes from the Chat's hosted model, else the loaded local one, else the cheapest paid hosted one", () => {
  assert.deepEqual(textModel({ local: LOCAL, reported: HOSTED }), { provider: "ollama", id: "qwen3:8b" });
  assert.deepEqual(textModel({ local: null, reported: HOSTED }), { provider: "groq", id: "llama-3.1-8b-instant" });
  assert.deepEqual(textModel({ local: LOCAL, reported: HOSTED }, { hostedOnly: true }), { provider: "groq", id: "llama-3.1-8b-instant" });
  assert.equal(textModel({ local: null, reported: [] }), null);
  const free = { provider: "openrouter", id: "google/gemma-4-26b-a4b-it:free", cost: { input: 0, output: 0 } };
  assert.deepEqual(textModel({ local: null, reported: [free, ...HOSTED] }), { provider: "groq", id: "llama-3.1-8b-instant" });
  assert.deepEqual(textModel({ local: null, reported: [free] }), { provider: "openrouter", id: "google/gemma-4-26b-a4b-it:free" });
  assert.deepEqual(textModel({ local: LOCAL, reported: HOSTED }, { hostedOnly: true, preferred: "pi:openrouter/z-ai/glm-4.6" }), {
    provider: "openrouter",
    id: "z-ai/glm-4.6",
  });
});
