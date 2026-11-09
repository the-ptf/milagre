import assert from "node:assert/strict";
import { test } from "node:test";
import { advisorResultLabel, messageSender } from "./advisor-result.ts";
test("advisor context identifies the provider and outcome as app-owned input", () => {
  assert.equal(
    advisorResultLabel({ kind: "advisor-result", advisorId: "advisor:a", completionId: "1", title: "Review", provider: "codex", outcome: "completed" }),
    "Codex advisor result: Review",
  );
  assert.equal(
    advisorResultLabel({
      kind: "advisor-result",
      advisorId: "advisor:a",
      completionId: "1",
      title: "Run app",
      provider: "codex",
      outcome: "completed",
      mode: "execution",
    }),
    "Codex execution agent result: Run app",
  );
  assert.match(
    advisorResultLabel({ kind: "advisor-result", advisorId: "advisor:a", completionId: "1", title: "Review", provider: "claude", outcome: "failed" }),
    /^Claude advisor failed:/,
  );
});

test("advisor messages remain app-owned in client navigation", () => {
  const context = {
    kind: "advisor-result" as const,
    advisorId: "advisor:a",
    completionId: "1",
    title: "Review",
    provider: "codex" as const,
    outcome: "completed" as const,
  };
  assert.equal(messageSender({ role: "user", context }), "app");
  assert.equal(messageSender({ role: "user", context: null }), "user");
  assert.equal(messageSender({ role: "assistant", context: null }), "assistant");
});
