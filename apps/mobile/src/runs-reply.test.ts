import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentRun } from "@milagre/shared/agent-runs";
import { mergeRunsReply } from "./runs-reply.ts";
import type { RunsReply } from "./client.ts";

const run = (text: string): AgentRun => ({ text, steps: [], model: "m", approvals: [], questions: [], answered: {} });
const summary = { model: "m", approvals: [], questions: [], answered: {}, startedAt: 123 };

test("old hosts replace the whole set and older sequences never resurrect ended turns", () => {
  const first = { seq: 7, runs: { "/p#1": run("live") } };
  const ended = mergeRunsReply(first, { seq: 8, runs: {} });
  assert.deepEqual(ended, { seq: 8, runs: {} });
  assert.equal(mergeRunsReply(ended, first), ended);
  assert.deepEqual(mergeRunsReply({ runs: {} }, { runs: first.runs }), { runs: first.runs }, "unnumbered legacy host");
});

test("offscreen turns stay as summaries, selected details replace them even at the same seq, and removals disappear", () => {
  const first = { seq: 7, runs: { "/p#1": run("one"), "/p#2": run("old detail"), "/p#3": run("ended") } };
  const reply: RunsReply = { seq: 8, runs: { "/p#1": run("new") }, summaries: { "/p#2": summary }, detailChats: [1] };
  const next = mergeRunsReply(first, reply);
  assert.deepEqual(Object.keys(next.runs).sort(), ["/p#1", "/p#2"]);
  assert.deepEqual(next.runs["/p#2"], { ...summary, text: "", steps: [] });
  assert.equal(mergeRunsReply(next, reply), next, "unchanged reply keeps identity");
  const selected = mergeRunsReply(next, { seq: 8, runs: { "/p#2": run("now shown") }, summaries: { "/p#1": summary }, detailChats: [2] });
  assert.equal(selected.runs["/p#2"]?.text, "now shown");
  const ended = mergeRunsReply(selected, { seq: 9, runs: {}, summaries: {}, detailChats: [] });
  assert.deepEqual(ended.runs, {});
  assert.equal(mergeRunsReply(ended, reply), ended, "late scoped replies cannot resurrect a run");
  assert.equal(mergeRunsReply(ended, first), ended, "late full replies cannot resurrect a run");
});
