const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createRoutineStore } = require("./store.cjs");
const { createRoutineScheduler } = require("./scheduler.cjs");

const START = Date.UTC(2026, 10, 1, 12, 0, 0);
const ISSUE = {
  id: "i1",
  key: "MIL-482",
  title: "Retry webhook deliveries",
  description: "The relay answers 502",
  url: "https://linear.app/milagre/issue/MIL-482",
  labels: ["agent"],
  state: "Todo",
  team: "MIL",
  workspace: "milagre",
};
const issueEvent = (n = 1) => ({ kind: "linear", key: `linear:label:${n}`, change: "label-added", issue: { ...ISSUE, key: `MIL-${480 + n}` } });

// The pilot: Classify -> If large (Ask) -> Implement -> Open pull request -> Review.
const pilot = () => [
  {
    id: "classify",
    name: "Classify",
    kind: "agent",
    prompt: "Read {{trigger.issue.title}}",
    chat: "run",
    output: [
      { name: "complexity", type: "choice", choices: ["small", "medium", "large"] },
      { name: "area", type: "text" },
    ],
    retries: 1,
    onInvalid: "ask-once",
  },
  {
    id: "if-large",
    name: "If",
    kind: "if",
    field: "classify.complexity",
    test: "is",
    value: "large",
    yes: [{ id: "ask", name: "Ask before implementing", kind: "ask", message: "Touches {{classify.area}}", expiresInHours: 24 }],
    otherwise: [],
  },
  {
    id: "implement",
    name: "Implement",
    kind: "agent",
    prompt: "Fix {{trigger.issue.key}} in {{classify.area}}",
    chat: "run",
    output: [],
    retries: 0,
    onInvalid: "stop",
  },
  { id: "pr", name: "Open pull request", kind: "pull-request", title: "{{trigger.issue.key}} {{trigger.issue.title}}", body: "", draft: true, askFirst: true },
  {
    id: "review",
    name: "Review",
    kind: "agent",
    prompt: "Review {{pr.url}}",
    chat: "own",
    output: [{ name: "verdict", type: "choice", choices: ["approve", "changes"] }],
    retries: 0,
    onInvalid: "stop",
  },
];

function setup({ steps = pilot(), trigger = { kind: "linear", workspace: "milagre", event: "label-added", label: "agent" } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routine-flows-"));
  const clock = { t: START };
  let n = 0;
  const store = createRoutineStore({ file: path.join(dir, "routines.json"), now: () => clock.t, id: () => `id${++n}` });
  const calls = { send: [], start: [], step: [], open: [], find: [], comment: [], notify: [], stop: [] };
  const state = { found: null, busy: new Set() };
  let chats = 0;
  let turns = 0;
  const chatAdapter = {
    exists: () => true,
    archived: () => false,
    busy: (chatId) => state.busy.has(chatId),
    async startChat({ run }) {
      calls.start.push(run.id);
      chats += 1;
      return { chatId: `chat${chats}`, worktreeId: "w1", createdWorktree: true, body: "", prompt: "", context: { kind: "linear-issue" } };
    },
    async startStepChat({ worktreeId, title }) {
      chats += 1;
      calls.step.push({ worktreeId, title });
      return { chatId: `chat${chats}` };
    },
    async send(chatId, message) {
      turns += 1;
      calls.send.push({ chatId, ...message });
      return { started: Promise.resolve({ turnId: `t${turns}` }) };
    },
    async stop(chatId) {
      calls.stop.push(chatId);
    },
    replyText: () => "",
    patchRunContext: async () => {},
    nameRun: async () => {},
    archive: async () => {},
    linkedChat: async () => null,
  };
  const flowActions = {
    async findPullRequest({ chatId }) {
      calls.find.push(chatId);
      return state.found;
    },
    async pullRequestPreview() {
      return { repository: "the-ptf/milagre-ade", branch: "mil-481", base: "main", changes: "2 files, 10 added, 1 removed" };
    },
    async openPullRequest(input) {
      calls.open.push(input);
      return { ok: true, url: "https://github.com/the-ptf/milagre-ade/pull/861", number: 861, branch: "mil-481" };
    },
    async commentOnLinear(input) {
      calls.comment.push(input);
      return { url: "https://linear.app/c/1" };
    },
    notify(routine, run, text) {
      calls.notify.push(text);
    },
  };
  const scheduler = createRoutineScheduler({ store, chats: chatAdapter, now: () => clock.t, flowActions, setInterval: () => null, clearInterval: () => {} });
  const routine = store.create({
    name: "Issue to PR",
    trigger,
    target: { kind: "new-chat", projectPath: "/p", workspace: "worktree" },
    flow: { steps },
    createdBy: { kind: "user" },
  });
  const settle = async () => {
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      await scheduler.idle();
    }
  };
  const tick = async () => {
    await scheduler.tick();
    await settle();
  };
  // A turn in `chatId` starting and ending as `end` ("turn-completed", "turn-failed"…).
  const turn = async (chatId, end = "turn-completed") => {
    const turnId = `t${turns}`;
    scheduler.observe(chatId, { type: "message-sent" });
    scheduler.observe(chatId, { type: "turn-started", turnId });
    scheduler.observe(chatId, { type: end, turnId, message: end === "turn-failed" ? "boom" : undefined });
    await settle();
  };
  const run = () => store.runs(routine.id)[0];
  return { store, scheduler, routine, clock, calls, state, flowActions, settle, tick, turn, run, dir };
}

