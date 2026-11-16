const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createOrchestratorStore } = require("./store.cjs");
const { createAutopilot } = require("./autopilot.cjs");
const { normalizeOrchestratorSettings } = require("@milagre/shared/orchestrator");

const CHAT = "/p/app#7";

function setup(t, { autopilot = "answer", vetoSeconds = 30, trust = {}, reply = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-autopilot-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createOrchestratorStore({ file: path.join(dir, "orchestrator.json") });
  store.update((current) => ({
    settings: normalizeOrchestratorSettings({ ...current.settings, enabled: true, autopilot, vetoSeconds }),
    tasks: [{ id: "task", prompt: "fix the rest timer", title: "Fix the rest timer", state: "started", projectPath: "/p/app", sessionId: 7, createdAt: 1 }],
    memory: { ...current.memory, trust },
  }));
  const calls = { permissions: [], answers: [], notes: [] };
  const timers = [];
  const pilot = createAutopilot({
    store,
    ports: {
      sessionOf: (chatId) => (chatId === CHAT ? { orchestrator: { taskId: "task", hidden: true } } : { title: "plain chat" }),
      respondPermission: async (request) => {
        calls.permissions.push(request);
        return true;
      },
      answerQuestion: async (request) => {
        calls.answers.push(request);
        return true;
      },
      note: (chatId, body) => calls.notes.push(body),
      questionCall: () => (reply === null ? null : async () => JSON.stringify(reply)),
    },
    schedule: (run, ms) => {
      timers.push({ run, ms });
      return timers.length;
    },
    cancel: (id) => {
      timers[id - 1].cancelled = true;
    },
  });
  return { pilot, store, calls, timers };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("allows a reversible edit in a task Chat at once and notes it on the card", async (t) => {
  const { pilot, store, calls } = setup(t, { trust: { "approval:edit": { answered: 5, corrected: 0 } } });
  pilot.observe(CHAT, { type: "permission-request", requestId: "r1", kind: "edit", title: "Edit RestTimer.swift?" });
  await settle();
  assert.deepEqual(calls.permissions, [{ chatId: CHAT, requestId: "r1", decision: "allow" }]);
  assert.equal(store.task("task").answered.at(-1).decision, "answered");
  assert.match(calls.notes[0], /answered for you/);
});

test("never answers an irreversible command, and leaves other Chats alone", async (t) => {
  const { pilot, calls, timers } = setup(t, { trust: { "approval:command": { answered: 9, corrected: 0 } } });
  pilot.observe(CHAT, { type: "permission-request", requestId: "r2", kind: "command", command: "gh pr merge 212 --squash" });
  pilot.observe("/p/app#8", { type: "permission-request", requestId: "r3", kind: "edit" });
  await settle();
  assert.equal(calls.permissions.length, 0);
  assert.equal(timers.length, 0);
});

test("a middling call waits for the veto window, and the owner stepping in cancels it and teaches trust", async (t) => {
  const { pilot, store, calls, timers } = setup(t, { vetoSeconds: 30 });
  pilot.observe(CHAT, { type: "permission-request", requestId: "r4", kind: "other", tool: "mcp__linear__get_issue", title: "Use get_issue?" });
  await settle();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 30_000);
  pilot.observe(CHAT, { type: "permission-resolved", requestId: "r4", decision: "deny" });
  assert.equal(timers[0].cancelled, true);
  assert.equal(calls.permissions.length, 0);
  assert.equal(store.read().memory.trust["approval:other"].corrected, 1);
});

test("answers a question with listed options only, and stays out when off", async (t) => {
  const question = { id: "q", question: "Monthly or yearly first?", options: [{ label: "Monthly" }, { label: "Yearly" }] };
  const { pilot, calls } = setup(t, {
    reply: { answers: { q: ["Yearly"] }, confidence: 0.95, summary: "yearly first" },
    trust: { question: { answered: 6, corrected: 0 } },
  });
  pilot.observe(CHAT, { type: "question-request", requestId: "q1", questions: [question] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls.answers[0].answers, { q: ["Yearly"] });
  const off = setup(t, { autopilot: "off", reply: { answers: { q: ["Yearly"] }, confidence: 1, summary: "x" } });
  off.pilot.observe(CHAT, { type: "question-request", requestId: "q2", questions: [question] });
  await settle();
  assert.equal(off.calls.answers.length, 0);
  const invented = setup(t, { reply: { answers: { q: ["Quarterly"] }, confidence: 1, summary: "x" } });
  invented.pilot.observe(CHAT, { type: "question-request", requestId: "q3", questions: [question] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(invented.calls.answers.length, 0);
});
