import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent } from "../model";
import { applyRunEvents, type AgentRuns, type QueuedRunEvent } from "./agent-runs.ts";
import { createAgentRunsStore, onlyTextChanged } from "./agent-runs-store.ts";

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
  assert.equal(next[KEY]?.steps, runs[KEY]?.steps);
  assert.equal(next[KEY]?.approvals, runs[KEY]?.approvals);
});

test("a batch that changes more than text goes to the window", () => {
  assert.equal(onlyTextChanged({}, [delta("x")]), false);
  assert.equal(onlyTextChanged(running({ waitingForSubagents: true }), [delta("x")]), false);
  const started = { chatId: KEY, event: { type: "step-started", step: { id: "s", kind: "tool", title: "Read", status: "running" } } as AgentEvent, model: "" };
  assert.equal(onlyTextChanged(running(), [delta("x"), started]), false);
});

test("text readers hear only their own chat, and only text changed tells no snapshot reader", () => {
  const store = createAgentRunsStore();
  store.set(running());
  const heard: string[] = [];
  let snapshots = 0;
  store.subscribe(() => snapshots++);
  const off = store.text.subscribe(KEY, () => heard.push(store.text.read(KEY) ?? ""));
  store.text.subscribe("/repo#3", () => heard.push("other"));
  store.set(applyRunEvents(store.latest(), [delta("!")]), true);
  assert.deepEqual(heard, ["Hello!"]);
  assert.equal(snapshots, 0);
  assert.equal(store.shown()[KEY]?.text, "Hello");
  off();
  store.set(applyRunEvents(store.latest(), [delta("?")]), true);
  assert.deepEqual(heard, ["Hello!"]);
  assert.equal(store.text.read("/repo#9"), undefined);
});

test("a held store shows the runs and text it had until it is released", () => {
  const store = createAgentRunsStore();
  store.set(running());
  let snapshots = 0;
  let texts = 0;
  store.subscribe(() => snapshots++);
  store.text.subscribe(KEY, () => texts++);
  store.hold();
  store.set(applyRunEvents(store.latest(), [delta(" world")]), true);
  store.set({});
  assert.deepEqual(store.latest(), {});
  assert.equal(store.shown()[KEY]?.text, "Hello");
  assert.equal(store.text.read(KEY), "Hello");
  assert.deepEqual([snapshots, texts], [0, 0]);
  store.release();
  assert.deepEqual(store.shown(), {});
  assert.equal(store.text.read(KEY), undefined);
  assert.deepEqual([snapshots, texts], [1, 1]);
  store.release();
  assert.deepEqual([snapshots, texts], [1, 1]);
});