test("the pilot runs end to end on the large path: approvals, a receipt, the review in its own Chat", async () => {
  const ctx = setup();
  ctx.scheduler.enqueueEvent(ctx.routine.id, issueEvent());
  await ctx.tick();
  assert.equal(ctx.calls.send.length, 1);
  assert.equal(ctx.calls.send[0].chatId, "chat1");
  assert.match(ctx.calls.send[0].body, /Read Retry webhook deliveries/);
  assert.match(ctx.calls.send[0].prompt, /untrusted-data/);
  assert.match(ctx.calls.send[0].prompt, /flow_step_output/);
  assert.equal(ctx.run().flow.state.classify.status, "running");

  assert.equal(ctx.scheduler.runsFlowStep("chat1"), true);
  assert.equal(ctx.scheduler.flowOutput("chat1", { complexity: "huge", area: "relay" }).ok, false);
  assert.equal(ctx.scheduler.flowOutput("chat1", { complexity: "Large", area: "relay" }).ok, true);
  await ctx.turn("chat1");

  let run = ctx.run();
  assert.equal(run.flow.state.classify.status, "done");
  assert.deepEqual(run.flow.state.classify.output, { complexity: "large", area: "relay" });
  assert.equal(run.flow.state["if-large"].taken, "yes");
  assert.equal(run.flow.state.ask.status, "waiting");
  assert.equal(run.flow.state.ask.approval.message, "Touches relay");
  assert.equal(run.flow.status, "waiting");
  assert.equal(ctx.calls.notify.length, 1);

  await ctx.scheduler.flowAct(run.id, "approve");
  await ctx.settle();
  assert.equal(ctx.calls.send.length, 2);
  assert.equal(ctx.calls.send[1].chatId, "chat1");
  assert.match(ctx.calls.send[1].body, /Fix MIL-481 in relay/);
  await ctx.turn("chat1");

  run = ctx.run();
  assert.equal(run.flow.state.implement.status, "done");
  assert.equal(run.flow.state.pr.status, "waiting");
  assert.equal(run.flow.state.pr.approval.preview.title, "MIL-481 Retry webhook deliveries");
  assert.equal(run.flow.state.pr.approval.preview.changes, "2 files, 10 added, 1 removed");
  assert.equal(ctx.calls.open.length, 0);

  await ctx.scheduler.flowAct(run.id, "approve");
  await ctx.settle();
  run = ctx.run();
  assert.equal(ctx.calls.open.length, 1);
  assert.equal(ctx.calls.open[0].draft, true);
  assert.deepEqual(
    { ...run.flow.state.pr.receipt, at: 0 },
    { kind: "pull-request", url: "https://github.com/the-ptf/milagre-ade/pull/861", number: 861, branch: "mil-481", draft: true, matched: false, at: 0 },
  );
  // The review runs in a Chat of its own, in the Run's Worktree, and reads the PR's link.
  assert.deepEqual(ctx.calls.step, [{ worktreeId: "w1", title: "Issue to PR · Review" }]);
  const review = ctx.calls.send.at(-1);
  assert.equal(review.chatId, "chat2");
  assert.match(review.body, /Review https:\/\/github.com\/the-ptf\/milagre-ade\/pull\/861/);
  assert.equal(ctx.scheduler.flowOutput("chat2", { verdict: "approve" }).ok, true);
  await ctx.turn("chat2");

  run = ctx.run();
  assert.equal(run.status, "acted");
  assert.equal(run.flow.status, "done");
  assert.equal(run.title, "MIL-481 Retry webhook deliveries");
  assert.equal(ctx.store.get(ctx.routine.id).runCount, 1);
});

