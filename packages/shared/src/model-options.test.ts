import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANTIGRAVITY_AGENT_OPTIONS,
  MODEL_CATALOG,
  antigravityFamilies,
  capabilityFor,
  contextWindowFor,
  familySlug,
  resolveAntigravityModel,
  splitModelName,
} from "./model-options.ts";

test("Antigravity's per-level models group into one family per name, levels as efforts", () => {
  const families = antigravityFamilies(ANTIGRAVITY_AGENT_OPTIONS);
  assert.deepEqual(
    families.map(({ id, name, efforts, defaultEffort }) => ({ id, name, efforts, defaultEffort })),
    [
      { id: "gemini-4-argon", name: "Gemini 4 Argon", efforts: ["low", "medium", "high"], defaultEffort: "high" },
      { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"], defaultEffort: "high" },
    ],
  );
});

test("a name without a level is its own family with no efforts; unknown levels sort after low, medium and high", () => {
  const families = antigravityFamilies([
    { value: "preview-id", name: "Gemini 4 Preview", description: "A preview" },
    { value: "x-turbo", name: "Gemini X (Turbo)" },
    { value: "x-high", name: "Gemini X (High)" },
    { value: "x-low", name: "Gemini X (Low)" },
    { value: "x-low-again", name: "Gemini X (Low)" },
    { value: "bare" },
  ]);
  assert.deepEqual(
    families.map(({ id, efforts, variants }) => ({ id, efforts, variants })),
    [
      { id: "gemini-4-preview", efforts: [], variants: { "": "preview-id" } },
      { id: "gemini-x", efforts: ["low", "high", "turbo"], variants: { turbo: "x-turbo", high: "x-high", low: "x-low" } },
      { id: "bare", efforts: [], variants: { "": "bare" } },
    ],
  );
  assert.equal(resolveAntigravityModel(families, "gemini-4-preview", "high"), "preview-id");
  assert.equal(resolveAntigravityModel(families, "gemini-x", "turbo"), "x-turbo");
  assert.deepEqual(splitModelName("Gemini 3.1 Pro (High)"), { family: "Gemini 3.1 Pro", level: "high" });
  assert.deepEqual(splitModelName("Gemini 4 Preview"), { family: "Gemini 4 Preview", level: null });
  assert.equal(familySlug("Gemini 3.1 Pro"), "gemini-3.1-pro");
});

test("Antigravity partner families keep their provider identity and Thinking is a model label, not an effort", () => {
  const families = antigravityFamilies([
    { value: "sonnet-low", name: "Claude Sonnet 5.5 (Low)" },
    { value: "sonnet-high", name: "Claude Sonnet 5.5 (High)" },
    { value: "opus-thinking", name: "Claude Opus 4.6 (Thinking)" },
    { value: "oss-medium", name: "GPT-OSS 120B (Medium)" },
  ]);
  assert.deepEqual(
    families.map(({ id, efforts }) => ({ id, efforts })),
    [
      { id: "antigravity:claude-sonnet-5.5", efforts: ["low", "high"] },
      { id: "antigravity:claude-opus-4.6-thinking", efforts: [] },
      { id: "antigravity:gpt-oss-120b", efforts: ["medium"] },
    ],
  );
  assert.equal(resolveAntigravityModel(families, "antigravity:claude-sonnet-5.5", "low"), "sonnet-low");
  assert.equal(resolveAntigravityModel(families, "antigravity:claude-opus-4.6-thinking", "high"), "opus-thinking");
  // Saved family IDs from before provider namespacing still resolve within an Antigravity session.
  assert.equal(resolveAntigravityModel(families, "claude-sonnet-5.5", "high"), "sonnet-high");
});

test("the session's current model sets its family's default effort", () => {
  const families = antigravityFamilies(ANTIGRAVITY_AGENT_OPTIONS, "gemini-3.8-flash-medium");
  assert.equal(families[0].defaultEffort, "high");
  assert.equal(families[1].defaultEffort, "medium");
  assert.equal(resolveAntigravityModel(families, "gemini-3.8-flash"), "gemini-3.8-flash-medium");
});

test("resolveAntigravityModel maps a family and effort to the agent id, keeps raw agent ids, and knows nothing else", () => {
  const families = antigravityFamilies([
    ...ANTIGRAVITY_AGENT_OPTIONS,
    { value: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)" },
    { value: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
  ]);
  assert.equal(resolveAntigravityModel(families, "gemini-3.1-pro", "high"), "gemini-pro-agent");
  assert.equal(resolveAntigravityModel(families, "gemini-3.1-pro", "low"), "gemini-3.1-pro-low");
  // Pro has no Medium: its default effort.
  assert.equal(resolveAntigravityModel(families, "gemini-3.1-pro", "medium"), "gemini-pro-agent");
  assert.equal(resolveAntigravityModel(families, "gemini-3.8-flash", undefined), "gemini-3.8-flash-high");
  assert.equal(resolveAntigravityModel(families, "gemini-3.8-flash-low", "high"), "gemini-3.8-flash-low");
  for (const effort of ["low", "medium", "high"]) {
    assert.equal(resolveAntigravityModel(families, "gemini-4-argon", effort), `gemini-4-argon-${effort}`);
  }
  assert.equal(resolveAntigravityModel(families, "nope", "high"), undefined);
  assert.equal(resolveAntigravityModel(families, undefined, "high"), undefined);
});

test("the catalog offers current ACP families and their efforts without Enterprise-only models", () => {
  const antigravity = MODEL_CATALOG.filter((model) => model.provider === "antigravity");
  assert.deepEqual(
    antigravity.map((model) => [model.id, model.name, model.description, model.recommended === true]),
    [
      ["gemini-4-argon", "Gemini 4 Argon", "For complex work", true],
      ["gemini-3.8-flash", "Gemini 3.8 Flash", "Fast", true],
    ],
  );
  assert.deepEqual(capabilityFor(antigravity[1], null), { efforts: ["low", "medium", "high"], defaultEffort: "high", ultracode: false, fastMode: false });
  assert.deepEqual(capabilityFor(antigravity[0], null), { efforts: ["low", "medium", "high"], defaultEffort: "high", ultracode: false, fastMode: false });
  // A raw agent id saved by an older chat has no effort control.
  assert.deepEqual(capabilityFor({ id: "gemini-pro-agent", name: "x", provider: "antigravity", description: "" }, null), {
    efforts: [],
    ultracode: false,
    fastMode: false,
  });
});

test("each model's context window: 1M Claude from Opus 4.7 on, 200K before it, 272K GPT, about 1M Gemini", () => {
  const window = (provider: "claude" | "codex" | "antigravity", id: string) => contextWindowFor({ provider, id });
  for (const id of ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5", "claude-haiku-5-5", "claude-opus-4-7", "claude-opus-4-8"])
    assert.equal(window("claude", id), 1_000_000, id);
  for (const id of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-5", "claude-opus-4-1", "claude-opus-4", "claude-3-7-sonnet"])
    assert.equal(window("claude", id), 200_000, id);
  assert.equal(window("codex", "gpt-6.1-sol"), 272_000);
  assert.equal(window("antigravity", "gemini-3.1-pro"), 1_048_576);
  assert.equal(window("antigravity", "claude-sonnet-4-6"), undefined);
});
