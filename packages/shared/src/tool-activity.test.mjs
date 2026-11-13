import assert from "node:assert/strict";
import test from "node:test";
import {
  activityDuration,
  activitySources,
  currentActivityStep,
  stepDisplayTitle,
  runStatusLabel,
  sendStatusLabel,
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

test("a Link Chat's Worktree step and its setup say which Project they are for", () => {
  const create = {
    kind: "other",
    status: "running",
    title: "Used `link_worktree_create` from milagre",
    source: { server: "milagre", name: "link_worktree_create" },
    input: '{"project":"api"}',
  };
  assert.equal(stepDisplayTitle(create), "Created Worktree in api");
  assert.equal(stepDisplayTitle(create, true), "Creating Worktree in api");
  assert.equal(stepDisplayTitle({ ...create, input: '{"project":"trunc' }), "Created Worktree");
  assert.equal(runStatusLabel([create]), "Creating Worktree in api");
  assert.equal(runStatusLabel([create, { id: "s", kind: "setup", status: "running", title: "Running setup `npm ci`" }]), "Running setup in api");
  assert.equal(runStatusLabel([{ id: "s", kind: "setup", status: "running", title: "Running setup `npm ci`" }]), "Running Worktree setup");
  assert.equal(
    runStatusLabel([
      { ...create, status: "done" },
      { kind: "shell", status: "running", title: "Ran `ls`" },
    ]),
    null,
  );
  assert.equal(runStatusLabel([{ kind: "thinking", status: "running", title: "Thinking", detail: "**Reading the loader**\n" }]), null);
  assert.equal(runStatusLabel(), null);
  assert.equal(sendStatusLabel({ creatingWorktree: true }), "Creating Worktree");
  assert.equal(sendStatusLabel({ provider: "codex" }), "Sending");
  assert.equal(sendStatusLabel({ sent: true, provider: "codex" }), "Starting Codex");
});

test("thought durations occupy the timing slot once, while old messages keep their title", () => {
  const step = { kind: "thinking", title: "Thought for 4s" };
  assert.equal(stepDisplayTitle({ ...step, durationMs: 4000 }), "Thought");
  assert.equal(stepDisplayTitle(step), "Thought for 4s");
});

test("only the approval's own step is waiting; questions do not pause unrelated calls", () => {
  assert.deepEqual(waitingStepIds([{ stepId: "a" }, {}, { stepId: "b" }]), ["a", "b"]);
});

test("live thinking follows the latest complete summary heading without exposing reasoning sentences", () => {
  const step = { kind: "thinking", title: "Thinking", status: "running", detail: "**Inspecting swipe events**\n\nI need to compare the fields." };
  assert.equal(stepDisplayTitle(step, true), "Inspecting swipe events");
  assert.equal(stepDisplayTitle({ ...step, detail: step.detail + "\n\n**Rebuilding with recorded swipe" }, true), "Inspecting swipe events");
  assert.equal(
    stepDisplayTitle({ ...step, detail: step.detail + "\n\n**Rebuilding with recorded swipe format**" }, true),
    "Rebuilding with recorded swipe format",
  );
  assert.equal(stepDisplayTitle({ ...step, detail: "Reasoning with **inline emphasis**." }, true), "Thinking");
  assert.equal(stepDisplayTitle({ ...step, detail: "### Testing both post orders\nMore reasoning." }, true), "Testing both post orders");
  assert.equal(stepDisplayTitle({ ...step, detail: "### Testing both" }, true), "Thinking");
  assert.equal(stepDisplayTitle({ ...step, title: "Thought", status: "done" }), "Thought");
});

test("command purpose leads while running, with the exact command retained for approval and output", () => {
  const step = { kind: "shell", title: "Ran `npm test`", description: "Check recorded swipe events", detail: "$ npm test\n" };
  assert.equal(stepDisplayTitle(step, true), "Check recorded swipe events");
  assert.equal(stepDisplayTitle(step), "Ran `npm test`");
  assert.equal(stepSections(step).input, "npm test");
  assert.equal(stepDisplayTitle({ ...step, description: undefined }, true), "Running `npm test`");
  // The activity row already shows the purpose; the running mark beside the timer doesn't repeat it.
  assert.equal(runStatusLabel([{ ...step, status: "running" }]), null);
});

test("parallel activity keeps a concrete tool visible, with approvals ahead of tools and thinking", () => {
  const shell = { id: "command", kind: "shell", status: "running", title: "Ran `npm test`" };
  const thought = { id: "thought", kind: "thinking", status: "running", title: "Thinking" };
  const edit = { id: "edit", kind: "edit", status: "running", title: "Edited `main.swift`" };
  assert.equal(currentActivityStep([shell, thought]), shell);
  assert.equal(currentActivityStep([shell, thought, edit]), edit);
  assert.equal(currentActivityStep([shell, thought, edit], [shell.id]), shell);
  assert.equal(currentActivityStep([{ ...shell, status: "done" }, thought]), thought);
  assert.equal(currentActivityStep([{ ...shell, status: "done" }]), undefined);
});
