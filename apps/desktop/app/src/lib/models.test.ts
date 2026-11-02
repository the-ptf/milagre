import assert from "node:assert/strict";
import test from "node:test";
import type { AgentModels, ModelOption, ReportedModel } from "../model";
import { capabilitiesFrom, keepIfSame, mergeModels, nextSelection, providerForId, resolveModel } from "./models.ts";
import { MODEL_CATALOG, capabilityFor } from "../model.ts";

test("until the agents answer, fast mode is guessed for Codex and the Opus models Claude Code offers it on", () => {
  const option = (id: string): ModelOption => ({ id, name: id, provider: id.startsWith("gpt") ? "codex" : "claude", description: "" });
  for (const id of ["gpt-6.1-sol", "gpt-5.5", "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"])
    assert.equal(capabilityFor(option(id), null).fastMode, true, id);
  for (const id of ["claude-fable-5-1", "claude-opus-4-7", "claude-sonnet-5-5", "claude-haiku-4-5"])
    assert.equal(capabilityFor(option(id), null).fastMode, false, id);
});

test("a reported capability decides fast mode, whatever the guess", () => {
  const capabilities = {
    codex: { "gpt-5.5": { efforts: [], ultracode: false, fastMode: false } },
    claude: { "claude-fable-5-1": { efforts: [], ultracode: true, fastMode: true } },
  };
  assert.equal(capabilityFor({ id: "gpt-5.5", name: "", provider: "codex", description: "" }, capabilities).fastMode, false);
  assert.equal(capabilityFor({ id: "claude-fable-5-1", name: "", provider: "claude", description: "" }, capabilities).fastMode, true);
});

const fallback: ModelOption[] = [
  { id: "gpt-6-astra", name: "GPT-6-Astra", provider: "codex", description: "Frontier", recommended: true },
  { id: "gpt-6-sol", name: "GPT-6-Sol", provider: "codex", description: "Workhorse" },
  { id: "claude-opus-5-5", name: "Opus 5.5", provider: "claude", description: "Everyday", recommended: true },
  { id: "claude-sonnet-4-6", name: "Sonnet 4.6", provider: "claude", description: "Routine" },
];
const reported = (id: string, extra: Partial<ReportedModel> = {}): ReportedModel => ({
  id,
  name: id.toUpperCase(),
  description: `${id} model`,
  recommended: false,
  efforts: ["low", "high"],
  ultracode: false,
  fastMode: false,
  ...extra,
});

test("each agent's own list replaces the maintained one, recommended model first", () => {
  const models: AgentModels = { codex: [reported("gpt-5.5"), reported("gpt-6.1-sol", { recommended: true })], claude: null };
  assert.deepEqual(mergeModels(models, fallback), [
    { id: "gpt-6.1-sol", name: "GPT-6.1-SOL", provider: "codex", description: "gpt-6.1-sol model", recommended: true },
    { id: "gpt-5.5", name: "GPT-5.5", provider: "codex", description: "gpt-5.5 model" },
    fallback[2],
    fallback[3],
  ]);
});

test("the maintained list stands in while nothing is reported, or for an empty list", () => {
  assert.deepEqual(mergeModels(null, fallback), fallback);
  assert.deepEqual(mergeModels({ codex: [], claude: null }, fallback), fallback);
});

test("capabilities come from the reported models", () => {
  const models: AgentModels = {
    codex: [reported("gpt-6-sol", { efforts: ["low", "ultra"], defaultEffort: "medium", fastMode: true })],
    claude: [reported("claude-opus-5-5", { efforts: ["low", "xhigh"], ultracode: true, fastMode: true })],
  };
  assert.deepEqual(capabilitiesFrom(models), {
    codex: { "gpt-6-sol": { efforts: ["low", "ultra"], defaultEffort: "medium", ultracode: false, fastMode: true } },
    claude: { "claude-opus-5-5": { efforts: ["low", "xhigh"], ultracode: true, fastMode: true } },
    antigravity: {},
    kiro: {},
  });
  assert.deepEqual(capabilitiesFrom({ codex: null, claude: null, antigravity: null, kiro: null }), { codex: {}, claude: {}, antigravity: {}, kiro: {} });
  assert.equal(capabilitiesFrom(null), null);
});

test("a model no longer offered gives way to its provider's recommended one", () => {
  assert.equal(resolveModel(fallback, "gpt-6-sol", "codex").id, "gpt-6-sol");
  assert.equal(resolveModel(fallback, "gpt-6.1-sol", "codex").id, "gpt-6-astra");
  assert.equal(resolveModel(fallback, "claude-sonnet-4-5", "claude").id, "claude-opus-5-5");
  assert.equal(
    resolveModel(
      fallback.filter((model) => !model.recommended),
      undefined,
      "claude",
    ).id,
    "claude-sonnet-4-6",
  );
});