test("the small path skips the approval", async () => {
  const ctx = setup();
  ctx.scheduler.enqueueEvent(ctx.routine.id, issueEvent());
  await ctx.tick();
  ctx.scheduler.flowOutput("chat1", { complexity: "small", area: "ui" });
  await ctx.turn("chat1");
  const run = ctx.run();
  assert.equal(run.flow.state["if-large"].taken, "otherwise");
  assert.equal(run.flow.state.ask, undefined);
  assert.equal(run.flow.state.implement.status, "running");
});

test("a turn without the fields is asked once, then retried, then the Run stops; Retry with a note picks it up", async () => {
  const ctx = setup();
  ctx.scheduler.enqueueEvent(ctx.routine.id, issueEvent());
  await ctx.tick();
  await ctx.turn("chat1");
  // Asked once for the fields, in the same Chat.
  assert.equal(ctx.calls.send.length, 2);
  assert.match(ctx.calls.send[1].prompt, /ended without handing back/);
  await ctx.turn("chat1");
  // Out of asks: that try failed, and the step has one retry.
  assert.equal(ctx.calls.send.length, 3);
  assert.equal(ctx.run().flow.state.classify.tries.length, 1);
  await ctx.turn("chat1", "turn-failed");
  let run = ctx.run();
  assert.equal(run.status, "failed");
  assert.equal(run.flow.status, "failed");
  assert.match(run.error, /^Classify: /);
  assert.equal(run.flow.state.implement.status, "not-run");
  assert.equal(ctx.store.get(ctx.routine.id).failedStreak, 1);

  await ctx.scheduler.flowAct(run.id, "retry", { note: "The issue is about the relay" });
  await ctx.settle();
  run = ctx.run();
  assert.equal(run.status, "running");
  assert.equal(run.flow.state.implement, undefined);
  assert.match(ctx.calls.send.at(-1).prompt, /Note from the owner for this try: The issue is about the relay/);
  assert.equal(ctx.store.get(ctx.routine.id).failedStreak, 0);
  assert.equal(ctx.store.get(ctx.routine.id).runCount, 0);
});

test("an approval nobody answers ends the Run without counting as a failure", async () => {
  const ctx = setup();
  ctx.scheduler.enqueueEvent(ctx.routine.id, issueEvent());
  await ctx.tick();
  ctx.scheduler.flowOutput("chat1", { complexity: "large", area: "relay" });
  await ctx.turn("chat1");
  ctx.clock.t += 25 * 3600_000;
  await ctx.tick();
  const run = ctx.run();
  assert.equal(run.status, "ended");
  assert.equal(run.error, "approval expired");
  assert.equal(run.flow.state.ask.approval.decision, "expired");
  assert.equal(run.flow.state.implement.status, "not-run");
  assert.equal(ctx.store.get(ctx.routine.id).failedStreak ?? 0, 0);
});

test("a rejection keeps the reason on the Run without posting a hidden comment", async () => {
  const ctx = setup();
  ctx.scheduler.enqueueEvent(ctx.routine.id, issueEvent());
  await ctx.tick();
  ctx.scheduler.flowOutput("chat1", { complexity: "large", area: "relay" });
  await ctx.turn("chat1");
  await ctx.scheduler.flowAct(ctx.run().id, "reject", { reason: "Too risky this week" });
  await ctx.settle();
  assert.equal(ctx.run().status, "ended");
  assert.equal(ctx.run().error, "approval rejected");
  assert.deepEqual(ctx.calls.comment, []);
  assert.equal(ctx.run().flow.state.ask.approval.reason, "Too risky this week");
});

