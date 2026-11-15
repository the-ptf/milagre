import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentRun } from "@milagre/shared/agent-runs";
import { RESOLVED_STEP } from "@milagre/shared/artifact";
import { RunShapeReader, runShape, sameRunShape } from "./run-shape.ts";

const approval = { requestId: "a1", toolName: "Bash", input: {} } as unknown as AgentRun["approvals"][number];
const question = { requestId: "q1", questions: [] } as unknown as AgentRun["questions"][number];
const run = (patch: Partial<AgentRun> = {}): AgentRun => ({
  turnId: "t1",
  text: "",
  model: "m",
  startedAt: 100,
  steps: [],
  approvals: [],
  questions: [],
  answered: {},
  ...patch,
});
const step = (patch: Partial<AgentRun["steps"][number]>) => ({ id: "s", title: "Read", status: "done", ...patch }) as AgentRun["steps"][number];

test("streamed text and ordinary steps keep the same shape object", () => {
  const reader = new RunShapeReader();
  const first = reader.pick(run({ text: "Hel" }));
  assert.ok(first);
  assert.equal(reader.pick(run({ text: "Hello" })), first, "more text");
  assert.equal(reader.pick(run({ text: "Hello", steps: [step({ id: "1" })] })), first, "a tool step");
  assert.equal(reader.pick(run({ text: "Hello there", steps: [step({ id: "1" }), step({ id: "2", status: "running" })] })), first, "another");
});

test("the same turn object skips the work and returns the last shape", () => {
  const reader = new RunShapeReader();
  const same = run();
  const shape = reader.pick(same);
  assert.equal(reader.pick(same), shape);
  assert.equal(reader.pick(undefined), undefined);
  assert.equal(reader.pick(undefined), undefined);
});

test("a turn starting, asking, answering, switching mode or ending changes the shape", () => {
  const reader = new RunShapeReader();
  assert.equal(reader.pick(undefined), undefined, "no turn");
  const started = reader.pick(run());
  assert.ok(started, "a turn starts");
  const asking = reader.pick(run({ approvals: [approval] }));
  assert.notEqual(asking, started, "an approval");
  assert.deepEqual(asking?.approvals, [approval]);
  // The runs store reuses an unchanged request (reconcileState): a new list of the same requests is the same shape.
  assert.equal(reader.pick(run({ text: "more", approvals: [approval] })), asking);
  const questioned = reader.pick(run({ questions: [question] }));
  assert.notEqual(questioned, asking, "the approval answered, a question asked");
  assert.equal(questioned?.approvals.length, 0);
  assert.notEqual(reader.pick(run({ questions: [question], permissionMode: "full" })), questioned, "a mode switch");
  assert.notEqual(reader.pick(run({ turnId: "t2" })), questioned, "the next turn");
  assert.equal(reader.pick(undefined), undefined, "the turn ends");
});

test("waiting on subagents, Worktree setup, a resolved design comment and context usage move the shape", () => {
  const base = runShape(run());
  assert.equal(base.status, null);
  assert.equal(base.designActivity, 0);
  assert.equal(sameRunShape(base, runShape(run({ waitingForSubagents: true }))), false);
  const setup = runShape(run({ steps: [step({ kind: "setup", status: "running" } as Partial<AgentRun["steps"][number]>)] }));
  assert.equal(setup.status, "Running Worktree setup");
  assert.equal(sameRunShape(base, setup), false);
  const resolved = runShape(run({ steps: [step({ title: RESOLVED_STEP, status: "done" })] }));
  assert.equal(resolved.designActivity, 1);
  assert.equal(sameRunShape(base, resolved), false);
  assert.equal(sameRunShape(base, runShape(run({ steps: [step({ title: RESOLVED_STEP, status: "running" })] }))), true, "still resolving");
  const usage = { used: 10, size: 100 };
  const withUsage = runShape(run({ contextUsage: usage }));
  assert.equal(sameRunShape(base, withUsage), false);
  assert.equal(sameRunShape(withUsage, runShape(run({ contextUsage: { ...usage } }))), true, "same fields read again");
  assert.equal(sameRunShape(withUsage, runShape(run({ contextUsage: { used: 20, size: 100 } }))), false);
  assert.equal(sameRunShape(undefined, undefined), true);
  assert.equal(sameRunShape(base, undefined), false);
});