const catalog: ModelOption[] = [
  { id: "gpt-6-astra", name: "GPT-6-Astra", provider: "codex", description: "", recommended: true },
  { id: "gpt-6-sol", name: "GPT-6-Sol", provider: "codex", description: "" },
  { id: "claude-opus-5-5", name: "Opus 5.5", provider: "claude", description: "", recommended: true },
  { id: "claude-haiku-4-5", name: "Haiku 4.5", provider: "claude", description: "" },
];
const pick = (id: string) => catalog.find((model) => model.id === id)!;

test("a Claude chat stays on its model when the default is a Codex model", () => {
  const current = pick("claude-haiku-4-5");
  assert.equal(nextSelection(catalog, current, { defaultId: "gpt-6-astra", applyDefault: true, preferredProvider: "claude" }), current);
  assert.equal(nextSelection(catalog, current, { defaultId: "gpt-6-astra", applyDefault: false, preferredProvider: "claude" }), current);
});

test("a pick on the other provider survives a refetch of the lists", () => {
  const picked = pick("gpt-6-sol");
  assert.equal(nextSelection(catalog, picked, { defaultId: "claude-haiku-4-5", applyDefault: false, preferredProvider: "claude" }), picked);
});

test("the Settings default replaces the starting model once, when no chat prefers a provider", () => {
  assert.equal(nextSelection(catalog, pick("gpt-6-astra"), { defaultId: "claude-haiku-4-5", applyDefault: true }).id, "claude-haiku-4-5");
  assert.equal(nextSelection(catalog, pick("gpt-6-astra"), { defaultId: "claude-haiku-4-5", applyDefault: false }).id, "gpt-6-astra");
  assert.equal(
    nextSelection(catalog, pick("gpt-6-astra"), { defaultId: "claude-haiku-4-5", applyDefault: true, preferredProvider: "codex" }).id,
    "gpt-6-astra",
  );
});

test("a refetch with identical lists changes nothing", () => {
  const current = pick("claude-haiku-4-5");
  const again = catalog.map((model) => ({ ...model }));
  assert.equal(nextSelection(again, current, { defaultId: "gpt-6-astra", applyDefault: false }), current);
  const lists = { codex: [{ id: "a" }], claude: null };
  assert.equal(keepIfSame(lists, JSON.parse(JSON.stringify(lists))), lists);
  assert.notEqual(keepIfSame(lists, { codex: [{ id: "b" }], claude: null }), lists);
});

test("a stale id gives way to its provider's recommended model", () => {
  assert.equal(
    nextSelection(catalog, { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", provider: "codex", description: "" }, { defaultId: "gpt-6.1-sol", applyDefault: false })
      .id,
    "gpt-6-astra",
  );
  assert.equal(
    nextSelection(catalog, { id: "claude-sonnet-4-5", name: "Sonnet 4.5", provider: "claude", description: "" }, { defaultId: "x", applyDefault: false }).id,
    "claude-opus-5-5",
  );
  // a stale default applies to its own provider
  assert.equal(nextSelection(catalog, pick("gpt-6-astra"), { defaultId: "claude-sonnet-4-5", applyDefault: true }).id, "claude-opus-5-5");
  assert.equal(nextSelection(catalog, pick("claude-opus-5-5"), { defaultId: "gpt-6.1-sol", applyDefault: true }).id, "gpt-6-astra");
  assert.equal(providerForId("claude-sonnet-4-5"), "claude");
  assert.equal(providerForId("gpt-6.1-sol"), "codex");
  assert.equal(providerForId("gemini-3.8-flash-high"), "antigravity");
  assert.equal(providerForId("gemini-pro-agent"), "antigravity");
  assert.equal(providerForId("antigravity:claude-sonnet-5.5"), "antigravity");
  assert.equal(providerForId("antigravity:gpt-oss-120b"), "antigravity");
});

test("Antigravity's picker shows one row per model family, with the family's thinking levels as efforts", () => {
  const antigravity = mergeModels(null, MODEL_CATALOG).filter((model) => model.provider === "antigravity");
  assert.deepEqual(
    antigravity.map((model) => model.name),
    ["Gemini 4 Argon", "Gemini 3.8 Flash"],
  );
  assert.deepEqual(capabilityFor(antigravity[0], null).efforts, ["low", "medium", "high"]);
  const reportedList: AgentModels = {
    codex: null,
    claude: null,
    antigravity: [reported("gemini-3.1-pro", { efforts: ["low", "high"], defaultEffort: "low" })],
  };
  assert.deepEqual(capabilitiesFrom(reportedList)?.antigravity, {
    "gemini-3.1-pro": { efforts: ["low", "high"], defaultEffort: "low", ultracode: false, fastMode: false },
  });
});

test("an empty refresh preserves the current selection and direct resolution has a maintained fallback", () => {
  const current = MODEL_CATALOG[1];
  assert.ok(current);
  assert.equal(nextSelection([], current, { defaultId: MODEL_CATALOG[0].id, applyDefault: true }), current);
  assert.equal(resolveModel([], undefined, "codex"), MODEL_CATALOG[0]);
  assert.equal(resolveModel([], undefined, "claude").provider, "claude");
  assert.equal(resolveModel([], undefined, "antigravity").provider, "antigravity");
});