test("after a restart, a pull request with an intent and no receipt is found on its branch, never opened twice", async () => {
  const ctx = setup();
  ctx.scheduler.enqueueEvent(ctx.routine.id, issueEvent());
  await ctx.tick();
  ctx.scheduler.flowOutput("chat1", { complexity: "small", area: "ui" });
  await ctx.turn("chat1");
  await ctx.turn("chat1");
  const runId = ctx.run().id;
  await ctx.scheduler.flowAct(runId, "approve");
  // Simulate a stop between the intent and the receipt: the step is running with an intent, nothing else.
  ctx.store.updateFlowRun(runId, (flow) => {
    flow.state.pr = { status: "running", intentAt: ctx.clock.t, approval: { askedAt: 1, expiresAt: 2, message: "", decision: "approved" } };
    delete flow.state.review;
  });
  const opened = ctx.calls.open.length;
  ctx.state.found = { url: "https://github.com/the-ptf/milagre-ade/pull/900", number: 900, branch: "mil-481", draft: true };
  const again = createRoutineScheduler({
    store: ctx.store,
    chats: {
      exists: () => true,
      archived: () => false,
      busy: () => false,
      send: async () => ({ started: Promise.resolve({ turnId: "x" }) }),
      startStepChat: async () => ({ chatId: "chat9" }),
    },
    now: () => ctx.clock.t,
    flowActions: { findPullRequest: async () => ctx.state.found, openPullRequest: async () => assert.fail("opened twice") },
    setInterval: () => ({}),
    clearInterval: () => {},
  });
  again.start();
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await again.idle();
  }
  const run = ctx.store.getRun(runId).run;
  assert.equal(ctx.calls.open.length, opened);
  assert.equal(run.flow.state.pr.receipt.number, 900);
  assert.equal(run.flow.state.pr.receipt.matched, true);
  again.stop();
});

test("a Test run simulates agents, actions and waits without creating Chats or counting", async () => {
  const ctx = setup();
  ctx.scheduler.enqueueEvent(ctx.routine.id, issueEvent());
  await ctx.tick();
  ctx.scheduler.flowOutput("chat1", { complexity: "large", area: "relay" });
  await ctx.turn("chat1");
  await ctx.scheduler.flowAct(ctx.run().id, "end");
  await ctx.settle();
  const countBefore = ctx.store.get(ctx.routine.id).runCount;
  const sendsBefore = ctx.calls.send.length;
  const chatsBefore = ctx.calls.start.length;
  const started = await ctx.scheduler.flowTest(ctx.routine.id);
  await ctx.settle();
  const run = ctx.store.getRun(started.id).run;
  assert.equal(run.flow.dryRun, true);
  assert.equal(run.flow.state.classify.status, "skipped");
  assert.equal(run.flow.state.classify.output.complexity, "large");
  assert.equal(run.flow.state.ask.status, "done");
  assert.equal(run.flow.state.pr.status, "skipped");
  assert.equal(run.flow.state.review.status, "skipped");
  assert.equal(run.status, "acted");
  assert.equal(ctx.calls.send.length, sendsBefore);
  assert.equal(ctx.calls.start.length, chatsBefore);
  assert.equal(ctx.calls.open.length, 0);
  assert.equal(ctx.calls.comment.length, 0);
  assert.equal(ctx.store.get(ctx.routine.id).runCount, countBefore);
});

