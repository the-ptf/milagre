import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession } from "../model";
import type { AgentRun } from "./agent-runs";
import { familyMenuModel } from "./family-menu.ts";

const session = (id: number, extra: Partial<AgentSession> = {}) => ({ id, title: `Chat ${id}`, ...extra }) as AgentSession;
const sessions = (...list: AgentSession[]) => Object.fromEntries(list.map((item) => [item.id, item])) as unknown as Record<string, AgentSession>;
const reads = { sessions: undefined as Record<string, AgentSession> | undefined, runs: {}, work: { delegations: [] }, routines: [], now: 0 };
const asking = {
  startedAt: 1,
  approvals: [],
  answered: {},
  questions: [{ requestId: "q", questions: [{ id: "a", header: "", question: "Which?", options: [], multiSelect: false, allowOther: true, secret: false }] }],
} as unknown as AgentRun;
const working = { startedAt: 1, approvals: [], questions: [], answered: {}, text: "" } as unknown as AgentRun;

test("familyMenuModel: the parent first with its role, then the subchats with state words, the open one among them", () => {
  const all = sessions(
    session(1),
    session(2, { parent: 1 }),
    session(3, { parent: 1 }),
    session(4, { parent: 1, summary: { lastOutcome: "completed" } as AgentSession["summary"] }),
  );
  const model = familyMenuModel("/p#2", { ...reads, sessions: all, runs: { "/p#1": working, "/p#2": working, "/p#3": asking } });
  assert.deepEqual(
    model?.ancestors.map((entry) => [entry.title, entry.role, entry.word]),
    [["Chat 1", "Parent", "Working"]],
  );
  assert.deepEqual(
    model?.subchats.map((entry) => [entry.key, entry.word]),
    [
      ["/p#2", "Working"],
      ["/p#3", "Needs you"],
      ["/p#4", "Done"],
    ],
  );
  assert.equal(model?.size, 4);
});

test("familyMenuModel: a grandchild lists Top Chat and Parent above it; an idle Chat above says Idle, not Done", () => {
  const all = sessions(session(1), session(2, { parent: 1 }), session(3, { parent: 2 }));
  const model = familyMenuModel("/p#3", { ...reads, sessions: all });
  assert.deepEqual(
    model?.ancestors.map((entry) => [entry.key, entry.role, entry.word]),
    [
      ["/p#1", "Top Chat", "Idle"],
      ["/p#2", "Parent", "Idle"],
    ],
  );
  assert.deepEqual(
    model?.subchats.map((entry) => entry.key),
    ["/p#3"],
  );
});

test("familyMenuModel: a Chat with no family has no menu", () => {
  assert.equal(familyMenuModel("/p#1", { ...reads, sessions: sessions(session(1)) }), null);
});
