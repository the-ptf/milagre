import assert from "node:assert/strict";
import test from "node:test";
import type { HandoffContext, ModelOption } from "../model";
import { handoffLabel } from "./handover.ts";

const models: ModelOption[] = [
  { id: "claude-opus-5-5", name: "Opus 5.5", provider: "claude", description: "" },
  { id: "gpt-6", name: "GPT-6", provider: "codex", description: "" },
];
const context = (from: HandoffContext["from"], to: HandoffContext["to"]): HandoffContext => ({ kind: "handoff", from, to, status: "done" });

test("a divider names each side by model when the catalog knows it, else by provider", () => {
  assert.deepEqual(handoffLabel(context({ provider: "claude", model: "claude-opus-5-5" }, { provider: "codex", model: "gpt-6" }), models), {
    from: "Opus 5.5",
    to: "GPT-6",
    restored: false,
  });
  assert.deepEqual(handoffLabel(context({ provider: "claude", model: "gone" }, { provider: "codex" }), models), {
    from: "Claude",
    to: "Codex",
    restored: false,
  });
});

test("a divider on one provider is a restore", () => {
  assert.equal(handoffLabel(context({ provider: "claude" }, { provider: "claude" }), models).restored, true);
});
