import assert from "node:assert/strict";
import { test } from "node:test";
import { agentActivityLabel, subagentActivityLabel } from "./agent-activity.ts";

test("activity labels describe the current action in at most two words", () => {
  for (const [activity, expected] of [
    ["Reading auth.ts", "Reading files"],
    ["Running auth tests", "Running tests"],
    ["Ran `npm test`", "Running tests"],
    ["Edited `src/auth.ts`", "Editing files"],
    ["Searching for callers", "Searching"],
    ["Responding", "Responding"],
    ["Unrecognized tool output", "Thinking"],
    ["", "Thinking"],
  ])
    assert.equal(agentActivityLabel(activity), expected);
});

test("terminal and waiting states override stale activity", () => {
  for (const [status, expected] of [
    ["waiting", "Waiting"],
    ["completed", "Done"],
    ["failed", "Needs attention"],
    ["cancelled", "Stopped"],
    ["initializing", "Waking up"],
    ["unknown", "Status unavailable"],
  ] as const)
    assert.equal(subagentActivityLabel({ status, latestActivity: "Running tests" }), expected);
  assert.equal(subagentActivityLabel({ status: "running", latestActivity: "Reading auth.ts" }), "Reading files");
});

test("advisor controls identify ownership and expose Stop or Retry only in valid states", async () => {
  const { advisorAction, subagentRoleLabel } = await import("./agent-activity.ts");
  const base = { source: "milagre-advisor" as const, provider: "codex" as const };
  assert.equal(subagentRoleLabel(base), "Codex advisor");
  assert.equal(subagentRoleLabel({ ...base, mode: "execution" }), "Codex execution agent");
  for (const status of ["initializing", "running", "waiting"] as const) assert.equal(advisorAction({ ...base, status }), "stop");
  for (const status of ["failed", "cancelled", "unknown"] as const) assert.equal(advisorAction({ ...base, status, retryable: true }), "retry");
  assert.equal(advisorAction({ ...base, status: "completed" }), null);
  assert.equal(advisorAction({ status: "running" }), null);
});
