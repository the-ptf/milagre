import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentRun } from "@milagre/shared/agent-runs";
import type { AgentSession } from "@milagre/shared/model";
import { shownChat } from "./chat-list-filter.ts";

const chat = (extra: Partial<AgentSession> = {}) => ({ id: 4, worktree_id: 1, agent_name: "a", status: "Idle", ...extra }) as AgentSession;
const hidden = (extra: Partial<AgentSession> = {}) => chat({ routine: { routineId: "r1", runId: "u1", hidden: true }, ...extra });
const run = (extra: Partial<AgentRun> = {}) => ({ text: "", model: "", steps: [], approvals: [], questions: [], answered: {}, ...extra }) as AgentRun;

test("a hidden Run Chat stays out of the phone's lists while its turn runs, and with messages", () => {
  assert.equal(shownChat(hidden(), run(), 1), false);
  assert.equal(shownChat(hidden(), undefined, 3), false);
});

test("a hidden Run Chat shows while its turn waits on an approval or a question", () => {
  assert.equal(shownChat(hidden(), run({ approvals: [{ requestId: "a1" }] as AgentRun["approvals"] }), 1), true);
  assert.equal(shownChat(hidden(), run({ questions: [{ requestId: "q1", questions: [] }] }), 1), true);
});

test("a kept Run Chat shows like any Chat, its running turn included", () => {
  assert.equal(shownChat(chat({ routine: { routineId: "r1", runId: "u1", hidden: false } }), run(), 0), true);
  assert.equal(shownChat(chat({ routine: { routineId: "r1", runId: "u1", hidden: false } }), undefined, 2), true);
});

test("any other Chat shows while a turn runs, else once it has a message", () => {
  assert.equal(shownChat(chat(), run(), 0), true);
  assert.equal(shownChat(chat(), undefined, 0), false);
  assert.equal(shownChat(chat(), undefined, 1), true);
});

test("the Archived filter shows an archived hidden Run Chat, so a swept one can be restored", () => {
  const swept = hidden({ archived: true });
  assert.equal(shownChat(swept, undefined, 2, { archived: true }), true);
  // Like any archived Chat, one without a message stays out.
  assert.equal(shownChat(swept, undefined, 0, { archived: true }), false);
  assert.equal(shownChat(chat({ archived: true }), undefined, 1, { archived: true }), true);
});
