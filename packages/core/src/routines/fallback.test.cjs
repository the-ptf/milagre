const assert = require("node:assert/strict");
const test = require("node:test");
const { defaultFallback, providerFailure } = require("./fallback.cjs");

test("provider-side failures are told from task failures", () => {
  for (const error of [
    "Selected model is at capacity. Please try a different model.",
    "Codex stopped unexpectedly: Codex exited with code 1. Send your message again to continue this chat.",
    "Claude Code stopped unexpectedly: Claude Code exited with signal SIGKILL. Send your message again to continue this chat.",
    "API Error: 529 Overloaded",
    "Rate limit reached for requests",
    "429 Too Many Requests",
  ])
    assert.equal(providerFailure(error), true, error);
  for (const error of ["cancelled", "turn failed", "npm test failed", "Codex (codex) didn't start: not found", "", undefined])
    assert.equal(providerFailure(error), false, String(error));
  // A turn the plan's usage limit stopped carries the limit, whatever it says.
  assert.equal(providerFailure("You're out of extra usage", { type: "turn-failed", limit: { provider: "claude" } }), true);
});

const ready = { state: "ready" };
const models = {
  codex: [
    { id: "gpt-6-astra", recommended: false },
    { id: "gpt-6.1-sol", recommended: true },
  ],
  claude: [{ id: "claude-sonnet-5-5" }, { id: "claude-opus-5-5", recommended: true }],
  antigravity: [{ id: "gemini-3-pro", recommended: true }],
  kiro: null,
};

test("the automatic fallback is another ready provider's recommended model, Codex and Claude first", () => {
  const status = { codex: ready, claude: ready, antigravity: ready, kiro: { state: "missing" } };
  assert.deepEqual(defaultFallback("codex", status, models), { provider: "claude", model: "claude-opus-5-5" });
  assert.deepEqual(defaultFallback("claude", status, models), { provider: "codex", model: "gpt-6.1-sol" });
  assert.deepEqual(defaultFallback("antigravity", status, models), { provider: "codex", model: "gpt-6.1-sol" });
  // A Routine on no named provider ran on Claude, the adapter's default.
  assert.deepEqual(defaultFallback(undefined, status, models), { provider: "codex", model: "gpt-6.1-sol" });
});

test("a provider that isn't ready, or reports no models, is skipped; none left gives null", () => {
  assert.deepEqual(defaultFallback("codex", { codex: ready, claude: { state: "logged-out" }, antigravity: ready }, models), {
    provider: "antigravity",
    model: "gemini-3-pro",
  });
  assert.deepEqual(defaultFallback("codex", { claude: ready }, { ...models, claude: [{ id: "claude-haiku-5-5" }] }), {
    provider: "claude",
    model: "claude-haiku-5-5",
  });
  assert.equal(defaultFallback("codex", { claude: ready }, { claude: [] }), null);
  assert.equal(defaultFallback("codex", { codex: ready }, models), null);
});
