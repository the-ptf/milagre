import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "../model";
import { applyRunEvents, type AgentRuns, type QueuedRunEvent } from "./agent-runs.ts";
import { createRunTextStore, onlyTextChanged } from "./run-text.ts";

const KEY = "/repo#2";
const delta = (text: string, chatId = KEY): QueuedRunEvent => ({ chatId, event: { type: "text-delta", text } as AgentEvent, model: "" });
const running = (extra = {}): AgentRuns => ({
  [KEY]: { text: "Hello", model: "m", startedAt: 1, steps: [], approvals: [], questions: [], answered: {}, ...extra },
});

test("a batch of text deltas to running turns changes only their text", () => {
  const runs = running();
  assert.equal(onlyTextChanged(runs, [delta(" wor"), delta("ld")]), true);
  const next = applyRunEvents(runs, [delta(" wor"), delta("ld")]);
  assert.equal(next[KEY]?.text, "Hello world");
  // Everything but the text is the same objects, so the window has nothing else to draw.
  assert.equal(next[KEY]?.steps, runs[KEY]?.steps);
  assert.equal(next[KEY]?.approvals, runs[KEY]?.approvals);
});

test("a batch that changes more than text goes to the window", () => {
  // A delta to a chat with no run yet, a run waiting on its subagents (a delta clears that), or any other event.
  assert.equal(onlyTextChanged({}, [delta("x")]), false);
  assert.equal(onlyTextChanged(running({ waitingForSubagents: true }), [delta("x")]), false);
  const started = { chatId: KEY, event: { type: "step-started", step: { id: "s", kind: "tool", title: "Read", status: "running" } } as AgentEvent, model: "" };
  assert.equal(onlyTextChanged(running(), [delta("x"), started]), false);
});

test("the store tells each chat's readers, and only them, and reads the latest text", () => {
  let runs = running();
  const store = createRunTextStore((key) => runs[key]?.text);
  const heard: string[] = [];
  const off = store.subscribe(KEY, () => heard.push(store.read(KEY) ?? ""));
  store.subscribe("/repo#3", () => heard.push("other"));
  runs = applyRunEvents(runs, [delta("!")]);
  store.notify([KEY, KEY]);
  assert.deepEqual(heard, ["Hello!"]);
  off();
  store.notify([KEY]);
  assert.deepEqual(heard, ["Hello!"]);
  assert.equal(store.read("/repo#9"), undefined);
});