test("pause lets the step under way finish and holds the next one until resume; a time wait ends on the clock", async () => {
  const steps = [
    { id: "wait", name: "Wait", kind: "wait", until: { kind: "time", minutes: 30 }, timeoutHours: 1 },
    { id: "work", name: "Work", kind: "agent", prompt: "Go", chat: "run", output: [], retries: 0, onInvalid: "stop" },
  ];
  const ctx = setup({ steps, trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" } });
  await ctx.scheduler.runNow(ctx.routine.id);
  await ctx.settle();
  let run = ctx.run();
  assert.equal(run.flow.state.wait.status, "waiting");
  await ctx.scheduler.flowAct(run.id, "pause");
  ctx.clock.t += 31 * 60_000;
  await ctx.tick();
  run = ctx.run();
  assert.equal(run.flow.state.wait.status, "done");
  assert.equal(run.flow.state.work, undefined);
  assert.equal(run.flow.status, "paused");
  await ctx.scheduler.flowAct(run.id, "resume");
  await ctx.settle();
  run = ctx.run();
  assert.equal(run.flow.status, "running");
  assert.equal(run.flow.state.work.status, "running");
});

test("a draft saves incomplete steps; publishing checks them and bumps the revision", () => {
  const ctx = setup();
  const draft = [...pilot(), { id: "note", name: "Comment", kind: "linear-comment", body: "" }];
  ctx.store.update(ctx.routine.id, { flowDraft: draft });
  assert.equal(ctx.store.get(ctx.routine.id).flow.draft.steps.length, 6);
  assert.throws(() => ctx.store.update(ctx.routine.id, { publishFlow: true }), /add the comment/);
  draft[5].body = "Opened {{pr.url}}";
  ctx.store.update(ctx.routine.id, { flowDraft: draft });
  ctx.store.update(ctx.routine.id, { publishFlow: true });
  const flow = ctx.store.get(ctx.routine.id).flow;
  assert.equal(flow.revision, 2);
  assert.equal(flow.steps.length, 6);
  assert.equal(flow.draft, undefined);
});

test("a flow saved as a draft only stays off until it is published", () => {
  const ctx = setup();
  const routine = ctx.store.create({
    name: "Later",
    trigger: { kind: "linear", workspace: "milagre", event: "label-added", label: "bug" },
    target: { kind: "new-chat", projectPath: "/p", workspace: "worktree" },
    flow: { steps: [], publish: false },
    createdBy: { kind: "user" },
  });
  assert.equal(routine.enabled, false);
  assert.equal(routine.flow.revision, 0);
  assert.throws(() => ctx.store.update(routine.id, { enabled: true }), /Publish the flow/);
});

test("a failed turn's fields are cleared before its next try", async () => {
  const ctx = setup();
  ctx.scheduler.enqueueEvent(ctx.routine.id, issueEvent());
  await ctx.tick();
  ctx.scheduler.flowOutput("chat1", { complexity: "small", area: "ui" });
  await ctx.turn("chat1", "turn-failed");
  assert.equal(ctx.run().flow.state.classify.output, undefined);
  assert.equal(ctx.run().flow.state.classify.status, "running");
  await ctx.turn("chat1");
  assert.equal(ctx.run().flow.state.classify.status, "running");
  assert.equal(ctx.run().flow.state.implement, undefined);
});

test("an expired approval is refused before the next tick", async () => {
  const ctx = setup();
  ctx.scheduler.enqueueEvent(ctx.routine.id, issueEvent());
  await ctx.tick();
  ctx.scheduler.flowOutput("chat1", { complexity: "large", area: "ui" });
  await ctx.turn("chat1");
  ctx.clock.t += 25 * 3600_000;
  await assert.rejects(ctx.scheduler.flowAct(ctx.run().id, "approve"), /expired/);
  assert.equal(ctx.run().status, "ended");
  assert.equal(ctx.calls.send.length, 1);
});

test("the test run skips a long wait and uses sample fields without a real Run", async () => {
  const ctx = setup({
    steps: [
      { id: "a", name: "Agent", kind: "agent", prompt: "Work", output: [{ name: "answer", type: "number" }], retries: 0, chat: "run", onInvalid: "stop" },
      { id: "w", name: "Wait", kind: "wait", until: { kind: "time", minutes: 60 }, timeoutHours: 1 },
    ],
    trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" },
  });
  const started = await ctx.scheduler.flowTest(ctx.routine.id);
  await ctx.settle();
  const run = ctx.store.getRun(started.id).run;
  assert.equal(run.status, "acted");
  assert.equal(run.flow.state.a.output.answer, 1);
  assert.equal(run.flow.state.w.status, "skipped");
  assert.equal(ctx.calls.start.length, 0);
  assert.equal(ctx.calls.send.length, 0);
});

test("a late turn completion after End cannot advance or retry the Run", async () => {
  const ctx = setup();
  ctx.scheduler.enqueueEvent(ctx.routine.id, issueEvent());
  await ctx.tick();
  ctx.scheduler.flowOutput("chat1", { complexity: "small", area: "ui" });
  await ctx.scheduler.flowAct(ctx.run().id, "end");
  await ctx.turn("chat1");
  assert.equal(ctx.run().status, "ended");
  assert.equal(ctx.calls.send.length, 1);
  assert.equal(ctx.calls.open.length, 0);
});

test("restarting after fields were saved does not checkpoint an unfinished turn as done", async () => {
  const ctx = setup();
  ctx.scheduler.enqueueEvent(ctx.routine.id, issueEvent());
  await ctx.tick();
  ctx.scheduler.flowOutput("chat1", { complexity: "small", area: "ui" });
  const again = createRoutineScheduler({
    store: ctx.store,
    chats: { busy: () => false, exists: () => true, archived: () => false, send: async () => ({ started: Promise.resolve({ turnId: "new" }) }) },
    now: () => ctx.clock.t,
    setInterval: () => ({}),
    clearInterval: () => {},
  });
  again.start();
  await again.idle();
  assert.notEqual(ctx.run().flow.state.classify.status, "done");
  assert.equal(ctx.run().flow.state.implement, undefined);
  again.stop();
});

test("a comment with an unknown outcome cannot be posted again through Retry", async () => {
  const ctx = setup({ steps: [{ id: "comment", name: "Comment", kind: "linear-comment", body: "Work complete" }] });
  let posts = 0;
  ctx.flowActions.commentOnLinear = async () => {
    posts++;
    throw new Error("connection lost after posting");
  };
  ctx.scheduler.enqueueEvent(ctx.routine.id, issueEvent());
  await ctx.tick();
  assert.equal(ctx.run().status, "failed");
  await assert.rejects(ctx.scheduler.flowAct(ctx.run().id, "retry"), /may already exist/);
  assert.equal(posts, 1);
  assert.equal(ctx.run().status, "failed");
});

test("End preserves a remote receipt that arrives late, without starting the next step", async () => {
  const ctx = setup({
    steps: [
      { id: "prepare", name: "Prepare", kind: "agent", prompt: "Prepare", output: [], retries: 0, chat: "run", onInvalid: "stop" },
      { id: "pr", name: "Open PR", kind: "pull-request", title: "Fix", body: "", draft: true, askFirst: false },
      { id: "after", name: "After", kind: "agent", prompt: "After", output: [], retries: 0, chat: "run", onInvalid: "stop" },
    ],
  });
  let opened;
  let signalStarted;
  const started = new Promise((resolve) => {
    signalStarted = resolve;
  });
  ctx.flowActions.openPullRequest = () =>
    new Promise((resolve) => {
      opened = resolve;
      signalStarted();
    });
  ctx.scheduler.enqueueEvent(ctx.routine.id, issueEvent());
  await ctx.tick();
  ctx.scheduler.observe("chat1", { type: "message-sent" });
  ctx.scheduler.observe("chat1", { type: "turn-started", turnId: "t1" });
  ctx.scheduler.observe("chat1", { type: "turn-completed", turnId: "t1" });
  await started;
  const runId = ctx.run().id;
  await ctx.scheduler.flowAct(runId, "end");
  opened({ ok: true, url: "https://github.com/example/repo/pull/1", number: 1, branch: "work" });
  await ctx.settle();
  assert.equal(ctx.run().status, "ended");
  assert.equal(ctx.run().flow.status, "ended");
  assert.equal(ctx.run().flow.state.pr.receipt.number, 1);
  assert.equal(ctx.run().flow.state.after.status, "not-run");
  assert.equal(ctx.calls.send.length, 1);
});

test("a successful turn waits for background work before completing its step", async () => {
  const ctx = setup();
  ctx.scheduler.enqueueEvent(ctx.routine.id, issueEvent());
  await ctx.tick();
  ctx.scheduler.flowOutput("chat1", { complexity: "large", area: "ui" });
  ctx.state.busy.add("chat1");
  await ctx.turn("chat1");
  assert.equal(ctx.run().flow.state.classify.status, "running");
  assert.equal(ctx.run().flow.state.ask, undefined);
  ctx.state.busy.delete("chat1");
  await ctx.tick();
  assert.equal(ctx.run().flow.state.classify.status, "done");
  assert.equal(ctx.run().flow.state.ask.status, "waiting");
});

test("a schedule simulation can reuse completed fields even though its real Run has no event", async () => {
  const ctx = setup({
    steps: [
      { id: "a", name: "Agent", kind: "agent", prompt: "Inspect", output: [{ name: "ready", type: "yes-no" }], retries: 0, chat: "run", onInvalid: "stop" },
    ],
    trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" },
  });
  await ctx.scheduler.runNow(ctx.routine.id);
  await ctx.settle();
  ctx.scheduler.flowOutput("chat1", { ready: true });
  await ctx.turn("chat1");
  const started = await ctx.scheduler.flowTest(ctx.routine.id);
  await ctx.settle();
  const run = ctx.store.getRun(started.id).run;
  assert.equal(run.flow.state.a.output.ready, true);
  assert.match(run.flow.state.a.summary, /Saved fields/);
  assert.equal(ctx.calls.send.length, 1);
});
