import assert from "node:assert/strict";
import test from "node:test";
import { KIRO_AGENT_OPTIONS, formatCredits, kiroModelId, kiroModels, resolveKiroModel } from "./kiro-models.mjs";

const OPTIONS = [
  { value: "auto", name: "Auto", description: "Models chosen by task", _meta: { kiro: { rateMultiplier: 1, rateUnit: "Credit", hasEffort: false } } },
  {
    value: "gpt-5.6-sol",
    name: "GPT 5.6 Sol",
    description: "OpenAI GPT 5.6 Sol with 1M context window",
    _meta: { kiro: { rateMultiplier: 4.4, rateUnit: "Credit", effortLevels: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffortLevel: "high" } },
  },
  { value: "qwen3-coder-next", name: "Qwen3 Coder Next", _meta: { kiro: { rateMultiplier: 0.05 } } },
];

test("Kiro's models keep its order, its credit multipliers and its efforts, with Auto recommended", () => {
  assert.deepEqual(kiroModels(OPTIONS), [
    { id: "kiro:auto", name: "Auto", description: "Models chosen by task", recommended: true, efforts: [], ultracode: false, fastMode: false, credits: 1 },
    {
      id: "kiro:gpt-5.6-sol",
      name: "GPT 5.6 Sol",
      description: "OpenAI GPT 5.6 Sol with 1M context window",
      recommended: false,
      // "none" switches reasoning off; Milagre's efforts are thinking levels.
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
      ultracode: false,
      fastMode: false,
      credits: 4.4,
    },
    {
      id: "kiro:qwen3-coder-next",
      name: "Qwen3 Coder Next",
      description: "",
      recommended: false,
      efforts: [],
      ultracode: false,
      fastMode: false,
      credits: 0.05,
    },
  ]);
});

test("without a session's list the catalog stands in", () => {
  assert.deepEqual(
    kiroModels(null).map((model) => model.id),
    KIRO_AGENT_OPTIONS.map((option) => kiroModelId(option.value)),
  );
  assert.equal(kiroModels([{ value: "" }, null]).length, KIRO_AGENT_OPTIONS.length);
});

test("Milagre's ids carry a kiro: prefix that Kiro never sees", () => {
  assert.equal(resolveKiroModel("kiro:claude-opus-5.5"), "claude-opus-5.5");
  assert.equal(resolveKiroModel("claude-opus-5.5"), "claude-opus-5.5");
  assert.equal(resolveKiroModel(undefined), undefined);
});

test("a multiplier reads as Kiro shows it", () => {
  assert.equal(formatCredits(2), "2×");
  assert.equal(formatCredits(1.3), "1.3×");
  assert.equal(formatCredits(0.06), "0.06×");
  assert.equal(formatCredits(0.333333), "0.33×");
});
