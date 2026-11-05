import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSession } from "../model";
import type { AgentRun } from "./agent-runs.ts";
import { subchatsNeedingYou, subchatStates } from "./subchat-track.ts";

const session = (id: number, extra: Partial<AgentSession> = {}) => ({ id, parent: 1, title: `Chat ${id}`, ...extra }) as AgentSession;
const sessions = (...list: AgentSession[]) => Object.fromEntries(list.map((item) => [item.id, item])) as unknown as Record<string, AgentSession>;
const base = { parentKey: "/web#1", runs: {}, work: { delegations: [] }, routines: [], reports: new Map<string, string>(), now: 100_000 };

test("subchatStates: direct Subchats oldest first, then deeper ones naming the Chat that delegated to them", () => {
  const states = subchatStates({
    ...base,
    sessions: sessions(session(1, { parent: undefined }), session(3), session(2), session(4, { parent: 2 }), session(5, { archived: true })),
  });
  assert.deepEqual(
    states.map((state) => [state.key, state.title, state.kind, state.via]),
    [
      ["/web#2", "Chat 2", "done", undefined],
      ["/web#3", "Chat 3", "done", undefined],
      ["/web#4", "Chat 4", "done", "Chat 2"],
    ],
  );
});

test("subchatsNeedingYou counts waiting Subchats at any depth", () => {
  const asking = {
    startedAt: 1,
    approvals: [],
    answered: {},
    questions: [{ requestId: "q", questions: [{ id: "a", header: "", question: "Which?", options: [], multiSelect: false, allowOther: true, secret: false }] }],
  } as unknown as AgentRun;
  const all = sessions(session(1, { parent: undefined }), session(2), session(3, { parent: 2 }));
  assert.equal(subchatsNeedingYou(all, { "/web#3": asking }, "/web#1"), 1);
  assert.equal(subchatsNeedingYou(all, {}, "/web#1"), 0);
  assert.equal(subchatsNeedingYou(undefined, {}, "/web#1"), 0);
});

test("subchatStates: a live run works, and a pending question needs the user", () => {
  const working = { text: "Reading files", startedAt: 40_000, approvals: [], questions: [], answered: {}, steps: [], model: "m" } as AgentRun;
  const asking = {
    ...working,
    questions: [
      {
        requestId: "q1",
        questions: [{ id: "a", header: "", question: "Which?", options: [{ label: "X" }], multiSelect: false, allowOther: true, secret: false }],
      },
    ],
  } as AgentRun;
  const states = subchatStates({ ...base, sessions: sessions(session(2), session(3)), runs: { "/web#2": working, "/web#3": asking } });
  assert.equal(states[0]?.kind, "working");
  assert.equal(states[0]?.elapsed, "1m 00s");
  assert.equal(states[1]?.kind, "needs-you");
  assert.equal(states[1]?.request?.kind, "question");
});

test("subchatStates: a queued Delegation, an enabled Heartbeat and the last report", () => {
  const delegation = (to_chat: string, status: "queued" | "running") =>
    ({ id: to_chat, link_id: null, from_chat: "/web#1", to_chat, from_label: "a", to_label: "b", status, message: "" }) as const;
  const heartbeat = (chatId: string, enabled: boolean) => ({
    enabled,
    target: { kind: "chat" as const, chatId },
    nextRunAt: 100_000 + 5 * 60_000,
    runCount: 1,
    maxRuns: 4,
  });
  const states = subchatStates({
    ...base,
    sessions: sessions(session(2), session(3), session(4), session(5, { summary: { lastOutcome: "failed" } as AgentSession["summary"] })),
    work: { delegations: [delegation("/web#2", "queued"), delegation("/web#3", "running")] },
    routines: [heartbeat("/web#3", true), heartbeat("/web#4", true), heartbeat("/web#5", false)],
    reports: new Map([["/web#5", "Tests broke"]]),
  });
  assert.deepEqual(
    states.map((state) => state.kind),
    ["queued", "holding", "holding", "failed"],
  );
  assert.equal(states[1]?.detail, "next beat in 5 min · run 1 of 4");
  assert.equal(states[3]?.detail, "Tests broke");
});

test("subchatStates: no sessions, no states", () => {
  assert.deepEqual(subchatStates({ ...base, sessions: undefined }), []);
});
