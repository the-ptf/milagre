import assert from "node:assert/strict";
import test from "node:test";
import {
  activityDuration,
  activitySources,
  stepDisplayTitle,
  stepSections,
  stepSource,
  summarizeStep,
  toolMetadata,
  waitingStepIds,
} from "./tool-activity.mjs";

test("tool inputs redact nested credentials, remain bounded and omit large design payloads", () => {
  const meta = toolMetadata("linear", "get_issue", { id: "ENG-12", headers: { Authorization: "secret-value" }, api_key: "private" });
  assert.equal(meta.source.server, "linear");
  assert.deepEqual(JSON.parse(meta.input), { id: "ENG-12", headers: { Authorization: "[redacted]" }, api_key: "[redacted]" });
  assert.ok(toolMetadata("web", "fetch", { query: "x".repeat(10_000) }).input.length < 4100);
  assert.equal(toolMetadata("milagre", "design_show", { document: "x".repeat(100_000) }).input, undefined);
});

test("source stacks deduplicate tools, recognize Linear and support saved messages without metadata", () => {
  const base = { id: "1", kind: "other", title: "Used `get_issue` from Linear", status: "done" };
  assert.equal(stepSource(base).linear, true);
  assert.equal(stepSource({ ...base, title: "Used `get_issue` from nonlinear" }).linear, false);
  assert.equal(activitySources([base, { ...base, id: "2" }, { ...base, kind: "shell", title: "Ran `ls`" }]).length, 2);
});

test("elapsed activity measures wall time across parallel calls and leaves unknown times blank", () => {
  const steps = [
    { startedAt: 1000, endedAt: 5000 },
    { startedAt: 2000, endedAt: 6000 },
  ];
  assert.equal(activityDuration(steps, false, 99_000), "5s");
  assert.equal(activityDuration(steps, true, 8000), "7s");
  assert.equal(activityDuration([{}], false, 99_000), "");
});

test("command input can span multiple lines without becoming part of output", () => {
  const input = "printf one\nprintf two";
  const parts = stepSections({ kind: "shell", input, detail: `$ ${input}\none\ntwo\n` });
  assert.equal(parts.input, input);
  assert.equal(parts.output, "one\ntwo\n");
  assert.deepEqual(stepSections({ kind: "shell", input, detail: "retained output tail" }), {
    inputLabel: "Command",
    input,
    outputLabel: "Output",
    output: "retained output tail",
  });
});

test("retained summaries distinguish failures, diff headers and explicit test counts", () => {
  assert.deepEqual(summarizeStep({ kind: "edit", status: "done", detail: "--- a\n+++ b\n-old\n+new\n+extra" }), { summary: "+2 -1" });
  assert.deepEqual(summarizeStep({ kind: "shell", status: "done", detail: "$ check\n# pass 38\n# fail 0\n" }), { summary: "38 passed" });
  assert.deepEqual(summarizeStep({ kind: "shell", status: "failed", detail: "$ check\nstarting\nError: missing header" }), {
    summary: "Failed",
    error: "Error: missing header",
  });
  assert.deepEqual(summarizeStep({ kind: "other", status: "done", detail: "A sentence about results." }), {});
  assert.deepEqual(summarizeStep({ kind: "shell", status: "failed", detail: "$ node --test\n✖ adds two numbers (1ms)\nℹ pass 0\nℹ fail 1" }), {
    summary: "1 failed · 0 passed",
    error: "✖ adds two numbers (1ms)",
  });
  assert.deepEqual(summarizeStep({ kind: "shell", status: "failed", detail: "$ check\nFAIL auth.spec.ts\n# pass 37\n# fail 1\n" }), {
    summary: "1 failed · 37 passed",
    error: "FAIL auth.spec.ts",
  });
});

test("Linear issue titles use the known issue key and readable live verbs", () => {
  const step = { kind: "other", title: "Used `get_issue` from linear", source: { server: "linear", name: "get_issue" }, input: '{"id":"ENG-12"}' };
  assert.equal(stepDisplayTitle(step), "Read `ENG-12` from Linear");
  assert.equal(stepDisplayTitle(step, true), "Reading `ENG-12` from Linear");
  assert.equal(stepDisplayTitle({ ...step, input: '{"id":"large truncated' }), "Read issue from Linear");
});

test("thought durations occupy the timing slot once, while old messages keep their title", () => {
  const step = { kind: "thinking", title: "Thought for 4s" };
  assert.equal(stepDisplayTitle({ ...step, durationMs: 4000 }), "Thought");
  assert.equal(stepDisplayTitle(step), "Thought for 4s");
});

test("only the approval's own step is waiting; questions do not pause unrelated calls", () => {
  assert.deepEqual(waitingStepIds([{ stepId: "a" }, {}, { stepId: "b" }]), ["a", "b"]);
});
