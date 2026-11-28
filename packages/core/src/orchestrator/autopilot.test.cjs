const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createOrchestratorStore } = require("./store.cjs");
const { createAutopilot } = require("./autopilot.cjs");
const { normalizeOrchestratorSettings } = require("@milagre/shared/orchestrator");

const CHAT = "/p/app#7";
const RUN_CHAT = "/p/app#9";

function setup(t, { autopilot = "answer", vetoSeconds = 30, trust = {}, reply = null, flowReply = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-autopilot-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createOrchestratorStore({ file: path.join(dir, "orchestrator.json") });
  store.update((current) => ({
    settings: normalizeOrchestratorSettings({ ...current.settings, enabled: true, autopilot, vetoSeconds }),
    tasks: [{ id: "task", prompt: "fix the rest timer", title: "Fix the rest timer", state: "started", projectPath: "/p/app", sessionId: 7, createdAt: 1 }],
    memory: { ...current.memory, trust },
  }));
  const calls = { permissions: [], answers: [], notes: [], approved: [], planned: [] };
  const approvals = {};
  const timers = [];
  const pilot = createAutopilot({
    store,
    ports: {
      sessionOf: (chatId) =>
        chatId === CHAT
          ? { orchestrator: { taskId: "task", hidden: true } }
          : chatId === RUN_CHAT
            ? { routine: { routineId: "r", runId: "run" } }
            : { title: "plain chat" },
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
      flowCall: () => (flowReply === null ? null : async () => JSON.stringify(flowReply)),
      flowApproval: (runId, stepId) => approvals[`${runId}:${stepId}`] ?? null,
      approveFlow: async (runId, summary) => calls.approved.push({ runId, summary }),
      planFlow: (runId, stepId, plan) => calls.planned.push({ runId, stepId, ...plan }),
    },
    schedule: (run, ms) => {
      timers.push({ run, ms });
      return timers.length;
    },
    cancel: (id) => {
      timers[id - 1].cancelled = true;
    },
  });
  return { pilot, store, calls, timers, approvals };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("allows a reversible edit in a task Chat at once and notes it on the card", async (t) => {
  const { pilot, store, calls } = setup(t, { trust: { "approval:edit": { answered: 5, corrected: 0 } } });
  pilot.observe(CHAT, { type: "permission-request", requestId: "r1", kind: "edit", title: "Edit RestTimer.swift?" });
  await settle();
  assert.deepEqual(calls.permissions, [{ chatId: CHAT, requestId: "r1", decision: "allow" }]);
  assert.equal(store.task("task").answered.at(-1).decision, "answered");
  assert.match(calls.notes[0], /Edit RestTimer/);
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
  const waiting = store.task("task").answered.at(-1);
  assert.equal(waiting.requestId, "r4");
  assert.ok(waiting.until > waiting.at, "the card can tell the owner an answer is coming");
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

test("reading a file counts as a read even when the provider calls it another tool", async (t) => {
  const { pilot, calls } = setup(t);
  pilot.observe(CHAT, { type: "permission-request", requestId: "r9", kind: "other", tool: "Read", title: "Use Read?" });
  await settle();
  assert.deepEqual(calls.permissions, [{ chatId: CHAT, requestId: "r9", decision: "allow" }]);
});

const waitingRun = (step, message) => ({
  id: "run",
  flow: { steps: [step], state: { [step.id]: { status: "waiting", approval: { askedAt: 1, expiresAt: 99, message } } } },
});

test("approves a flow's engineering approval after the veto window and says why", async (t) => {
  const { pilot, calls, timers } = setup(t, { flowReply: { design: false, approve: true, confidence: 0.6, summary: "the plan matches the issue" } });
  const step = { id: "scope", name: "Check the scope", kind: "ask" };
  pilot.considerFlow({ routine: { name: "Backlog fixes" }, run: waitingRun(step, "Refactor the retry loop into a helper?"), step });
  await settle();
  assert.equal(calls.planned[0].stepId, "scope");
  assert.equal(calls.planned[0].summary, "the plan matches the issue");
  assert.equal(timers.length, 1);
  await timers[0].run();
  await settle();
  assert.deepEqual(calls.approved, [{ runId: "run", summary: "the plan matches the issue" }]);
});

test("leaves design and UI approvals, and the ones the model calls design, to the owner", async (t) => {
  const { pilot, calls, timers } = setup(t, { flowReply: { design: true, approve: true, confidence: 1, summary: "x" } });
  const looks = { id: "look", name: "Approve the new layout", kind: "ask" };
  pilot.considerFlow({ routine: { name: "Backlog fixes" }, run: waitingRun(looks, "Ship the settings screen redesign?"), step: looks });
  const quiet = { id: "quiet", name: "Go on", kind: "ask" };
  pilot.considerFlow({ routine: { name: "Backlog fixes" }, run: waitingRun(quiet, "Use the second option?"), step: quiet });
  await settle();
  assert.equal(calls.planned.length + calls.approved.length + timers.length, 0);
});

test("an owner who answers during the veto window decides, and a rejection teaches trust", async (t) => {
  const { pilot, store, calls, timers, approvals } = setup(t, { flowReply: { design: false, approve: true, confidence: 0.6, summary: "ok" } });
  const step = { id: "scope", name: "Check the scope", kind: "ask" };
  pilot.considerFlow({ routine: { name: "Backlog fixes" }, run: waitingRun(step, "Go ahead?"), step });
  await settle();
  approvals["run:scope"] = { decision: "rejected" };
  await timers[0].run();
  await settle();
  assert.equal(calls.approved.length, 0);
  assert.equal(store.read().memory.trust["flow:ask"].corrected, 1);
});

test("answers a Run Chat's question but leaves a design question waiting", async (t) => {
  const reply = { answers: { q: ["Yes"] }, confidence: 0.95, summary: "yes" };
  const { pilot, calls } = setup(t, { reply, trust: { question: { answered: 9, corrected: 0 } } });
  const ask = (requestId, question) => ({
    type: "question-request",
    requestId,
    questions: [{ id: "q", question, options: [{ label: "Yes" }, { label: "No" }] }],
  });
  pilot.observe(RUN_CHAT, ask("a", "Run the migration tests too?"));
  pilot.observe(RUN_CHAT, ask("b", "Should the button colour match the header?"));
  await settle();
  await settle();
  assert.deepEqual(
    calls.answers.map((answer) => answer.requestId),
    ["a"],
  );
});
