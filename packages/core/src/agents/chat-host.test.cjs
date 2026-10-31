const assert = require("node:assert/strict");
const test = require("node:test");
const { ChatHost } = require("./chat-host.cjs");
const { SessionManager } = require("./session-manager.cjs");
const { ProjectStates } = require("../project-states.cjs");
const { applyRunEvent } = require("@milagre/shared/agent-runs");
const { lastTurnProvider } = require("@milagre/shared/handoff");
const { waitUntil } = require("./test-helpers.cjs");
const { createChatPlanTools } = require("../chat-plan-tools.cjs");
const { runTool } = require("../linked-tools.cjs");

class FakeSession {
  constructor(provider, options) {
    Object.assign(this, { provider, options, turns: [], interrupts: 0, closed: false });
  }

  async startTurn(turn) {
    this.turns.push(turn);
    return { turnId: `t${this.turns.length}` };
  }

  emit(event) {
    this.options.emit(event);
  }

  async interrupt() {
    this.interrupts += 1;
  }

  async close() {
    this.closed = true;
  }
}

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

async function limitedChat(h, extra = {}) {
  const sent = await h.host.send(message(ALPHA, "finish the export", { effort: "high", guard: { level: "review" }, ...extra }));
  await sent.started;
  const chatId = `${ALPHA}#${sent.sessionId}`;
  await h.host.receive(chatId, {
    type: "turn-failed",
    message: "usage limited",
    limit: { provider: extra.provider ?? "claude", accountId: "default", resetsAt: new Date(NOW + 120_000).toISOString() },
  });
  return { chatId, sessionId: sent.sessionId };
}

test("limit continuation survives restart with options and fires only once", async (t) => {
  let clock = NOW;
  const h = harness({ now: () => clock });
  t.after(() => Promise.all([h.states.close(), h.manager.closeAll()]));
  const { sessionId } = await limitedChat(h);
  assert.equal(await h.host.scheduleLimitResume(ALPHA, sessionId, { mode: "automatic", accountId: "default" }), true);
  const state = structuredClone(await h.states.load(ALPHA, [sessionId]));
  const pending = state.sessions[sessionId].limitResume;
  const restored = harness({ now: () => clock, read: async () => state });
  t.after(() => Promise.all([restored.states.close(), restored.manager.closeAll()]));
  clock += 180_000;
  const results = await Promise.all([1, 2].map(() => restored.host.runLimitResume(ALPHA, sessionId, { accountId: "default", sendId: pending.sendId })));
  assert.equal(results.filter(Boolean).length, 1);
  await waitUntil(() => restored.created[0]?.turns.length === 1);
  assert.equal(restored.created.length, 1);
  assert.equal(restored.created[0].turns[0].effort, "high");
  assert.deepEqual(restored.created[0].turns[0].guard, { level: "review" });
  const latest = await restored.states.get(ALPHA);
  assert.equal(latest.sessions[sessionId].limitResume, undefined);
  const lines = latest.messages.filter((item) => item.context?.kind === "limit-reset");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].clientMessageId, pending.sendId);
  assert.equal(lines[0].body, "Continued after the usage limit reset");
});

test("manual scheduling after restart retains the stopped turn even when automatic scheduling was off", async (t) => {
  const h = harness();
  t.after(() => Promise.all([h.states.close(), h.manager.closeAll()]));
  const { sessionId } = await limitedChat(h);
  const snapshot = structuredClone(await h.states.get(ALPHA));
  assert.ok(snapshot.sessions[sessionId].limitTurn.turn);
  assert.equal(snapshot.sessions[sessionId].limitResume, undefined);
  const restored = harness({ read: async () => snapshot });
  t.after(() => Promise.all([restored.states.close(), restored.manager.closeAll()]));
  assert.equal(await restored.host.scheduleLimitResume(ALPHA, sessionId, { mode: "manual", accountId: "default" }), true);
});

for (const provider of ["claude", "codex", "antigravity"]) {
  for (const native of [false, true]) {
    test(`${provider} reset retry restores first-turn attachments after restart (native session: ${native})`, async (t) => {
      const fs = require("node:fs/promises");
      const path = require("node:path");
      const os = require("node:os");
      const { saveProjectState, readProjectState } = require("../project-store.cjs");
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-limit-images-")));
      t.after(() => fs.rm(root, { recursive: true, force: true }));
      let clock = NOW;
      const h = harness({ now: () => clock, save: saveProjectState });
      const image = {
        id: "screen",
        name: "screen.png",
        dataUrl: "data:image/png;base64," + (await fs.readFile(path.join(__dirname, "../../../../scripts/fixtures/photo.png"))).toString("base64"),
      };
      const file = path.join(root, "requirements.txt");
      await fs.writeFile(file, "Keep the attached layout.");
      const prompt = `Implement [Image #1] using ${file}`;
      const sent = await h.host.send(
        message(root, "Implement the attached screen", {
          provider,
          prompt,
          images: [image],
          files: [file],
          effort: "high",
          guard: { level: "review" },
        }),
      );
      await sent.started;
      assert.deepEqual(h.created[0].turns[0].images, [image]);
      const chatId = `${root}#${sent.sessionId}`;
      if (native) await h.host.receive(chatId, { type: "session-started", nativeId: "native-1" });
      await h.host.receive(chatId, {
        type: "turn-failed",
        message: "usage limited",
        limit: { provider, accountId: "default", resetsAt: new Date(clock + 120_000).toISOString() },
      });
      await h.host.scheduleLimitResume(root, sent.sessionId, { mode: "automatic", accountId: "default" });
      await h.states.close();
      await h.manager.closeAll();
      const saved = await readProjectState(root);
      assert.equal(saved.messages.find((m) => m.role === "user").images[0].dataUrl, undefined);
      const restored = harness({ now: () => clock, read: readProjectState, save: saveProjectState });
      t.after(() => Promise.all([restored.states.close(), restored.manager.closeAll()]));
      clock += 180_000;
      const sendId = saved.sessions[sent.sessionId].limitResume.sendId;
      const results = await Promise.all([1, 2].map(() => restored.host.runLimitResume(root, sent.sessionId, { accountId: "default", sendId })));
      assert.equal(results.filter(Boolean).length, 1);
      await waitUntil(() => restored.created[0]?.turns.length === 1);
      const retry = restored.created[0].turns[0];
      assert.deepEqual(retry.images, native ? [] : [image]);
      assert.equal(retry.prompt, native ? require("../limit-resume.cjs").RESET_PROMPT : prompt);
      assert.equal(retry.effort, "high");
      assert.deepEqual(retry.guard, { level: "review" });
      const resumed = await restored.states.get(root);
      const divider = resumed.messages.find((m) => m.context?.kind === "limit-reset");
      assert.deepEqual(divider.files ?? [], native ? [] : [file]);
      assert.equal(resumed.sessions[sent.sessionId].limitResume, undefined);
      if (!native) {
        await t.test("a repeated legacy retry waits for a missing image without consuming its schedule", async () => {
          await restored.host.receive(chatId, {
            type: "turn-failed",
            message: "usage limited again",
            limit: { provider, accountId: "default", resetsAt: new Date(clock + 120_000).toISOString() },
          });
          await restored.host.scheduleLimitResume(root, sent.sessionId, { mode: "manual", accountId: "default" });
          const pending = (await restored.states.get(root)).sessions[sent.sessionId].limitResume;
          assert.equal(pending.inputMessageId, divider.id);
          // The preceding version neither named its input nor copied attachments to reset dividers.
          await restored.states.update(root, (state) => {
            const { inputMessageId: _input, ...legacy } = state.sessions[sent.sessionId].limitResume;
            return {
              ...state,
              messages: state.messages.map((m) => (m.id === divider.id ? { ...m, images: [], files: [] } : m)),
              sessions: { ...state.sessions, [sent.sessionId]: { ...state.sessions[sent.sessionId], limitResume: legacy } },
            };
          });
          const stored = divider.images[0].path;
          const bytes = await fs.readFile(stored);
          await fs.unlink(stored);
          clock += 180_000;
          const resume = () => restored.host.runLimitResume(root, sent.sessionId, { accountId: "default", sendId: pending.sendId });
          await assert.rejects(resume, /original image is unavailable/);
          assert.equal(restored.created[0].turns.length, 1);
          assert.equal((await restored.states.get(root)).sessions[sent.sessionId].limitResume.sendId, pending.sendId);
          assert.equal(restored.host.limitResumeFlights.size, 0);
          await fs.writeFile(stored, bytes);
          assert.equal(await resume(), true);
          await waitUntil(() => restored.created[0].turns.length === 2);
          assert.deepEqual(restored.created[0].turns[1].images, [image]);
          assert.equal(restored.created[0].turns[1].prompt, prompt);
        });
      }
    });
  }
}

test("Cancel fences delayed automatic scheduling but allows a new manual schedule", async (t) => {
  const h = harness();
  t.after(() => Promise.all([h.states.close(), h.manager.closeAll()]));
  const { sessionId } = await limitedChat(h);
  const token = h.host.limitResumeToken(ALPHA, sessionId);
  await h.host.cancelLimitResume(ALPHA, sessionId);
  assert.equal(await h.host.scheduleLimitResume(ALPHA, sessionId, { mode: "automatic", accountId: "default", token }), false);
  assert.equal(await h.host.scheduleLimitResume(ALPHA, sessionId, { mode: "automatic", accountId: "default" }), false);
  assert.equal(await h.host.scheduleLimitResume(ALPHA, sessionId, { mode: "manual", accountId: "default" }), true);
});

test("limit schedules reject unknown times, other accounts, queues and archived Chats; manual weekly schedules survive", async (t) => {
  const h = harness();
  t.after(() => Promise.all([h.states.close(), h.manager.closeAll()]));
  const { sessionId } = await limitedChat(h);
  const original = (await h.states.get(ALPHA)).sessions[sessionId];
  for (const patch of [{ archived: true }, { queued: [{ id: "next" }] }, { limitTurn: { ...original.limitTurn, at: undefined } }]) {
    await h.states.update(ALPHA, (s) => ({ ...s, sessions: { ...s.sessions, [sessionId]: { ...original, ...patch } } }));
    assert.equal(await h.host.scheduleLimitResume(ALPHA, sessionId, { mode: "manual", accountId: "default" }), false);
  }
  await h.states.update(ALPHA, (s) => ({
    ...s,
    sessions: { ...s.sessions, [sessionId]: { ...original, limitTurn: { ...original.limitTurn, at: new Date(NOW + 5 * DAY).toISOString() } } },
  }));
  assert.equal(await h.host.scheduleLimitResume(ALPHA, sessionId, { mode: "manual", accountId: "other" }), false);
  assert.equal(await h.host.scheduleLimitResume(ALPHA, sessionId, { mode: "automatic", accountId: "default" }), false);
  assert.equal(await h.host.scheduleLimitResume(ALPHA, sessionId, { mode: "manual", accountId: "default" }), true);
  assert.equal((await h.states.get(ALPHA)).sessions[sessionId].limitResume.expiresAt, NOW + 6 * DAY + 60_000);
});

test("a send or Cancel while a reset continuation prepares never steers or starts it", async (t) => {
  for (const action of ["cancel", "send"]) {
    let clock = NOW;
    let release;
    let preparing;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const entered = new Promise((resolve) => {
      preparing = resolve;
    });
    const h = harness({
      now: () => clock,
      hooks: {
        beforeSend: async (request) => {
          if (request.limitResumeId) {
            preparing();
            await gate;
          }
        },
      },
    });
    t.after(() => Promise.all([h.states.close(), h.manager.closeAll()]));
    const { sessionId } = await limitedChat(h);
    await h.host.scheduleLimitResume(ALPHA, sessionId, { mode: "manual", accountId: "default" });
    const { sendId } = (await h.states.get(ALPHA)).sessions[sessionId].limitResume;
    clock += 180_000;
    const continuing = h.host.runLimitResume(ALPHA, sessionId, { accountId: "default", sendId });
    await entered;
    if (action === "cancel") await h.host.cancelLimitResume(ALPHA, sessionId);
    else await (await h.host.send(message(ALPHA, "do new work", { sessionId }))).started;
    release();
    assert.equal(await continuing, false);
    assert.equal(
      (await h.states.get(ALPHA)).messages.some((m) => m.context?.kind === "limit-reset"),
      false,
    );
    assert.equal(h.created[0].turns.length, action === "send" ? 2 : 1);
  }
});

test("a cancelled save cannot resurrect recovery fields, for reset and ordinary sends", async (t) => {
  for (const reset of [true, false]) {
    let clock = NOW;
    let release, entered;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const preparing = new Promise((resolve) => {
      entered = resolve;
    });
    const h = harness({
      now: () => clock,
      hooks: {
        beforeTask: async (request) => {
          if (request.limitResumeId || request.body === "new request") {
            entered();
            await gate;
            throw new Error("checkpoint failed");
          }
        },
      },
    });
    t.after(() => Promise.all([h.states.close(), h.manager.closeAll()]));
    const { sessionId } = await limitedChat(h);
    await h.host.scheduleLimitResume(ALPHA, sessionId, { mode: "manual", accountId: "default" });
    const { sendId } = (await h.states.get(ALPHA)).sessions[sessionId].limitResume;
    clock += 180_000;
    const sending = reset
      ? h.host.runLimitResume(ALPHA, sessionId, { accountId: "default", sendId })
      : h.host.send(message(ALPHA, "new request", { sessionId }));
    const settled = sending.catch((error) => error);
    await preparing;
    await h.host.cancelLimitResume(ALPHA, sessionId);
    release();
    await settled;
    const session = (await h.states.get(ALPHA)).sessions[sessionId];
    assert.equal(session.limitResume, undefined);
    assert.equal(session.limitTurn, undefined);
  }
});

test("cancelled reset startup releases new queued work, but Stop and archive keep it stopped", async (t) => {
  for (const action of ["new-send", "stop", "archive"]) {
    let clock = NOW;
    let release, entered;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const preparing = new Promise((resolve) => {
      entered = resolve;
    });
    const h = harness({
      now: () => clock,
      hooks: {
        beforeTask: async (request) => {
          if (request.limitResumeId) {
            entered();
            await gate;
          }
        },
      },
    });
    t.after(() => Promise.all([h.states.close(), h.manager.closeAll()]));
    const { sessionId, chatId } = await limitedChat(h, { provider: "antigravity" });
    await h.host.scheduleLimitResume(ALPHA, sessionId, { mode: "manual", accountId: "default" });
    const { sendId } = (await h.states.get(ALPHA)).sessions[sessionId].limitResume;
    clock += 180_000;
    const sending = h.host.runLimitResume(ALPHA, sessionId, { accountId: "default", sendId });
    await preparing;
    const queued = await h.host.send(message(ALPHA, "new work", { sessionId, provider: "antigravity" }));
    assert.equal(queued.queued, true);
    if (action !== "new-send") await h.host.cancelLimitResume(ALPHA, sessionId);
    if (action === "archive")
      await h.states.update(ALPHA, (state) => ({ ...state, sessions: { ...state.sessions, [sessionId]: { ...state.sessions[sessionId], archived: true } } }));
    release();
    await sending;
    await waitUntil(() => !h.host.runs[chatId] || h.created[0].turns.length === 2);
    if (action === "new-send") {
      await queued.started;
      assert.equal(h.created[0].turns.length, 2);
    } else {
      assert.equal(h.created[0].turns.length, 1);
      assert.equal((await h.states.get(ALPHA)).sessions[sessionId].queued.length, 1);
    }
    assert.equal(
      (await h.states.get(ALPHA)).messages.some((message) => message.context?.kind === "limit-reset"),
      false,
    );
  }
});

test("Stop while automatic queue release awaits beforeSend leaves the queued message unsent", async (t) => {
  let clock = NOW;
  let releaseReset, resetEntered, releaseQueue, queueEntered;
  const resetGate = new Promise((resolve) => {
    releaseReset = resolve;
  });
  const resetReady = new Promise((resolve) => {
    resetEntered = resolve;
  });
  const queueGate = new Promise((resolve) => {
    releaseQueue = resolve;
  });
  const queueReady = new Promise((resolve) => {
    queueEntered = resolve;
  });
  const h = harness({
    now: () => clock,
    hooks: {
      beforeTask: async (request) => {
        if (request.limitResumeId) {
          resetEntered();
          await resetGate;
        }
      },
      beforeSend: async (request) => {
        if (request.queueReleaseToken) {
          queueEntered();
          await queueGate;
        }
      },
    },
  });
  t.after(() => Promise.all([h.states.close(), h.manager.closeAll()]));
  const { sessionId, chatId } = await limitedChat(h, { provider: "antigravity" });
  await h.host.scheduleLimitResume(ALPHA, sessionId, { mode: "manual", accountId: "default" });
  const { sendId } = (await h.states.get(ALPHA)).sessions[sessionId].limitResume;
  clock += 180_000;
  const reset = h.host.runLimitResume(ALPHA, sessionId, { accountId: "default", sendId });
  await resetReady;
  await h.host.send(message(ALPHA, "new work", { sessionId, provider: "antigravity" }));
  releaseReset();
  await reset;
  await queueReady;
  await h.host.cancelLimitResume(ALPHA, sessionId);
  releaseQueue();
  await waitUntil(() => !h.host.runs[chatId]);
  assert.equal(h.created[0].turns.length, 1);
  await waitUntil(() => h.host.limitResumeFlights.size === 0);
  const state = await h.states.get(ALPHA);
  assert.equal(state.sessions[sessionId].queued.length, 1);
  assert.equal(state.sessions[sessionId].queueHeld, true);
  assert.equal(h.host.startsQueue(state.sessions[sessionId]), false);
});
const ALPHA = "/projects/alpha";
const BETA = "/projects/beta";

function projectState(projectPath) {
  return {
    next_id: 2,
    projects: { 1: { id: 1, name: projectPath.split("/").at(-1) } },
    worktrees: { 1: { id: 1, name: "main", path: projectPath } },
    sessions: {},
    connections: {},
    events: [],
    messages: [],
    approvals: [],
    tasks: {},
    artifacts: {},
    outputs: [],
    conflicts: [],
  };
}

// The main process's chat wiring with fake agents and two projects saved in memory, as main.cjs builds it.
function harness({
  failStart = null,
  focused = true,
  read = async (projectPath) => projectState(projectPath),
  save,
  now = () => NOW,
  handoverTools = {
    writeTranscript: async ({ sessionId }) => `/tmp/handovers/${sessionId}.md`,
    brief: async ({ transcriptPath }) => `BRIEF ${transcriptPath}`,
  },
  hooks = {},
} = {}) {
  const saved = new Map();
  const published = [];
  const broadcasts = [];
  const created = [];
  const states = new ProjectStates({
    read,
    save: save ?? (async (projectPath, state) => void saved.set(projectPath, state)),
  });
  const manager = new SessionManager({
    createSession: (provider, options) => {
      const session = new FakeSession(provider, options);
      created.push(session);
      return session;
    },
    send: (chatId, event) => void host.receive(chatId, event),
    batchMs: 5,
  });
  const host = new ChatHost({
    states,
    startTurn: (request) => (failStart ? Promise.reject(new Error(failStart)) : manager.startTurn({ ...request, command: "/bin/agent" })),
    publish: (chatId, event, state, seq) => published.push({ chatId, event, state, seq }),
    broadcast: (projectPath, state) => broadcasts.push({ projectPath, state }),
    isFocused: () => focused,
    handoverTools,
    now,
    ...hooks,
  });
  const session = (cwd) => created.find((item) => item.options.cwd === cwd);
  return { host, manager, states, saved, published, broadcasts, created, session };
}

const message = (projectPath, body, extra = {}) => ({
  projectPath,
  sessionId: null,
  worktreeId: 1,
  body,
  images: [],
  provider: "claude",
  model: "claude-opus-5-5",
  permissionMode: "auto",
  ...extra,
});
const chatMessages = (state, sessionId) =>
  state.messages.filter((item) => item.session_id === sessionId).map(({ role, body, outcome }) => ({ role, body, ...(outcome ? { outcome } : {}) }));

// What the next agent's prompt carries ahead of the user's message: the brief, marked as Milagre's.
const framed = (brief) =>
  `<handoff_brief>\nMilagre wrote this summary of the earlier chat; it is context, not a message from the user.\n\n${brief}\n</handoff_brief>`;

test("send receipts wait for persistence and never acknowledge a rolled-back message", async (t) => {
  const { host, manager } = harness();
  t.after(() => manager.closeAll());
  const flush = host.states.flush.bind(host.states);
  let release;
  let flushing = false;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  host.states.flush = async () => {
    flushing = true;
    await gate;
    throw new Error("disk full");
  };
  const sending = host.send(message(ALPHA, "keep my draft", { clientMessageId: "receipt-test" }));
  const failed = assert.rejects(sending, /disk full/);
  await waitUntil(() => flushing);
  let settled = false;
  const receipt = host.sendStatus(ALPHA, "receipt-test").then((value) => {
    settled = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, false, "staged state is not a delivery receipt");
  release();
  await failed;
  assert.equal(await receipt, null);
  host.states.flush = flush;
  const sent = await host.send(message(ALPHA, "saved", { clientMessageId: "saved-receipt" }));
  assert.deepEqual(await host.sendStatus(ALPHA, "saved-receipt"), { sessionId: sent.sessionId });
});

test("turns in two projects run side by side and each is saved in its own project", async (t) => {
  const { host, manager, saved, session } = harness();
  t.after(() => manager.closeAll());
  const alpha = await host.send(message(ALPHA, "fix the api"));
  const beta = await host.send(message(BETA, "wire the frontend"));
  // Only alpha's chat is on screen; beta's project isn't even open.
  host.setOpenChat(`${ALPHA}#${alpha.sessionId}`);
  await waitUntil(() => session(ALPHA) && session(BETA));

  for (const [cwd, reply] of [
    [ALPHA, "API fixed."],
    [BETA, "Frontend wired."],
  ]) {
    session(cwd).emit({ type: "turn-started", turnId: "t1" });
    session(cwd).emit({ type: "text-delta", messageId: "m1", text: reply });
  }
  session(BETA).emit({ type: "turn-completed" });
  session(ALPHA).emit({ type: "turn-completed" });
  await waitUntil(() => saved.get(ALPHA)?.messages.length === 2 && saved.get(BETA)?.messages.length === 2);

  assert.deepEqual(chatMessages(saved.get(ALPHA), alpha.sessionId), [
    { role: "user", body: "fix the api" },
    { role: "assistant", body: "API fixed.", outcome: "completed" },
  ]);
  assert.deepEqual(chatMessages(saved.get(BETA), beta.sessionId), [
    { role: "user", body: "wire the frontend" },
    { role: "assistant", body: "Frontend wired.", outcome: "completed" },
  ]);
  // A turn that ends off screen leaves its chat unread; nothing was interrupted.
  assert.equal(saved.get(ALPHA).sessions[alpha.sessionId].unread, undefined);
  assert.equal(saved.get(BETA).sessions[beta.sessionId].unread, true);
  assert.deepEqual([session(ALPHA).interrupts, session(BETA).interrupts], [0, 0]);
});

test("switching the open chat to another project leaves running turns running", async (t) => {
  const { host, manager, saved, session } = harness();
  t.after(() => manager.closeAll());
  const alpha = await host.send(message(ALPHA, "long task"));
  host.setOpenChat(`${ALPHA}#${alpha.sessionId}`);
  await waitUntil(() => session(ALPHA));
  session(ALPHA).emit({ type: "turn-started", turnId: "t1" });
  session(ALPHA).emit({ type: "text-delta", messageId: "m1", text: "Halfway" });

  const beta = await host.send(message(BETA, "meanwhile"));
  host.setOpenChat(`${BETA}#${beta.sessionId}`);
  session(ALPHA).emit({ type: "text-delta", messageId: "m1", text: " and done." });
  session(ALPHA).emit({ type: "turn-completed" });
  await waitUntil(() => saved.get(ALPHA)?.messages.length === 2);

  assert.equal(session(ALPHA).interrupts, 0);
  assert.deepEqual(chatMessages(saved.get(ALPHA), alpha.sessionId).at(-1), { role: "assistant", body: "Halfway and done.", outcome: "completed" });
  assert.equal(saved.get(ALPHA).sessions[alpha.sessionId].unread, true);
});

test("a chat keeps its session id, provider session and worktree across turns", async (t) => {
  const { host, manager, saved, session } = harness();
  t.after(() => manager.closeAll());
  const first = await host.send(message(ALPHA, "one"));
  await waitUntil(() => session(ALPHA));
  session(ALPHA).emit({ type: "session-started", nativeId: "native-7" });
  session(ALPHA).emit({ type: "turn-started", turnId: "t1" });
  session(ALPHA).emit({ type: "turn-completed" });
  await waitUntil(() => saved.get(ALPHA)?.messages.length === 2);

  // The worktree asked for is ignored for an existing chat: it runs where it always has.
  const second = await host.send(message(ALPHA, "two", { sessionId: first.sessionId, worktreeId: 99 }));
  await waitUntil(() => session(ALPHA).turns.length === 2);

  assert.equal(second.sessionId, first.sessionId);
  assert.equal(saved.get(ALPHA).sessions[first.sessionId].native_session_id, "native-7");
  assert.equal(saved.get(ALPHA).sessions[first.sessionId].provider, "claude");
});

test("a message sent mid-turn saves the reply so far above it and steers the turn", async (t) => {
  const { host, manager, saved, session } = harness();
  t.after(() => manager.closeAll());
  const chat = await host.send(message(ALPHA, "start"));
  await waitUntil(() => session(ALPHA));
  session(ALPHA).emit({ type: "turn-started", turnId: "t1" });
  session(ALPHA).emit({ type: "text-delta", messageId: "m1", text: "Working on it." });
  await waitUntil(() => host.runs[`${ALPHA}#${chat.sessionId}`]?.text === "Working on it.");

  await host.send(message(ALPHA, "also add tests", { sessionId: chat.sessionId }));
  session(ALPHA).emit({ type: "text-delta", messageId: "m2", text: "Tests added." });
  session(ALPHA).emit({ type: "turn-completed" });
  await waitUntil(() => saved.get(ALPHA)?.messages.length === 4);

  assert.deepEqual(chatMessages(saved.get(ALPHA), chat.sessionId), [
    { role: "user", body: "start" },
    { role: "assistant", body: "Working on it." },
    { role: "user", body: "also add tests" },
    { role: "assistant", body: "Tests added.", outcome: "completed" },
  ]);
  assert.equal(session(ALPHA).turns.length, 2);
});

test("a turn that can't start fails in its chat", async () => {
  const { host, saved } = harness({ failStart: "Claude Code isn't installed." });
  const chat = await host.send(message(BETA, "hello"));
  await waitUntil(() => saved.get(BETA)?.messages.length === 2);

  assert.deepEqual(chatMessages(saved.get(BETA), chat.sessionId).at(-1), {
    role: "assistant",
    body: "Agent error: Claude Code isn't installed.",
    outcome: "failed",
  });
});

test("a message for a chat or worktree that's gone is refused and saves nothing", async () => {
  const { host, saved } = harness();
  await assert.rejects(host.send(message(ALPHA, "hi", { sessionId: 42 })), /That chat is no longer in the project/);
  await assert.rejects(host.send(message(ALPHA, "hi", { worktreeId: 42 })), /That worktree is no longer in the project/);
  assert.equal(saved.has(ALPHA), false);
});

test("a window that loads mid-turn takes the runs and skips the events they hold", async (t) => {
  const { host, manager, published, session } = harness();
  t.after(() => manager.closeAll());
  const chat = await host.send(message(ALPHA, "go"));
  const chatId = `${ALPHA}#${chat.sessionId}`;
  await waitUntil(() => session(ALPHA));
  session(ALPHA).emit({ type: "turn-started", turnId: "t1" });
  session(ALPHA).emit({ type: "text-delta", messageId: "m1", text: "Before reload. " });
  session(ALPHA).emit({
    type: "permission-request",
    requestId: "r1",
    kind: "command",
    tool: "Shell",
    title: "Run this command?",
    command: "ls",
    allowForChat: true,
  });
  await waitUntil(() => host.runs[chatId]?.approvals.length === 1);

  const snapshot = host.snapshot();
  assert.equal(snapshot.runs[chatId].text, "Before reload. ");
  assert.deepEqual(
    snapshot.runs[chatId].approvals.map((request) => request.requestId),
    ["r1"],
  );

  session(ALPHA).emit({ type: "text-delta", messageId: "m1", text: "After reload." });
  await waitUntil(() => host.runs[chatId]?.text.endsWith("After reload."));
  await waitUntil(() => published.some((item) => item.event.type === "text-delta" && item.event.text === "After reload."));

  // The reloaded window applies only the events numbered after its snapshot.
  const runs = published.filter((item) => item.seq > snapshot.seq).reduce((current, item) => applyRunEvent(current, item.chatId, item.event), snapshot.runs);
  assert.equal(runs[chatId].text, "Before reload. After reload.");
  assert.ok(published.every((item) => typeof item.seq === "number"));
});

test("step deadlines agree in live events and reload snapshots, including duplicate starts and approval", async (t) => {
  let now = NOW;
  const { host, manager, published, session } = harness({ now: () => now });
  t.after(() => manager.closeAll());
  const chat = await host.send(message(ALPHA, "go"));
  const chatId = `${ALPHA}#${chat.sessionId}`;
  await waitUntil(() => session(ALPHA));
  const step = { id: "tool-1", kind: "shell", title: "Ran `check`" };
  session(ALPHA).emit({ type: "step-started", step });
  await waitUntil(() => published.some((item) => item.event.type === "step-started"));
  const event = published.find((item) => item.event.type === "step-started").event;
  assert.equal(event.step.startedAt, NOW);
  assert.equal(step.startedAt, undefined, "the provider's event is not mutated");
  const snapshot = host.snapshot();
  assert.equal(snapshot.runs[chatId].steps[0].startedAt, NOW);
  const client = applyRunEvent({}, chatId, { type: "turn-started" });
  assert.equal(applyRunEvent(client, chatId, event)[chatId].steps[0].startedAt, NOW);

  now += 5000;
  session(ALPHA).emit({ type: "step-started", step: { ...step, title: "Updated title" } });
  session(ALPHA).emit({ type: "permission-request", requestId: "permission-1", stepId: step.id, kind: "command", tool: "Shell", title: "Approve?" });
  await waitUntil(() => host.runs[chatId].approvals.length === 1);
  session(ALPHA).emit({ type: "permission-resolved", requestId: "permission-1" });
  session(ALPHA).emit({ type: "step-output", id: step.id, text: "still running" });
  await waitUntil(() => host.runs[chatId].steps[0].detail === "still running");
  assert.equal(host.runs[chatId].steps[0].startedAt, NOW);
  const reloaded = published.filter((item) => item.seq > snapshot.seq).reduce((runs, item) => applyRunEvent(runs, chatId, item.event), snapshot.runs);
  assert.equal(reloaded[chatId].steps[0].startedAt, NOW);
  assert.equal(reloaded[chatId].steps[0].title, "Updated title");
  assert.equal(reloaded[chatId].approvals.length, 0);
});

test("tool facts and completion time agree in live events, snapshots and saved messages", async (t) => {
  let now = NOW;
  const { host, manager, published, session, states } = harness({ now: () => now });
  t.after(() => manager.closeAll());
  const chat = await host.send(message(ALPHA, "check"));
  const chatId = `${ALPHA}#${chat.sessionId}`;
  await waitUntil(() => session(ALPHA));
  const input = "printf one\nprintf two";
  session(ALPHA).emit({ type: "step-started", step: { id: "tool", kind: "shell", title: "Ran check", detail: `$ ${input}\n` } });
  await waitUntil(() => host.runs[chatId]?.steps.length);
  now += 4200;
  session(ALPHA).emit({ type: "step-completed", id: "tool", status: "failed", detail: `$ ${input}\nError: missing header` });
  await waitUntil(() => host.runs[chatId].steps[0].status === "failed");
  const step = host.runs[chatId].steps[0];
  assert.equal(step.input, input);
  assert.equal(step.durationMs, 4200);
  assert.equal(step.endedAt, now);
  assert.equal(step.error, "Error: missing header");
  const completion = published.find((item) => item.event.type === "step-completed").event;
  assert.equal(completion.durationMs, step.durationMs);
  assert.equal(completion.error, step.error);
  session(ALPHA).emit({ type: "turn-completed" });
  await waitUntil(() => !host.runs[chatId]);
  const saved = (await states.get(ALPHA)).messages.at(-1).steps[0];
  assert.equal(saved.durationMs, 4200);
  assert.equal(saved.input, input);
  assert.equal(saved.error, step.error);
});

test("a turn that ends in the open chat while no window has focus leaves it unread", async (t) => {
  const { host, manager, saved, session } = harness({ focused: false });
  t.after(() => manager.closeAll());
  const chat = await host.send(message(ALPHA, "go"));
  host.setOpenChat(`${ALPHA}#${chat.sessionId}`);
  await waitUntil(() => session(ALPHA));
  session(ALPHA).emit({ type: "turn-started", turnId: "t1" });
  session(ALPHA).emit({ type: "turn-completed" });
  await waitUntil(() => saved.get(ALPHA)?.messages.length === 2);

  assert.equal(saved.get(ALPHA).sessions[chat.sessionId].unread, true);
});

test("a note added while the chat's turn runs lands after the reply", async (t) => {
  const { host, manager, saved, session } = harness();
  t.after(() => manager.closeAll());
  const chat = await host.send(message(ALPHA, "commit it"));
  const chatId = `${ALPHA}#${chat.sessionId}`;
  await waitUntil(() => session(ALPHA));
  session(ALPHA).emit({ type: "turn-started", turnId: "t1" });
  session(ALPHA).emit({ type: "text-delta", messageId: "m1", text: "Committing." });
  await waitUntil(() => host.runs[chatId]?.text === "Committing.");

  await host.addNote(chatId, { body: "Committed abc123", context: { kind: "git-action" } });
  await host.states.flush();
  assert.equal(saved.get(ALPHA).messages.length, 1, "the note waits for the turn");
  session(ALPHA).emit({ type: "turn-completed" });
  await waitUntil(() => saved.get(ALPHA)?.messages.length === 3);

  assert.deepEqual(
    saved.get(ALPHA).messages.map(({ role, body, context }) => ({ role, body, context })),
    [
      { role: "user", body: "commit it", context: null },
      { role: "assistant", body: "Committing.", context: null },
      { role: "assistant", body: "Committed abc123", context: { kind: "git-action" } },
    ],
  );
});

test("a note for an idle chat is published immediately and saved by flush", async () => {
  const { host, saved, broadcasts } = harness({ failStart: "no agent" });
  const chat = await host.send(message(BETA, "hi"));
  await waitUntil(() => saved.get(BETA)?.messages.length === 2);
  await host.addNote(`${BETA}#${chat.sessionId}`, { body: "Pushed to origin", context: { kind: "git-action" } });
  await host.states.flush();

  assert.equal(saved.get(BETA).messages.at(-1).body, "Pushed to origin");
  assert.equal(broadcasts.at(-1).state.messages.at(-1).body, "Pushed to origin");
});

test("answers to a question are saved as the user's message after the reply so far, and can be taken back", async (t) => {
  const { host, manager, saved, published, session } = harness();
  t.after(() => manager.closeAll());
  const chat = await host.send(message(ALPHA, "plan it"));
  const chatId = `${ALPHA}#${chat.sessionId}`;
  await waitUntil(() => session(ALPHA));
  session(ALPHA).emit({ type: "turn-started", turnId: "t1" });
  session(ALPHA).emit({ type: "text-delta", messageId: "m1", text: "Which layout?" });
  await waitUntil(() => host.runs[chatId]?.text === "Which layout?");

  const messageId = await host.recordAnswers(chatId, "Layout: grid");
  assert.equal(published.at(-1).event.type, "answers-sent");
  await host.states.flush();
  assert.deepEqual(chatMessages(saved.get(ALPHA), chat.sessionId), [
    { role: "user", body: "plan it" },
    { role: "assistant", body: "Which layout?" },
    { role: "user", body: "Layout: grid" },
  ]);
  assert.equal(host.runs[chatId].text, "");
  assert.equal(published.at(-1).event.type, "answers-sent");

  await host.takeBack(chatId, messageId);
  await host.states.flush();
  assert.equal(
    saved.get(ALPHA).messages.some((item) => item.id === messageId),
    false,
  );
});

async function chatWithReply(host, session, saved) {
  const { sessionId } = await host.send(message(ALPHA, "fix the login redirect"));
  await waitUntil(() => session(ALPHA));
  session(ALPHA).emit({ type: "turn-started", turnId: "t1" });
  session(ALPHA).emit({ type: "session-started", nativeId: "claude-1" });
  session(ALPHA).emit({ type: "text-delta", messageId: "m1", text: "Done." });
  session(ALPHA).emit({ type: "turn-completed" });
  await waitUntil(() => saved.get(ALPHA)?.messages.length === 2);
  return sessionId;
}

test("Compact now: the /compact runs on the chat's own provider, its divider records the gauge, and the empty turn saves no reply", async (t) => {
  const { host, manager, saved, states, session, created } = harness();
  t.after(() => manager.closeAll());
  const sessionId = await chatWithReply(host, session, saved);
  // The gauge stood at 897k when the turn ended, so the composer offered Compact now.
  session(ALPHA).emit({ type: "context-usage", used: 1, size: 1 });
  await states.update(ALPHA, (state) => ({
    ...state,
    sessions: { ...state.sessions, [sessionId]: { ...state.sessions[sessionId], contextUsage: { used: 897_000, size: 1_000_000 } } },
  }));
  const { compactionMessage } = require("@milagre/shared/compaction");
  // The picker may sit on Codex: the compaction still runs on Claude, where the chat is, with no handoff.
  await host.send(message(ALPHA, "", { sessionId, ...compactionMessage(), provider: "codex", model: "gpt-6" }));
  await waitUntil(() => session(ALPHA).turns.length === 2);
  assert.equal(session(ALPHA).turns[1].prompt, "/compact");
  // The same Claude session took it: no Codex session was created.
  assert.deepEqual(
    created.map((item) => item.provider),
    ["claude"],
  );
  assert.equal(session(ALPHA).turns[1].model, "claude-opus-5-5");
  assert.deepEqual(dividers(saved.get(ALPHA), sessionId), []);
  const request = () => saved.get(ALPHA).messages.find((item) => item.context?.kind === "compaction");
  assert.deepEqual(request().context, { kind: "compaction", status: "preparing", before: 897_000, size: 1_000_000 });

  session(ALPHA).emit({ type: "turn-started", turnId: "t2" });
  session(ALPHA).emit({ type: "context-compacting" });
  session(ALPHA).emit({ type: "context-compacted", trigger: "manual", before: 897_000, after: 42_000 });
  session(ALPHA).emit({ type: "turn-completed" });
  await waitUntil(() => request().context.status === "done" && !host.runs[`${ALPHA}#${sessionId}`]);
  assert.deepEqual(request().context, { kind: "compaction", status: "done", before: 897_000, after: 42_000, size: 1_000_000 });
  assert.deepEqual(chatMessages(saved.get(ALPHA), sessionId), [
    { role: "user", body: "fix the login redirect" },
    { role: "assistant", body: "Done.", outcome: "completed" },
    { role: "user", body: "/compact" },
  ]);
  assert.deepEqual(saved.get(ALPHA).sessions[sessionId].contextUsage, { used: 42_000, size: 1_000_000 });
});

test("a /compact changes no files, so it captures no checkpoint", async (t) => {
  const tasks = [];
  const { host, manager, saved, session } = harness({ hooks: { beforeTask: async (request) => void tasks.push(request.body) } });
  t.after(() => manager.closeAll());
  const sessionId = await chatWithReply(host, session, saved);
  const { compactionMessage } = require("@milagre/shared/compaction");
  await host.send(message(ALPHA, "", { sessionId, ...compactionMessage() }));
  await waitUntil(() => session(ALPHA).turns.length === 2);
  assert.deepEqual(tasks, ["fix the login redirect"]);
});

test("automatic compaction saves a divider between the reply before and after it", async (t) => {
  const { host, manager, saved, session } = harness();
  t.after(() => manager.closeAll());
  const chat = await host.send(message(ALPHA, "keep working"));
  await waitUntil(() => session(ALPHA));
  session(ALPHA).emit({ type: "turn-started", turnId: "t1" });
  session(ALPHA).emit({ type: "context-usage", used: 190_000, size: 200_000 });
  session(ALPHA).emit({ type: "text-delta", messageId: "t1", text: "Before." });
  session(ALPHA).emit({ type: "context-compacting" });
  const divider = () => saved.get(ALPHA).messages.find((item) => item.context?.kind === "compaction");
  await waitUntil(() => divider()?.context.status === "preparing");
  session(ALPHA).emit({ type: "context-compacted", trigger: "auto", before: 190_000, after: 20_000 });
  session(ALPHA).emit({ type: "text-delta", messageId: "t1", text: "After." });
  session(ALPHA).emit({ type: "turn-completed" });
  await waitUntil(() => divider()?.context.status === "done" && !host.runs[`${ALPHA}#${chat.sessionId}`]);
  assert.deepEqual(
    saved.get(ALPHA).messages.map((item) => item.body),
    ["keep working", "Before.", "", "After."],
  );
  assert.deepEqual(divider().context, { kind: "compaction", status: "done", before: 190_000, after: 20_000, size: 200_000 });
});

test("Compact after turn queues once, can be cancelled and never steers /compact into Claude", async (t) => {
  const { host, manager, states, session } = harness();
  t.after(() => manager.closeAll());
  const { compactionMessage } = require("@milagre/shared/compaction");
  const chat = await host.send(message(ALPHA, "start"));
  await chat.started;
  const chatId = `${ALPHA}#${chat.sessionId}`;
  session(ALPHA).emit({ type: "turn-started", turnId: "t1" });
  session(ALPHA).emit({ type: "session-started", nativeId: "claude-1" });
  const compact = () => host.send(message(ALPHA, "", { sessionId: chat.sessionId, ...compactionMessage() }));
  await Promise.all([compact(), compact()]);
  let current = (await states.get(ALPHA)).sessions[chat.sessionId];
  assert.equal(current.queued.length, 1);
  assert.equal(session(ALPHA).turns.length, 1);
  await host.removeQueued(chatId, current.queued[0].id);
  assert.equal((await states.get(ALPHA)).sessions[chat.sessionId].queued?.length ?? 0, 0);
  await compact();
  session(ALPHA).emit({ type: "context-usage", used: 156000, size: 200000 });
  session(ALPHA).emit({ type: "turn-completed" });
  await waitUntil(() => session(ALPHA).turns.length === 2);
  assert.equal(session(ALPHA).turns[1].prompt, "/compact");
  await compact(); // A second tap after the compact started is still the same request.
  const state = await states.get(ALPHA);
  assert.equal(state.messages.findLast((m) => m.context?.kind === "compaction").context.before, 156000);
  assert.equal(state.sessions[chat.sessionId].queued?.length ?? 0, 0);
});

test("Compact now is refused on unsupported and archived chats", async (t) => {
  const { host, manager, states, session, saved } = harness();
  t.after(() => manager.closeAll());
  const sessionId = await chatWithReply(host, session, saved);
  const { compactionMessage } = require("@milagre/shared/compaction");
  for (const [patch, error] of [
    [{ provider: "codex" }, /Only Claude chats/],
    [{ provider: "antigravity" }, /Only Claude chats/],
    [{ provider: "claude", archived: true }, /Unarchive/],
  ]) {
    await states.update(ALPHA, (state) => ({ ...state, sessions: { ...state.sessions, [sessionId]: { ...state.sessions[sessionId], ...patch } } }));
    await assert.rejects(host.send(message(ALPHA, "", { sessionId, ...compactionMessage() })), error);
  }
});

test("quiet auto compact waits for the completed turn, preserves the draft, updates usage and does not loop or notify", async (t) => {
  const { host, manager, states, session, published } = harness({
    focused: false,
    hooks: { contextSettings: () => ({ buttonThreshold: 70, autoThreshold: 80, autoCompact: true }) },
  });
  t.after(() => manager.closeAll());
  const chat = await host.send(message(ALPHA, "start"));
  await chat.started;
  const id = `${ALPHA}#${chat.sessionId}`;
  session(ALPHA).emit({ type: "turn-started", turnId: "t1" });
  session(ALPHA).emit({ type: "session-started", nativeId: "claude-1" });
  session(ALPHA).emit({ type: "context-usage", used: 160000, size: 200000 });
  await waitUntil(() => host.runs[id]?.contextUsage?.used === 160000);
  assert.equal(session(ALPHA).turns.length, 1);
  await states.update(ALPHA, (state) => ({
    ...state,
    sessions: { ...state.sessions, [chat.sessionId]: { ...state.sessions[chat.sessionId], draft: "Keep my next question" } },
  }));
  session(ALPHA).emit({ type: "turn-completed" });
  await waitUntil(() => session(ALPHA).turns.length === 2);
  let state = await states.get(ALPHA);
  assert.equal(state.sessions[chat.sessionId].draft, "Keep my next question");
  assert.equal(state.messages.at(-1).context.quiet, true);
  assert.equal(state.messages.at(-1).context.threshold, 80);
  assert.equal(session(ALPHA).turns[1].prompt, "/compact");
  await states.update(ALPHA, (s) => ({ ...s, sessions: { ...s.sessions, [chat.sessionId]: { ...s.sessions[chat.sessionId], unread: false } } }));
  session(ALPHA).emit({ type: "turn-started", turnId: "t2" });
  // Even a successful boundary which frees no space cannot start an endless compact loop.
  session(ALPHA).emit({ type: "context-compacted", trigger: "manual", before: 160000, after: 160000 });
  session(ALPHA).emit({ type: "turn-completed" });
  await waitUntil(() => !host.runs[id]);
  await host.afterTurn(id, { type: "turn-completed" });
  state = await states.get(ALPHA);
  assert.equal(session(ALPHA).turns.length, 2);
  assert.equal(state.sessions[chat.sessionId].unread, false);
  assert.equal(published.at(-1).event.quiet, true);
});

test("auto compaction ignores disabled, below-threshold, cancelled, failed and unsupported turns", async (t) => {
  for (const [provider, enabled, used, end] of [
    ["claude", false, 190000, "turn-completed"],
    ["claude", true, 169999, "turn-completed"],
    ["claude", true, 190000, "turn-cancelled"],
    ["claude", true, 190000, "turn-failed"],
    ["codex", true, 190000, "turn-completed"],
  ]) {
    await t.test(`${provider} ${enabled} ${used} ${end}`, async (t) => {
      const { host, manager, session } = harness({ hooks: { contextSettings: () => ({ buttonThreshold: 70, autoThreshold: 85, autoCompact: enabled }) } });
      t.after(() => manager.closeAll());
      const chat = await host.send(message(ALPHA, "start", { provider }));
      await chat.started;
      const id = `${ALPHA}#${chat.sessionId}`;
      session(ALPHA).emit({ type: "session-started", nativeId: "native-1" });
      session(ALPHA).emit({ type: "context-usage", used, size: 200000 });
      session(ALPHA).emit({ type: end, message: "failed" });
      await waitUntil(() => !host.runs[id]);
      await host.afterTurn(id, { type: end });
      assert.equal(session(ALPHA).turns.length, 1);
    });
  }
});

const dividers = (state, sessionId) =>
  state.messages.filter((item) => item.session_id === sessionId && item.context?.kind === "handoff").map((item) => item.context);

test("a send on the other provider adds a divider before the message, briefs the new provider and parks the old session", async (t) => {
  const briefs = [];
  const { host, manager, saved, created } = harness({
    handoverTools: {
      writeTranscript: async ({ sessionId }) => `/tmp/handovers/${sessionId}.md`,
      brief: async (input) => (briefs.push(input), "BRIEF"),
    },
  });
  t.after(() => manager.closeAll());
  const { sessionId } = await host.send(message(ALPHA, "fix the login redirect"));
  await waitUntil(() => created[0]);
  created[0].emit({ type: "session-started", nativeId: "claude-1" });
  created[0].emit({ type: "turn-started", turnId: "t1" });
  created[0].emit({ type: "turn-completed" });
  await waitUntil(() => saved.get(ALPHA)?.messages.length === 2);

  await host.send(message(ALPHA, "add tests", { sessionId, provider: "codex", model: "gpt-6" }));
  await waitUntil(() => created.find((item) => item.provider === "codex" && item.turns.length));
  const codex = created.find((item) => item.provider === "codex" && item.turns.length);
  await host.states.flush();
  const state = saved.get(ALPHA);

  assert.deepEqual(
    state.messages.filter((item) => item.session_id === sessionId).map((item) => item.context?.kind ?? item.role),
    ["user", "assistant", "handoff", "user"],
  );
  assert.deepEqual(dividers(state, sessionId), [
    {
      kind: "handoff",
      from: { provider: "claude", model: "claude-opus-5-5" },
      to: { provider: "codex", model: "gpt-6" },
      status: "done",
      brief: "BRIEF",
      transcriptPath: `/tmp/handovers/${sessionId}.md`,
    },
  ]);
  assert.equal(codex.turns[0].prompt, `${framed("BRIEF")}\n\nadd tests`);
  assert.equal(codex.options.resumeId, undefined);
  assert.deepEqual(
    { provider: state.sessions[sessionId].provider, parked: state.sessions[sessionId].native_sessions, current: state.sessions[sessionId].native_session_id },
    { provider: "codex", parked: { claude: "claude-1" }, current: undefined },
  );
  assert.deepEqual(
    briefs.map(({ provider, catchUp }) => ({ provider, catchUp })),
    [{ provider: "claude", catchUp: false }],
  );
});

test("a send on another provider waits for the Chat's background subagents: nothing is saved and the Claude process stays (T3 #16000)", async (t) => {
  const { host, manager, saved, created } = harness();
  t.after(() => manager.closeAll());
  const { sessionId } = await host.send(message(ALPHA, "review in the background"));
  await waitUntil(() => created[0]);
  created[0].emit({ type: "session-started", nativeId: "claude-1" });
  created[0].emit({ type: "turn-started", turnId: "t1" });
  created[0].emit({
    type: "subagent-update",
    agent: { id: "bg", title: "Review", status: "running", background: true, startedAt: 1, updatedAt: 1, transcript: [] },
  });
  created[0].emit({ type: "turn-completed" });
  await waitUntil(() => saved.get(ALPHA)?.messages.length === 2 && saved.get(ALPHA).sessions[sessionId].subagents?.length === 1);

  await assert.rejects(
    host.send(message(ALPHA, "now on codex", { sessionId, provider: "codex", model: "gpt-6" })),
    /A background task is still running in this Chat\. Switching to Codex would stop it\. Ask the agent to stop it, or send again once it finishes\./,
  );
  await host.states.flush();
  assert.equal(saved.get(ALPHA).messages.length, 2);
  assert.equal(saved.get(ALPHA).sessions[sessionId].provider, "claude");
  assert.deepEqual([created.length, created[0].closed], [1, false]);
  // The same provider is no switch: the message goes to the Claude process the subagent runs in.
  await host.send(message(ALPHA, "and on claude", { sessionId }));
  await waitUntil(() => created[0].turns.length === 2);

  created[0].emit({ type: "turn-started", turnId: "t2" });
  created[0].emit({
    type: "subagent-update",
    agent: { id: "bg", title: "Review", status: "completed", background: true, startedAt: 1, updatedAt: 2, transcript: [] },
  });
  created[0].emit({ type: "turn-completed" });
  await waitUntil(() => !host.runs[`${ALPHA}#${sessionId}`] && saved.get(ALPHA).sessions[sessionId].subagents[0].status === "completed");
  await host.send(message(ALPHA, "now on codex", { sessionId, provider: "codex", model: "gpt-6" }));
  await waitUntil(() => created.find((item) => item.provider === "codex" && item.turns.length));
});

test("switching back resumes the parked session with a catch-up of what happened since", async (t) => {
  const briefs = [];
  const { host, manager, saved, created } = harness({
    handoverTools: { writeTranscript: async () => "/tmp/t.md", brief: async (input) => (briefs.push(input), "CATCH-UP") },
  });
  t.after(() => manager.closeAll());
  const { sessionId } = await host.send(message(ALPHA, "one"));
  await waitUntil(() => created[0]);
  created[0].emit({ type: "session-started", nativeId: "claude-1" });
  created[0].emit({ type: "turn-started", turnId: "t1" });
  created[0].emit({ type: "turn-completed" });
  await waitUntil(() => saved.get(ALPHA)?.messages.length === 2);
  await host.send(message(ALPHA, "two", { sessionId, provider: "codex", model: "gpt-6" }));
  await waitUntil(() => created.find((item) => item.provider === "codex" && item.turns.length));
  const codex = created.find((item) => item.provider === "codex" && item.turns.length);
  codex.emit({ type: "session-started", nativeId: "codex-1" });
  codex.emit({ type: "turn-started", turnId: "t1" });
  codex.emit({ type: "turn-completed" });
  await waitUntil(() => saved.get(ALPHA)?.messages.length === 5);

  await host.send(message(ALPHA, "three", { sessionId }));
  const backOf = () => created.findLast((item) => item.provider === "claude");
  await waitUntil(() => backOf()?.options.resumeId === "claude-1" && backOf().turns.length);
  const back = backOf();
  await host.states.flush();
  const state = saved.get(ALPHA);
  assert.equal(back.turns[0].prompt, `${framed("CATCH-UP")}\n\nthree`);
  assert.deepEqual(state.sessions[sessionId].native_sessions, { codex: "codex-1" });
  assert.equal(state.sessions[sessionId].native_session_id, "claude-1");
  assert.equal(briefs.at(-1).catchUp, true);
  assert.match(briefs.at(-1).transcript, /Earlier messages are left out/);
  assert.doesNotMatch(briefs.at(-1).transcript, /## User\n\none/);
});

test("a model change on the same provider adds no divider", async (t) => {
  const { host, manager, saved, session } = harness();
  t.after(() => manager.closeAll());
  const sessionId = await chatWithReply(host, session, saved);
  await host.send(message(ALPHA, "again", { sessionId, model: "claude-sonnet-5-5" }));
  await waitUntil(() => session(ALPHA).turns.length === 2);
  await host.states.flush();
  assert.deepEqual(dividers(saved.get(ALPHA), sessionId), []);
  assert.equal(session(ALPHA).turns[1].prompt, "again");
});

test("a message that steers a running turn stays on its provider and adds no divider", async (t) => {
  const { host, manager, saved, session } = harness();
  t.after(() => manager.closeAll());
  const sessionId = await chatWithReply(host, session, saved);
  await host.send(message(ALPHA, "next", { sessionId }));
  await waitUntil(() => session(ALPHA).turns.length === 2);
  session(ALPHA).emit({ type: "turn-started", turnId: "t2" });
  await host.send(message(ALPHA, "and use codex", { sessionId, provider: "codex", model: "gpt-6" }));
  await waitUntil(() => session(ALPHA).turns.length === 3);
  await host.states.flush();
  assert.deepEqual(dividers(saved.get(ALPHA), sessionId), []);
  assert.equal(saved.get(ALPHA).sessions[sessionId].provider, "claude");
  // The steering message runs on the model of the turn it joins, not the one asked for.
  assert.equal(saved.get(ALPHA).messages.findLast((item) => item.role === "user").model, "claude-opus-5-5");
  assert.equal(session(ALPHA).turns[2].model, "claude-opus-5-5");
});

test("a send after a failed resume restores context with a whole-chat brief", async (t) => {
  const { host, manager, saved, session, created } = harness({
    handoverTools: { writeTranscript: async () => "/tmp/t.md", brief: async ({ catchUp }) => (catchUp ? "CATCH-UP" : "WHOLE") },
  });
  t.after(() => manager.closeAll());
  const sessionId = await chatWithReply(host, session, saved);
  session(ALPHA).emit({ type: "session-reset" });
  await host.states.flush();
  await host.send(message(ALPHA, "again", { sessionId }));
  await waitUntil(() => created.at(-1).turns.at(-1)?.prompt === `${framed("WHOLE")}\n\nagain`);
  await host.states.flush();
  assert.deepEqual(
    dividers(saved.get(ALPHA), sessionId).map(({ from, to, status }) => [from.provider, to.provider, status]),
    [["claude", "claude", "done"]],
  );
});

test("a first turn that failed before its session started is resent with no restore", async (t) => {
  const { host, manager, saved, session } = harness();
  t.after(() => manager.closeAll());
  const { sessionId } = await host.send(message(ALPHA, "one"));
  await waitUntil(() => session(ALPHA));
  session(ALPHA).emit({ type: "turn-started", turnId: "t1" });
  session(ALPHA).emit({ type: "turn-failed", message: "claude not found" });
  await waitUntil(() => saved.get(ALPHA)?.messages.length === 2);
  await host.send(message(ALPHA, "one again", { sessionId }));
  await waitUntil(() => session(ALPHA).turns.length === 2);
  await host.states.flush();
  assert.deepEqual(dividers(saved.get(ALPHA), sessionId), []);
});

test("stopping while the brief is written fails the divider, cancels the turn and starts no agent", async (t) => {
  let release;
  const { host, manager, saved, session, created } = harness({
    handoverTools: { writeTranscript: async () => "/tmp/t.md", brief: () => new Promise((resolve) => (release = resolve)) },
  });
  t.after(() => manager.closeAll());
  const sessionId = await chatWithReply(host, session, saved);
  await host.send(message(ALPHA, "switch", { sessionId, provider: "codex", model: "gpt-6" }));
  await waitUntil(() => release);
  assert.equal(await host.cancelHandoff(`${ALPHA}#${sessionId}`), true);
  release("LATE");
  await waitUntil(() => saved.get(ALPHA).messages.some((item) => item.outcome === "cancelled"));
  await host.states.flush();
  assert.deepEqual(
    dividers(saved.get(ALPHA), sessionId).map(({ status }) => status),
    ["failed"],
  );
  assert.equal(
    created.some((item) => item.provider === "codex"),
    false,
  );
  assert.equal(session(ALPHA).interrupts, 0);
});

test("a send during preparing waits, then steers after the briefed message; the old session gets no new turn", async (t) => {
  let release;
  const { host, manager, saved, session, created } = harness({
    handoverTools: { writeTranscript: async () => "/tmp/t.md", brief: () => new Promise((resolve) => (release = resolve)) },
  });
  t.after(() => manager.closeAll());
  const sessionId = await chatWithReply(host, session, saved);
  await host.send(message(ALPHA, "switch", { sessionId, provider: "codex", model: "gpt-6" }));
  await waitUntil(() => release);
  const second = await host.send(message(ALPHA, "also this", { sessionId, provider: "codex", model: "gpt-6" }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    created.some((item) => item.provider === "codex"),
    false,
  );
  assert.equal(session(ALPHA).turns.length, 1);
  release("BRIEF");
  await waitUntil(() => created.find((item) => item.provider === "codex")?.turns.length === 2);
  assert.deepEqual(
    created.find((item) => item.provider === "codex").turns.map((turn) => turn.prompt),
    [`${framed("BRIEF")}\n\nswitch`, "also this"],
  );
  assert.equal(session(ALPHA).turns.length, 1);
  assert.notEqual(await second.started, null);
  await host.states.flush();
  assert.deepEqual(
    dividers(saved.get(ALPHA), sessionId).map(({ status }) => status),
    ["done"],
  );
});

test("Stop while a message sent during preparing is still flushing leaves no run open, and a later send works", async (t) => {
  let release;
  const { host, manager, saved, session, created } = harness({
    handoverTools: { writeTranscript: async () => "/tmp/t.md", brief: () => new Promise((resolve) => (release = resolve)) },
  });
  t.after(() => manager.closeAll());
  const sessionId = await chatWithReply(host, session, saved);
  const chatId = `${ALPHA}#${sessionId}`;
  await host.send(message(ALPHA, "switch", { sessionId, provider: "codex", model: "gpt-6" }));
  await waitUntil(() => release);
  // The second message's save is held back until Stop has cancelled the handoff.
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  const flush = host.states.flush.bind(host.states);
  host.states.flush = async (...args) => {
    await gate;
    return flush(...args);
  };
  const second = host.send(message(ALPHA, "also this", { sessionId, provider: "codex", model: "gpt-6" }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await host.cancelHandoff(chatId), true);
  open();
  assert.equal(await (await second).started, null);
  host.states.flush = flush;
  assert.equal(host.runs[chatId], undefined);
  await host.states.flush();
  assert.ok(saved.get(ALPHA).messages.some((item) => item.outcome === "cancelled"));
  release("LATE");
  await host.send(message(ALPHA, "again", { sessionId, provider: "claude", model: "claude-opus-5-5" }));
  await waitUntil(() => session(ALPHA).turns.length === 2);
  assert.equal(
    created.some((item) => item.provider === "codex"),
    false,
  );
});

test("a handoff that fails leaves no run open for a message sent while it prepared", async (t) => {
  let fail;
  const { host, manager, saved, session } = harness({
    handoverTools: { writeTranscript: async () => "/tmp/t.md", brief: () => new Promise((_, reject) => (fail = reject)) },
  });
  t.after(() => manager.closeAll());
  const sessionId = await chatWithReply(host, session, saved);
  const chatId = `${ALPHA}#${sessionId}`;
  await host.send(message(ALPHA, "switch", { sessionId, provider: "codex", model: "gpt-6" }));
  await waitUntil(() => fail);
  const second = await host.send(message(ALPHA, "also this", { sessionId, provider: "codex", model: "gpt-6" }));
  fail(new Error("brief broke"));
  assert.equal(await second.started, null);
  await waitUntil(() => host.runs[chatId] === undefined);
});

test("a Link chat (no worktrees in its state) switches providers and its brief gets the workspace and members", async (t) => {
  const members = [{ alias: "api", worktreePath: "/work/api" }];
  const briefs = [];
  const link = {
    ...projectState(ALPHA),
    worktrees: undefined,
    sessions: {
      3: { id: 3, agent_name: "Link", status: "Created", provider: "claude", workspacePath: "/link/ws", worktrees: members, native_session_id: "claude-1" },
    },
    next_id: 7,
    messages: [
      { id: 4, session_id: 3, role: "user", body: "go", model: "claude-opus-5-5", context: null },
      { id: 5, session_id: 3, role: "assistant", body: "Done.", outcome: "completed", model: "claude-opus-5-5", context: null },
    ],
  };
  delete link.worktrees;
  const { host, manager, created } = harness({
    read: async () => link,
    handoverTools: { writeTranscript: async () => "/tmp/t.md", brief: async (input) => (briefs.push(input), "BRIEF") },
  });
  t.after(() => manager.closeAll());
  const { started } = await host.send(message(ALPHA, "continue", { sessionId: 3, provider: "codex", model: "gpt-6" }));
  assert.notEqual(await started, null);
  assert.equal(created.find((item) => item.provider === "codex").options.cwd, "/link/ws");
  assert.deepEqual({ cwd: briefs[0].cwd, worktrees: briefs[0].worktrees }, { cwd: "/link/ws", worktrees: members });
  assert.match(briefs[0].transcript, /Worktree: \/link\/ws/);
});

test("Stop aborts the brief model call", async (t) => {
  let signal;
  const { host, manager, saved, session } = harness({
    handoverTools: { writeTranscript: async () => "/tmp/t.md", brief: (input) => ((signal = input.signal), new Promise(() => {})) },
  });
  t.after(() => manager.closeAll());
  const sessionId = await chatWithReply(host, session, saved);
  await host.send(message(ALPHA, "switch", { sessionId, provider: "codex", model: "gpt-6" }));
  await waitUntil(() => signal);
  await host.cancelHandoff(`${ALPHA}#${sessionId}`);
  assert.equal(signal.aborted, true);
});

test("two quick sends on the other provider produce one divider", async (t) => {
  const { host, manager, saved, session } = harness();
  t.after(() => manager.closeAll());
  const sessionId = await chatWithReply(host, session, saved);
  await Promise.all([
    host.send(message(ALPHA, "one", { sessionId, provider: "codex", model: "gpt-6" })),
    host.send(message(ALPHA, "two", { sessionId, provider: "codex", model: "gpt-6" })),
  ]);
  await host.states.flush();
  assert.equal(dividers(saved.get(ALPHA), sessionId).length, 1);
  assert.equal(saved.get(ALPHA).sessions[sessionId].provider, "codex");
});

test("a cancelled handoff did not happen: the chat is back on its provider and a resend redoes it", async (t) => {
  let release;
  let calls = 0;
  const { host, manager, saved, session, created } = harness({
    handoverTools: {
      writeTranscript: async () => "/tmp/t.md",
      brief: () => (calls++ ? Promise.resolve("AGAIN") : new Promise((resolve) => (release = resolve))),
    },
  });
  t.after(() => manager.closeAll());
  const sessionId = await chatWithReply(host, session, saved);
  await host.send(message(ALPHA, "switch", { sessionId, provider: "codex", model: "gpt-6" }));
  await waitUntil(() => release);
  await host.cancelHandoff(`${ALPHA}#${sessionId}`);
  release("LATE");
  await host.states.flush();
  // A Delegation delivered next reads the chat's last turn: it must not redo the switch.
  assert.equal(host.turns.get(`${ALPHA}#${sessionId}`).provider, "claude");
  assert.equal(host.turns.get(`${ALPHA}#${sessionId}`).model, "claude-opus-5-5");
  const reverted = saved.get(ALPHA).sessions[sessionId];
  assert.deepEqual(
    { provider: reverted.provider, current: reverted.native_session_id, parked: reverted.native_sessions },
    { provider: "claude", current: "claude-1", parked: undefined },
  );
  assert.equal(lastTurnProvider(saved.get(ALPHA), sessionId), "claude");

  await host.send(message(ALPHA, "switch again", { sessionId, provider: "codex", model: "gpt-6" }));
  await waitUntil(() => created.find((item) => item.provider === "codex")?.turns.length);
  await host.states.flush();
  assert.deepEqual(
    dividers(saved.get(ALPHA), sessionId).map(({ status }) => status),
    ["failed", "done"],
  );
  assert.equal(created.find((item) => item.provider === "codex").turns[0].prompt, `${framed("AGAIN")}\n\nswitch again`);
  assert.deepEqual(saved.get(ALPHA).sessions[sessionId].native_sessions, { claude: "claude-1" });
});

test("a quit while a handoff prepares aborts it, reverts the chat, fails the divider and saves no resume", async (t) => {
  let release;
  const { host, manager, saved, session, created } = harness({
    handoverTools: { writeTranscript: async () => "/tmp/t.md", brief: () => new Promise((resolve) => (release = resolve)) },
  });
  t.after(() => manager.closeAll());
  const sessionId = await chatWithReply(host, session, saved);
  await host.send(message(ALPHA, "switch", { sessionId, provider: "codex", model: "gpt-6" }));
  await waitUntil(() => release);
  await host.suspendRunning();
  release("LATE");
  await new Promise((resolve) => setTimeout(resolve, 50));
  await host.states.flush();
  const chat = saved.get(ALPHA).sessions[sessionId];
  assert.equal(chat.resumeTurn, undefined);
  assert.deepEqual({ provider: chat.provider, current: chat.native_session_id }, { provider: "claude", current: "claude-1" });
  assert.deepEqual(
    dividers(saved.get(ALPHA), sessionId).map(({ status }) => status),
    ["failed"],
  );
  assert.equal(
    created.some((item) => item.provider === "codex"),
    false,
  );
});

test("a divider left preparing by a quit is marked failed on the next open", async (t) => {
  const { host, manager, states, saved } = harness();
  t.after(() => manager.closeAll());
  await states.update(ALPHA, (state) => ({
    ...state,
    next_id: 9,
    sessions: { 7: { id: 7, worktree_id: 1, agent_name: "main", status: "Created", provider: "codex", native_sessions: { claude: "claude-1" } } },
    messages: [
      {
        id: 8,
        session_id: 7,
        role: "assistant",
        body: "",
        context: { kind: "handoff", from: { provider: "claude" }, to: { provider: "codex" }, status: "preparing" },
      },
    ],
  }));
  await host.states.flush();
  await host.recoverHandoffs(ALPHA, saved.get(ALPHA));
  await host.states.flush();
  assert.deepEqual(
    dividers(saved.get(ALPHA), 7).map(({ status }) => status),
    ["failed"],
  );
  assert.equal(saved.get(ALPHA).sessions[7].provider, "claude");
  assert.equal(saved.get(ALPHA).sessions[7].native_session_id, "claude-1");
});

test("an abort that lands while the divider is marked done reverts the handoff and starts no agent", async (t) => {
  const { host, manager, saved, session, created } = harness({
    handoverTools: { writeTranscript: async () => "/tmp/t.md", brief: async () => "BRIEF" },
  });
  t.after(() => manager.closeAll());
  const sessionId = await chatWithReply(host, session, saved);
  const update = host.updateDivider.bind(host);
  // The abort arrives once the divider is done, before the brief is handed on.
  host.updateDivider = async (...args) => {
    await update(...args);
    if (args[2].status === "done") host.preparing.get(`${ALPHA}#${sessionId}`).controller.abort();
  };
  await host.send(message(ALPHA, "switch", { sessionId, provider: "codex", model: "gpt-6" }));
  await waitUntil(() => saved.get(ALPHA).messages.some((item) => item.context?.status === "failed"));
  await host.states.flush();
  assert.equal(saved.get(ALPHA).sessions[sessionId].provider, "claude");
  assert.deepEqual(
    dividers(saved.get(ALPHA), sessionId).map(({ status }) => status),
    ["failed"],
  );
  assert.equal(
    created.some((item) => item.provider === "codex"),
    false,
  );
});

test("a legacy handover draft is still sent with the chat's first message", async (t) => {
  const { host, manager, states, saved, session } = harness();
  t.after(() => manager.closeAll());
  await states.update(ALPHA, (state) => ({
    ...state,
    next_id: 9,
    sessions: { 7: { id: 7, worktree_id: 1, agent_name: "main", status: "Created", provider: "claude", handedOverFrom: 3, handoverDraft: "BRIEF" } },
  }));
  await host.send(message(ALPHA, "go", { sessionId: 7 }));
  await waitUntil(() => session(ALPHA)?.turns.length);
  await host.states.flush();
  assert.equal(session(ALPHA).turns[0].prompt, `${framed("BRIEF")}\n\ngo`);
  assert.equal(saved.get(ALPHA).sessions[7].handoverDraft, undefined);
});

test("a quit saves each running chat to resume and preserves its partial reply", async (t) => {
  const { host, manager, saved, session } = harness();
  t.after(() => manager.closeAll());
  const running = await host.send(message(ALPHA, "fix the api", { effort: "high" }));
  const idle = await host.send(message(BETA, "wire the frontend"));
  await waitUntil(() => session(ALPHA) && session(BETA));
  session(ALPHA).emit({ type: "session-started", nativeId: "native-1" });
  session(ALPHA).emit({ type: "turn-started", turnId: "t1" });
  session(ALPHA).emit({ type: "text-delta", messageId: "m1", text: "Halfway." });
  session(BETA).emit({ type: "turn-started", turnId: "t1" });
  session(BETA).emit({ type: "turn-completed" });
  await waitUntil(() => saved.get(BETA)?.messages.length === 2 && saved.get(ALPHA)?.sessions[running.sessionId].native_session_id);

  await host.suspendRunning();
  await host.states.flush();
  session(ALPHA).emit({ type: "turn-cancelled" });
  await waitUntil(() => saved.get(ALPHA).messages.length === 2);

  const alpha = saved.get(ALPHA);
  // The provider session holds the prompt, so only the turn's options are kept.
  assert.deepEqual(alpha.sessions[running.sessionId].resumeTurn, {
    provider: "claude",
    model: "claude-opus-5-5",
    permissionMode: "auto",
    effort: "high",
    stoppedAt: NOW,
    ultracode: undefined,
    fastMode: undefined,
    replies: undefined,
    tldrEnabled: undefined,
  });
  assert.deepEqual(chatMessages(alpha, running.sessionId).at(-1), {
    role: "assistant",
    body: "Halfway.",
    outcome: "cancelled",
  });
  assert.equal(saved.get(BETA).sessions[idle.sessionId].resumeTurn, undefined);
});

test("suspending two Chats in one Project preserves the earlier session snapshot", async (t) => {
  const { host, manager, states, created } = harness();
  t.after(() => manager.closeAll());
  const first = await host.send(message(ALPHA, "first turn"));
  const second = await host.send(message(ALPHA, "second turn"));
  await waitUntil(() => created.length === 2 && created.every((item) => item.turns.length));
  await states.flush();
  const before = await states.get(ALPHA);
  await host.suspendRunning();
  const after = await states.get(ALPHA);
  assert.equal(before.sessions[first.sessionId].resumeTurn, undefined);
  assert.equal(before.sessions[second.sessionId].resumeTurn, undefined);
  assert.notEqual(after.sessions, before.sessions);
  assert.equal(after.sessions[first.sessionId].resumeTurn.prompt, "first turn");
  assert.equal(after.sessions[second.sessionId].resumeTurn.prompt, "second turn");
});

test("recovering multiple legacy handoffs preserves old and untouched sessions", async (t) => {
  const { host, manager, states } = harness();
  t.after(() => manager.closeAll());
  await states.update(ALPHA, (state) => ({
    ...state,
    sessions: {
      7: { id: 7, worktree_id: 1, provider: "claude", handoverPending: true },
      8: { id: 8, worktree_id: 1, provider: "codex", handoverPending: true },
      9: { id: 9, worktree_id: 1, provider: "claude" },
    },
  }));
  const before = await states.get(ALPHA);
  await host.recoverHandoffs(ALPHA, before);
  const after = await states.get(ALPHA);
  assert.equal(before.sessions[7].handoverPending, true);
  assert.equal(before.sessions[8].handoverPending, true);
  assert.equal("handoverPending" in after.sessions[7], false);
  assert.equal("handoverPending" in after.sessions[8], false);
  assert.equal(after.sessions[9], before.sessions[9]);
  await host.recoverHandoffs(ALPHA, after);
  assert.equal(await states.get(ALPHA), after, "recovery without changes keeps the snapshot");
});

test("a quit saves no resume for a Routine's turn, which the scheduler owns; a user's turn still resumes", async (t) => {
  const { host, manager, saved, session } = harness();
  t.after(() => manager.closeAll());
  const context = { kind: "routine-run", routineId: "r1", runId: "run-1", name: "Babysit", at: NOW };
  const beat = await host.send(message(ALPHA, "Check CI", { context }));
  const user = await host.send(message(BETA, "fix the api"));
  await waitUntil(() => session(ALPHA) && session(BETA));
  for (const cwd of [ALPHA, BETA]) session(cwd).emit({ type: "turn-started", turnId: "t1" });
  await host.suspendRunning();
  await host.states.flush();
  assert.equal(saved.get(ALPHA).sessions[beat.sessionId].resumeTurn, undefined);
  assert.equal(saved.get(BETA).sessions[user.sessionId].resumeTurn.prompt, "fix the api");
});

test("a babysit Run's turn carries its level as a guard to the agent; other turns and the turn settings don't", async (t) => {
  const { host, manager, session } = harness();
  t.after(() => manager.closeAll());
  const babysit = { level: 2, resolveThreads: false, offBranch: true };
  const context = { kind: "routine-run", routineId: "r1", runId: "run-1", name: "Babysit PR #4", at: NOW, label: "PR #4", babysit };
  const run = await host.send(message(ALPHA, "PR #4 changed", { permissionMode: "full", context }));
  await waitUntil(() => session(ALPHA)?.turns.length === 1);
  assert.deepEqual(session(ALPHA).turns[0].guard, { level: 2, resolveThreads: false });
  const chatId = `${ALPHA}#${run.sessionId}`;
  // Settings read for the Chat's next message (a Delegation, a beat) never pass the guard on.
  assert.equal("guard" in host.turnSettings(chatId), false);
  session(ALPHA).emit({ type: "turn-started", turnId: "t1" });
  session(ALPHA).emit({ type: "turn-completed" });
  await waitUntil(() => !host.runs[chatId]);
  // A heartbeat's beat and a user's message are not guarded.
  await host.send(
    message(ALPHA, "Check CI", { sessionId: run.sessionId, context: { kind: "routine-run", routineId: "r2", runId: "run-2", name: "CI", at: NOW } }),
  );
  await waitUntil(() => session(ALPHA).turns.length === 2);
  assert.equal(session(ALPHA).turns[1].guard, undefined);
});

test("a Run's new Chat starts hidden, with the Routine's name as a generated title that a user's name beats", async (t) => {
  const { host, manager, states, saved, broadcasts } = harness();
  t.after(() => manager.closeAll());
  const origin = { routineId: "r1", runId: "run-1" };
  const sessionId = await host.emptyChat(ALPHA, 1, { origin, generatedTitle: "Morning triage", fresh: true });
  await host.states.flush();
  const session = saved.get(ALPHA).sessions[sessionId];
  assert.deepEqual(session.routine, { routineId: "r1", runId: "run-1", hidden: true });
  assert.equal(session.generatedTitle, "Morning triage");
  assert.equal(session.title, undefined);
  assert.equal(broadcasts.at(-1).state.sessions[sessionId].routine.hidden, true);
  // A Linear Run names the Chat itself, and it is hidden all the same.
  const linear = await host.emptyChat(ALPHA, 1, { origin: { routineId: "r1", runId: "run-2" }, title: "MIL-1 Paste images", fresh: true });
  assert.deepEqual((await states.get(ALPHA)).sessions[linear].routine, { routineId: "r1", runId: "run-2", hidden: true });
  assert.equal((await states.get(ALPHA)).sessions[linear].title, "MIL-1 Paste images");
  // A Chat made for no Run carries no routine at all.
  const plain = await host.emptyChat(ALPHA, 1, { fresh: true });
  assert.equal((await states.get(ALPHA)).sessions[plain].routine, undefined);
});

test("nameRunChat saves a Run's title on its own Chat only, and never over a name the user gave it", async (t) => {
  const { host, manager, states, broadcasts } = harness();
  t.after(() => manager.closeAll());
  const sessionId = await host.emptyChat(ALPHA, 1, { origin: { routineId: "r1", runId: "run-1" }, generatedTitle: "Morning triage", fresh: true });
  const before = broadcasts.length;
  // Another Run's title, or a Chat that isn't there, changes nothing.
  assert.equal(await host.nameRunChat(ALPHA, sessionId, "run-9", "Wrong Run"), false);
  assert.equal(await host.nameRunChat(ALPHA, 999, "run-1", "No such Chat"), false);
  assert.equal((await states.get(ALPHA)).sessions[sessionId].generatedTitle, "Morning triage");
  assert.equal(broadcasts.length, before);

  const update = t.mock.method(states, "update");
  assert.equal(await host.nameRunChat(ALPHA, sessionId, "run-1", "Fixed flaky sidebar test"), true);
  // The name is on the session: none of the Chat's messages are loaded for it.
  assert.deepEqual(
    update.mock.calls.map((call) => call.arguments[2]),
    [{ chats: [] }],
  );
  update.mock.restore();
  const named = (await states.get(ALPHA)).sessions[sessionId];
  assert.equal(named.generatedTitle, "Fixed flaky sidebar test");
  assert.deepEqual(named.routine, { routineId: "r1", runId: "run-1", hidden: true });
  assert.equal(broadcasts.at(-1).state.sessions[sessionId].generatedTitle, "Fixed flaky sidebar test");

  await states.update(ALPHA, (state) => ({ ...state, sessions: { ...state.sessions, [sessionId]: { ...state.sessions[sessionId], title: "My name" } } }));
  assert.equal(await host.nameRunChat(ALPHA, sessionId, "run-1", "Too late"), false);
  const kept = (await states.get(ALPHA)).sessions[sessionId];
  assert.equal(kept.title, "My name");
  assert.equal(kept.generatedTitle, "Fixed flaky sidebar test");
});

test("a Linear Run's first message, the issue card carrying its Routine, is a Routine's turn too: no resume, no saved mode", async (t) => {
  const { host, manager, saved, session } = harness();
  t.after(() => manager.closeAll());
  const context = {
    kind: "linear-issue",
    key: "MIL-1",
    title: "Paste",
    url: "u",
    state: { name: "Todo", type: "unstarted", color: "#aaa" },
    routine: { routineId: "r1", runId: "run-1", name: "Triage", at: NOW },
  };
  const run = await host.send(message(ALPHA, "Look at MIL-1", { context, permissionMode: "full" }));
  await waitUntil(() => session(ALPHA));
  session(ALPHA).emit({ type: "turn-started", turnId: "t1" });
  await host.suspendRunning();
  await host.states.flush();
  assert.equal(saved.get(ALPHA).sessions[run.sessionId].resumeTurn, undefined);
  assert.equal(saved.get(ALPHA).sessions[run.sessionId].permissionMode, undefined);
});

test("the Chat keeps the mode its composer last set, saved with it: a pick, or the mode a person's message carried", async (t) => {
  const { host, manager, saved, session } = harness();
  t.after(() => manager.closeAll());
  const chat = await host.send(message(ALPHA, "fix the api", { permissionMode: "full" }));
  const chatId = `${ALPHA}#${chat.sessionId}`;
  await waitUntil(() => session(ALPHA));
  await host.states.flush();
  assert.equal(saved.get(ALPHA).sessions[chat.sessionId].permissionMode, "full");

  await host.notePermissionMode(chatId, "ask");
  await host.states.flush();
  assert.equal(saved.get(ALPHA).sessions[chat.sessionId].permissionMode, "ask");
  // The turn a quit stops starts again in the mode the Chat has now.
  assert.equal(host.turnSettings(chatId).permissionMode, "ask");
  await assert.rejects(host.notePermissionMode(chatId, "yolo"), /Unknown permission mode/);
  // A Chat that isn't there changes nothing.
  await host.notePermissionMode(`${ALPHA}#999`, "ask");
  assert.equal(saved.get(ALPHA).sessions[999], undefined);

  // A Routine's message isn't the composer's: it leaves the saved mode alone.
  session(ALPHA).emit({ type: "turn-started", turnId: "t1" });
  session(ALPHA).emit({ type: "turn-completed" });
  await waitUntil(() => !host.runs[chatId]);
  const context = { kind: "routine-run", routineId: "r1", runId: "run-1", name: "Babysit", at: NOW };
  await host.send(message(ALPHA, "Check CI", { sessionId: chat.sessionId, permissionMode: "full", context }));
  await host.states.flush();
  assert.equal(saved.get(ALPHA).sessions[chat.sessionId].permissionMode, "ask");
  // A deleted Chat leaves nothing of its Routine turn behind.
  assert.equal(host.routineTurns.has(chatId), true);
  host.forget(chatId);
  assert.equal(host.routineTurns.has(chatId), false);
});

test("leaving Bot rules saves Ask for everything the Chat starts again: its mode, its stopped turn, its queue", async (t) => {
  const { host, manager, states, saved } = harness();
  t.after(() => manager.closeAll());
  const resumeTurn = { provider: "claude", model: "m", permissionMode: "bot", stoppedAt: NOW };
  const queued = [
    { id: "q1", body: "steer", provider: "claude", model: "m", queuedAt: NOW, turn: { permissionMode: "bot" } },
    { id: "q2", body: "older", provider: "claude", model: "m", queuedAt: NOW },
  ];
  await states.update(ALPHA, (state) => ({
    ...state,
    next_id: 9,
    sessions: {
      7: { id: 7, worktree_id: 1, provider: "claude", permissionMode: "bot", resumeTurn, queued, queueHeld: true },
      8: { id: 8, worktree_id: 1, provider: "claude", permissionMode: "auto", resumeTurn: { ...resumeTurn, permissionMode: "auto" } },
    },
  }));
  await host.leaveBotRules(`${ALPHA}#7`);
  await host.leaveBotRules(`${ALPHA}#8`);
  await host.states.flush();
  const left = saved.get(ALPHA).sessions;
  assert.equal(left[7].permissionMode, "ask");
  assert.deepEqual(left[7].resumeTurn, { ...resumeTurn, permissionMode: "ask" });
  assert.deepEqual(left[7].queued, [{ ...queued[0], turn: { permissionMode: "ask" } }, queued[1]]);
  // A Chat in another mode keeps it.
  assert.equal(left[8].permissionMode, "auto");
  assert.equal(left[8].resumeTurn.permissionMode, "auto");
});

test("a mode change saves the mode whatever the live agent says, and reports the agent's error first", async (t) => {
  const { host, manager } = harness();
  t.after(() => manager.closeAll());
  const failing = async () => {
    throw new Error("agent refused");
  };
  const noted = [];
  host.notePermissionMode = async (chatId, mode) => {
    noted.push([chatId, mode]);
    throw new Error("save failed");
  };
  await assert.rejects(host.setPermissionMode(`${ALPHA}#1`, "ask", failing), /agent refused/);
  assert.deepEqual(noted, [[`${ALPHA}#1`, "ask"]]);
  await assert.rejects(
    host.setPermissionMode(`${ALPHA}#1`, "ask", async () => {}),
    /save failed/,
  );
});

test("a chat a quit stopped continues once on its saved session when its project opens", async (t) => {
  const { host, manager, states, saved, session } = harness();
  t.after(() => manager.closeAll());
  await states.update(ALPHA, (state) => ({
    ...state,
    next_id: 9,
    sessions: {
      7: {
        id: 7,
        worktree_id: 1,
        agent_name: "main",
        status: "Created",
        provider: "codex",
        native_session_id: "thread-1",
        resumeTurn: { provider: "codex", model: "gpt-6", permissionMode: "auto", effort: "high", stoppedAt: NOW - 60_000 },
      },
    },
  }));
  await host.states.flush();
  const stale = saved.get(ALPHA);
  await host.resumeInterrupted(ALPHA, stale);
  await host.states.flush();
  await host.resumeInterrupted(ALPHA, stale);
  await host.states.flush();
  await waitUntil(() => session(ALPHA)?.turns.length === 1);

  const state = saved.get(ALPHA);
  assert.equal(state.sessions[7].resumeTurn, undefined);
  assert.deepEqual(chatMessages(state, 7), [{ role: "user", body: "Milagre restarted. Continue where you left off." }]);
  assert.equal(session(ALPHA).provider, "codex");
  assert.equal(session(ALPHA).options.resumeId, "thread-1");
  assert.match(session(ALPHA).turns[0].prompt, /closed while you were working/);
  assert.deepEqual([session(ALPHA).turns[0].model, session(ALPHA).turns[0].effort], ["gpt-6", "high"]);
  assert.equal(manager.sessions.size, 1);
});

test("a chat the usage limit stopped continues on the turn's options after its account changes", async (t) => {
  const { host, manager, saved, session } = harness();
  t.after(() => manager.closeAll());
  const chat = await host.send(message(ALPHA, "fix the api", { effort: "high" }));
  await waitUntil(() => session(ALPHA));
  // Nothing to continue while the turn runs.
  assert.equal(await host.continueAfterLimit(ALPHA, chat.sessionId, "claude", "me@work.com"), false);
  session(ALPHA).emit({ type: "session-started", nativeId: "native-7" });
  session(ALPHA).emit({ type: "turn-started", turnId: "t1" });
  session(ALPHA).emit({ type: "turn-failed", message: "You've hit your session limit", notice: true, limit: { provider: "claude" } });
  await waitUntil(() => saved.get(ALPHA)?.messages.length === 2);

  assert.equal(await host.continueAfterLimit(ALPHA, chat.sessionId, "claude", "me@work.com"), true);
  await host.states.flush();
  await waitUntil(() => session(ALPHA)?.turns.length === 2);
  const switched = saved.get(ALPHA).messages.at(-1);
  assert.deepEqual([switched.role, switched.body], ["user", "Switched to me@work.com after the usage limit"]);
  assert.deepEqual(switched.context, { kind: "account-switch", provider: "claude", label: "me@work.com" });
  const turn = session(ALPHA).turns[1];
  assert.match(turn.prompt, /usage limit/);
  assert.equal(turn.effort, "high");
  // A chat Milagre knows no turn of (it restarted since) waits for the user.
  assert.equal(await host.continueAfterLimit(BETA, 1, "claude", "me@work.com"), false);
});

test("a babysit Run continued after a usage limit keeps its guard", async (t) => {
  const { host, manager, saved, session } = harness();
  t.after(() => manager.closeAll());
  const babysit = { level: 1, resolveThreads: false };
  const context = { kind: "routine-run", routineId: "r1", runId: "run-1", name: "Babysit PR #4", at: NOW, label: "PR #4", babysit };
  const run = await host.send(message(ALPHA, "PR #4 changed", { context }));
  await waitUntil(() => session(ALPHA));
  session(ALPHA).emit({ type: "session-started", nativeId: "native-7" });
  session(ALPHA).emit({ type: "turn-started", turnId: "t1" });
  session(ALPHA).emit({ type: "turn-failed", message: "You've hit your session limit", notice: true, limit: { provider: "claude" } });
  await waitUntil(() => saved.get(ALPHA)?.messages.length === 2);
  assert.equal(await host.continueAfterLimit(ALPHA, run.sessionId, "claude", "me@work.com"), true);
  await waitUntil(() => session(ALPHA)?.turns.length === 2);
  // The continued turn is still the Run: its level stays enforced.
  assert.deepEqual(session(ALPHA).turns[1].guard, { level: 1, resolveThreads: false });
});

test("a chat whose agent hadn't started when Milagre quit is sent its prompt again", async (t) => {
  const { host, manager, saved, session } = harness();
  t.after(() => manager.closeAll());
  const chat = await host.send(message(ALPHA, "fix the api"));
  await waitUntil(() => session(ALPHA));
  session(ALPHA).emit({ type: "turn-started", turnId: "t1" });
  await host.suspendRunning();
  await host.states.flush();
  assert.equal(saved.get(ALPHA).sessions[chat.sessionId].resumeTurn.prompt, "fix the api");
});

test("a chat stopped more than a day ago waits for Continue, and a message sent by hand drops the mark", async (t) => {
  const { host, manager, states, saved, session } = harness();
  t.after(() => manager.closeAll());
  const old = { provider: "codex", model: "gpt-6", permissionMode: "auto", stoppedAt: NOW - 2 * DAY };
  await states.update(ALPHA, (state) => ({
    ...state,
    next_id: 9,
    sessions: {
      7: { id: 7, worktree_id: 1, agent_name: "main", status: "Created", provider: "codex", native_session_id: "thread-1", resumeTurn: old },
      8: { id: 8, worktree_id: 1, agent_name: "main", status: "Created", provider: "codex", native_session_id: "thread-2", resumeTurn: old },
    },
  }));
  await host.states.flush();
  await host.resumeInterrupted(ALPHA, saved.get(ALPHA));
  await host.states.flush();
  assert.deepEqual(chatMessages(saved.get(ALPHA), 7), []);
  assert.equal(saved.get(ALPHA).sessions[7].resumeTurn.stoppedAt, NOW - 2 * DAY);

  // Continue resumes it once; a second click has nothing left to continue.
  assert.equal(await host.resumeChat(ALPHA, 7), true);
  await host.states.flush();
  assert.equal(await host.resumeChat(ALPHA, 7), false);
  await host.states.flush();
  await waitUntil(() => session(ALPHA)?.turns.length === 1);
  assert.match(session(ALPHA).turns[0].prompt, /closed while you were working/);
  assert.equal(saved.get(ALPHA).sessions[7].resumeTurn, undefined);

  // The user's own message replaces the resume.
  await host.send(message(ALPHA, "never mind, do this instead", { sessionId: 8, provider: "codex", model: "gpt-6" }));
  assert.equal(saved.get(ALPHA).sessions[8].resumeTurn, undefined);
  assert.deepEqual(chatMessages(saved.get(ALPHA), 8), [{ role: "user", body: "never mind, do this instead" }]);
});

test("streaming child updates publish only the child, never save, and late readers see the transcript", async (t) => {
  const { host, manager, states, saved, published } = harness();
  t.after(() => manager.closeAll());
  const sent = await host.send(message(ALPHA, "review"));
  await states.flush();
  const before = saved.get(ALPHA);
  const chatId = `${ALPHA}#${sent.sessionId}`;
  const child = {
    id: "child",
    title: "Review",
    status: "running",
    startedAt: 1,
    updatedAt: 2,
    transcript: [{ id: "one", kind: "message", text: "Working on it" }],
  };
  await host.receive(chatId, { type: "subagent-update", agent: child });
  await states.flush();
  await host.states.flush();
  assert.equal(saved.get(ALPHA), before, "child streaming must not schedule a save");
  assert.equal(published.at(-1).state, undefined);
  assert.equal(published.at(-1).event.agent.transcript[0].text, "Working on it");
  assert.equal((await states.get(ALPHA)).sessions[sent.sessionId].subagents[0].transcript[0].text, "Working on it");
  await host.receive(chatId, { type: "turn-completed" });
  await states.flush();
  await host.states.flush();
  assert.equal(saved.get(ALPHA).sessions[sent.sessionId].subagents[0].transcript[0].text, "Working on it");
});

test("subagents that finished are archived when the turn ends, and ones still running stay", async (t) => {
  const { host, manager, states, saved } = harness();
  t.after(() => manager.closeAll());
  const sent = await host.send(message(ALPHA, "review"));
  const chatId = `${ALPHA}#${sent.sessionId}`;
  const child = (id, status) => ({ id, title: id, status, startedAt: 1, updatedAt: 2, transcript: [] });
  await host.receive(chatId, { type: "subagent-update", agent: child("done", "completed") });
  await host.receive(chatId, { type: "subagent-update", agent: child("broke", "failed") });
  await host.receive(chatId, { type: "subagent-update", agent: child("busy", "running") });
  assert.ok((await states.get(ALPHA)).sessions[sent.sessionId].subagents.every((agent) => !agent.archived));
  await host.receive(chatId, { type: "turn-completed" });
  await states.flush();
  const archived = Object.fromEntries(saved.get(ALPHA).sessions[sent.sessionId].subagents.map((agent) => [agent.id, Boolean(agent.archived)]));
  assert.deepEqual(archived, { done: true, broke: true, busy: false });
});

test("sending an image stores its bytes before the provider starts and keeps original provider input", async (t) => {
  const fs = require("node:fs/promises");
  const path = require("node:path");
  const os = require("node:os");
  const { saveProjectState, readProjectState } = require("../project-store.cjs");
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-chat-image-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const image = {
    id: "png",
    name: "photo.png",
    dataUrl: "data:image/png;base64," + (await fs.readFile(path.join(__dirname, "../../../../scripts/fixtures/photo.png"))).toString("base64"),
  };
  let started;
  const began = new Promise((resolve) => (started = resolve));
  const states = new ProjectStates({ read: async () => projectState(root), save: saveProjectState });
  t.after(() => states.close());
  const host = new ChatHost({
    states,
    startTurn: async (request) => {
      started(request);
      return { turnId: "one" };
    },
    publish: () => {},
    broadcast: () => {},
  });
  await host.send(message(root, "Describe it", { images: [image] }));
  const request = await began;
  const saved = await readProjectState(root);
  const stored = saved.messages[0].images[0];
  assert.equal(stored.dataUrl, undefined);
  assert.equal(path.dirname(stored.path), path.join(root, ".milagre", "images"));
  assert.ok((await fs.stat(stored.path)).size > 0);
  assert.deepEqual(request.images, [image]);
});

function durableHarness() {
  let fail = false,
    blocked = null;
  const saved = [];
  const published = [];
  const started = [];
  const states = new ProjectStates({
    read: async (p) => projectState(p),
    save: async (_p, state) => {
      if (blocked) await blocked;
      if (fail) throw new Error("disk full");
      saved.push(state);
    },
  });
  const host = new ChatHost({
    states,
    startTurn: async (r) => {
      started.push(r);
    },
    publish: (chatId, event, state, seq) => published.push({ chatId, event, state, seq }),
    broadcast: (path, state) => published.push({ path, state }),
  });
  return { host, states, saved, published, started, fail: (value) => (fail = value), block: (value) => (blocked = value) };
}

test("a slow send does not publish old state after a concurrent turn finishes", async () => {
  const h = durableHarness();
  const first = await h.host.send(message(ALPHA, "First"));
  const chatId = ALPHA + "#" + first.sessionId;
  await h.host.receive(chatId, { type: "turn-started", turnId: "t" });
  await h.host.receive(chatId, { type: "text-delta", text: "First reply" });
  let release;
  h.block(new Promise((resolve) => (release = resolve)));
  const send = h.host.send(message(ALPHA, "Follow-up", { sessionId: first.sessionId }));
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await h.host.receive(chatId, { type: "text-delta", text: " complete." });
  await h.host.receive(chatId, { type: "turn-completed" });
  h.block(null);
  release();
  await send;
  const seq = h.published.filter((x) => x.seq !== undefined).map((x) => x.seq);
  assert.deepEqual(
    seq,
    [...seq].sort((a, b) => a - b),
  );
  const latest = h.published.findLast((x) => x.state).state;
  assert.ok(latest.messages.some((m) => m.body === "First reply complete."));
  assert.equal(h.started.length, 2);
  await h.states.close();
});

test("a rejected send removes its undelivered message and never leaves a phantom run", async () => {
  const h = durableHarness();
  h.fail(true);
  await assert.rejects(h.host.send(message(ALPHA, "Retry me")), /disk full/);
  assert.deepEqual(h.host.runs, {});
  assert.deepEqual((await h.states.get(ALPHA)).messages, []);
  assert.equal(h.started.length, 0);
  h.fail(false);
  await h.host.send(message(ALPHA, "Retry me"));
  assert.equal((await h.states.get(ALPHA)).messages.length, 1);
  assert.equal(h.started.length, 1);
  await h.states.close();
});

test("answers show and resolve before their save, which a failure leaves dirty to try again", async () => {
  const h = durableHarness();
  const { sessionId } = await h.host.send(message(ALPHA, "Ask me"));
  const chatId = ALPHA + "#" + sessionId;
  await h.host.receive(chatId, { type: "text-delta", text: "Question" });
  await h.host.receive(chatId, {
    type: "question-request",
    requestId: "q",
    questions: [{ id: "a", header: "Key", question: "Which key?", options: [], multiSelect: false, allowOther: true, secret: true }],
  });
  let release;
  h.block(new Promise((resolve) => (release = resolve)));
  h.fail(true);
  const messageId = await h.host.recordAnswers(chatId, "••••••", { requestId: "q", answers: { a: ["hunter2"] } });
  const shown = (await h.states.get(ALPHA)).messages.find((item) => item.id === messageId);
  assert.deepEqual(shown.answered, [{ header: "Key", question: "Which key?", answers: ["••••••"] }]);
  assert.equal(h.host.runs[chatId].text, "");
  h.block(null);
  release();
  h.fail(false);
  await h.states.flush();
  assert.ok((await h.states.get(ALPHA)).messages.some((item) => item.id === messageId));
  await h.states.close();
});

test("a completed assistant reply captures its local screenshot before the temporary file disappears", async (t) => {
  const fs = require("node:fs/promises"),
    path = require("node:path"),
    os = require("node:os");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-reply-image-"));
  const project = path.join(root, "repo");
  await fs.mkdir(project);
  const file = path.join(root, "shot.png");
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("screenshot")]);
  await fs.writeFile(file, png);
  const h = harness();
  t.after(async () => {
    await h.manager.closeAll();
    await h.states.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const { sessionId } = await h.host.send(message(project, "Show the screenshot"));
  const chatId = `${project}#${sessionId}`;
  await h.host.receive(chatId, { type: "text-delta", text: `![Screenshot](${file})` });
  await h.host.receive(chatId, { type: "turn-completed" });
  const reply = (await h.states.get(project)).messages.find((message) => message.role === "assistant");
  assert.equal(reply.images[0].sourcePath, file);
  await fs.unlink(file);
  assert.deepEqual(await fs.readFile(reply.images[0].path), png);
  assert.ok(h.broadcasts.some((item) => item.state.messages.some((message) => message.images?.[0]?.sourcePath === file)));
});

for (const split of ["steering", "answers"])
  test(`a ${split} split preserves the assistant screenshot before its source disappears`, async (t) => {
    const fs = require("node:fs/promises"),
      path = require("node:path"),
      os = require("node:os");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-split-image-"));
    const project = path.join(root, "repo");
    await fs.mkdir(project);
    const file = path.join(root, "shot.png");
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("screenshot")]);
    await fs.writeFile(file, png);
    const h = harness();
    t.after(async () => {
      await h.manager.closeAll();
      await h.states.close();
      await fs.rm(root, { recursive: true, force: true });
    });
    const { sessionId } = await h.host.send(message(project, "Show the screenshot"));
    const chatId = `${project}#${sessionId}`;
    await h.host.receive(chatId, { type: "text-delta", text: `![Screenshot](${file})` });
    if (split === "steering") await h.host.send(message(project, "Continue", { sessionId }));
    else await h.host.recordAnswers(chatId, "Keep this layout");
    await h.host.receive(chatId, { type: "turn-completed" });
    const reply = (await h.states.get(project)).messages.find((message) => message.role === "assistant");
    assert.equal(reply.images?.[0]?.sourcePath, file);
    await fs.unlink(file);
    assert.deepEqual(await fs.readFile(reply.images[0].path), png);
    assert.equal(await h.host.images.resolve(project, file), reply.images[0].path);
  });

test("saved input carries its client correlation id so previews reconcile before the send response", async (t) => {
  const { host, manager, saved, published } = harness();
  t.after(() => manager.closeAll());
  const sent = await host.send(message(ALPHA, "Hello", { clientMessageId: "phone-first-message" }));
  assert.equal(saved.get(ALPHA).messages[0].clientMessageId, "phone-first-message");
  assert.equal(published.find((item) => item.event.type === "message-sent").state.messages[0].clientMessageId, "phone-first-message");
  assert.equal(saved.get(ALPHA).messages[0].session_id, sent.sessionId);
});

test("a send repeating a saved clientMessageId answers with that message's chat and runs nothing", async (t) => {
  const { host, manager, states, saved, created, published } = harness();
  t.after(() => manager.closeAll());
  const first = await host.send(message(ALPHA, "Hello", { clientMessageId: "lost-ack" }));
  await first.started;
  const turns = created.flatMap((item) => item.turns).length;
  const events = published.length;
  const saves = saved.get(ALPHA).messages.length;
  // The phone never saw the answer, restored its draft and sent again, aimed at no Chat as before.
  const again = await host.send(message(ALPHA, "Hello", { clientMessageId: "lost-ack" }));
  assert.equal(again.sessionId, first.sessionId);
  assert.equal(again.duplicate, true);
  assert.equal(await again.started, null);
  const resent = await host.send(message(ALPHA, "Hello", { clientMessageId: "lost-ack", sessionId: first.sessionId }));
  assert.equal(resent.sessionId, first.sessionId);
  const state = await states.get(ALPHA);
  assert.equal(state.messages.filter((item) => item.clientMessageId === "lost-ack").length, 1);
  assert.equal(saved.get(ALPHA).messages.length, saves);
  assert.equal(created.flatMap((item) => item.turns).length, turns);
  assert.equal(published.length, events);
  assert.equal(Object.keys(state.sessions).length, 1);
});

test("two concurrent sends with one clientMessageId save and run it once", async (t) => {
  const { host, manager, states, created } = harness();
  t.after(() => manager.closeAll());
  const [a, b] = await Promise.all([
    host.send(message(ALPHA, "Hello", { clientMessageId: "double" })),
    host.send(message(ALPHA, "Hello", { clientMessageId: "double" })),
  ]);
  await Promise.all([a.started, b.started]);
  assert.equal(a.sessionId, b.sessionId);
  assert.equal((await states.get(ALPHA)).messages.filter((item) => item.clientMessageId === "double").length, 1);
  assert.equal(created.flatMap((item) => item.turns).length, 1);
  assert.equal([a, b].filter((item) => item.duplicate).length, 1);
});

test("a different clientMessageId, or none, is a new message", async (t) => {
  const { host, manager, states } = harness();
  t.after(() => manager.closeAll());
  const first = await host.send(message(ALPHA, "Hello", { clientMessageId: "one" }));
  await host.send(message(ALPHA, "Hello", { clientMessageId: "two", sessionId: first.sessionId }));
  await host.send(message(ALPHA, "Hello", { sessionId: first.sessionId }));
  assert.equal((await states.get(ALPHA)).messages.filter((item) => item.role === "user").length, 3);
});

// Milagre's task tools against the real host and project state, as runtime.cjs wires them.
function planHarness() {
  const h = harness();
  const tools = createChatPlanTools({ read: (chatId) => h.host.plan(chatId), update: (chatId, change) => h.host.updatePlan(chatId, change) });
  const call = (chatId, name, args) =>
    runTool(
      tools.definitions(chatId).find((tool) => tool.name === name),
      args,
    );
  return { ...h, call };
}
const nativeList = (...contents) => ({ type: "tasks-updated", tasks: contents.map((content, index) => ({ id: String(index), content, status: "pending" })) });

test("tasks_set saves the plan on the session and publishes it with the state", async (t) => {
  const { host, manager, states, saved, published, call } = planHarness();
  t.after(() => manager.closeAll());
  const { sessionId } = await host.send(message(ALPHA, "plan it"));
  const chatId = `${ALPHA}#${sessionId}`;
  const result = await call(chatId, "tasks_set", { tasks: [{ title: "Persist", children: [{ title: "Save" }] }, { title: "Verify" }] });
  assert.equal(result.isError, false);
  assert.equal(result.text, "[ ] 1 Persist\n  [ ] 1.1 Save\n[ ] 2 Verify");
  const plan = (await states.get(ALPHA)).sessions[sessionId].plan;
  assert.equal(plan.source, "milagre");
  const event = published.findLast((item) => item.event.type === "plan-updated");
  assert.equal(event.chatId, chatId);
  assert.deepEqual(event.event.plan, plan);
  assert.deepEqual(event.state.sessions[sessionId].plan, plan);
  await states.flush();
  assert.deepEqual(saved.get(ALPHA).sessions[sessionId].plan, plan);
});

test("once Milagre owns the plan a native list is ignored, and the plan survives the turn and a reload", async (t) => {
  const { host, manager, states, saved, published, call } = planHarness();
  t.after(() => manager.closeAll());
  const { sessionId } = await host.send(message(ALPHA, "plan it"));
  const chatId = `${ALPHA}#${sessionId}`;
  await host.receive(chatId, nativeList("native one"));
  assert.equal((await states.get(ALPHA)).sessions[sessionId].plan.source, "native");
  await call(chatId, "tasks_set", { tasks: [{ title: "Mine" }] });
  const owned = (await states.get(ALPHA)).sessions[sessionId].plan;
  const before = published.length;
  await host.receive(chatId, nativeList("native two"));
  assert.equal((await states.get(ALPHA)).sessions[sessionId].plan, owned);
  assert.equal(
    published.slice(before).some((item) => item.state),
    false,
    "an ignored native list publishes no state",
  );
  await host.receive(chatId, { type: "turn-completed" });
  await states.flush();
  assert.deepEqual(saved.get(ALPHA).sessions[sessionId].plan, owned);
  const reloaded = new ProjectStates({ read: async () => saved.get(ALPHA), save: async () => {} });
  t.after(() => reloaded.close());
  assert.deepEqual((await reloaded.get(ALPHA)).sessions[sessionId].plan, owned);
});

test("concurrent plan changes and a native list each see the one before", async (t) => {
  const { host, manager, states, call } = planHarness();
  t.after(() => manager.closeAll());
  const { sessionId } = await host.send(message(ALPHA, "plan it"));
  const chatId = `${ALPHA}#${sessionId}`;
  await call(chatId, "tasks_set", { tasks: [{ title: "A" }, { title: "B" }] });
  await Promise.all([call(chatId, "task_update", { id: "1", status: "completed" }), call(chatId, "task_update", { id: "2", status: "completed" })]);
  assert.deepEqual(
    (await states.get(ALPHA)).sessions[sessionId].plan.tasks.map((task) => task.status),
    ["completed", "completed"],
  );
});

test("a native list that lands just before phase_set is kept, not overwritten", async (t) => {
  const { host, manager, states, call } = planHarness();
  t.after(() => manager.closeAll());
  const { sessionId } = await host.send(message(ALPHA, "plan it"));
  const chatId = `${ALPHA}#${sessionId}`;
  await host.receive(chatId, nativeList("old"));
  const [, phase] = await Promise.all([host.receive(chatId, nativeList("new one", "new two")), call(chatId, "phase_set", { phase: "build" })]);
  assert.equal(phase.isError, false);
  const plan = (await states.get(ALPHA)).sessions[sessionId].plan;
  assert.deepEqual(
    plan.tasks.map((task) => task.title),
    ["new one", "new two"],
  );
  assert.equal(plan.phases.at(-1).phase, "build");
});

test("a task tool for a Chat that is gone returns an error and saves nothing", async (t) => {
  const { host, manager, states, saved, published, call } = planHarness();
  t.after(() => manager.closeAll());
  await host.send(message(ALPHA, "plan it"));
  await states.flush();
  const before = { saved: saved.get(ALPHA), published: published.length };
  const result = await call(`${ALPHA}#999`, "tasks_set", { tasks: [{ title: "Lost" }] });
  assert.deepEqual({ text: result.text, isError: result.isError }, { text: "This Chat no longer exists.", isError: true });
  await states.flush();
  assert.equal(saved.get(ALPHA), before.saved);
  assert.equal(published.length, before.published);
});

test("a change that throws, or a state update that fails, writes and publishes nothing", async (t) => {
  const { host, manager, states, published, call } = planHarness();
  t.after(() => manager.closeAll());
  const { sessionId } = await host.send(message(ALPHA, "plan it"));
  const chatId = `${ALPHA}#${sessionId}`;
  const unknown = await call(chatId, "task_update", { id: "9", status: "completed" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /tasks_set/);
  assert.equal((await states.get(ALPHA)).sessions[sessionId].plan, undefined);
  assert.equal(
    published.some((item) => item.event.type === "plan-updated"),
    false,
  );
  const update = host.states.update;
  host.states.update = () => Promise.reject(new Error("disk is full"));
  const failed = await call(chatId, "tasks_set", { tasks: [{ title: "A" }] });
  host.states.update = update;
  assert.deepEqual({ text: failed.text, isError: failed.isError }, { text: "disk is full", isError: true });
  assert.equal((await states.get(ALPHA)).sessions[sessionId].plan, undefined);
});

// Antigravity (ACP) can't steer a running turn: what the user sends meanwhile waits in the chat's queue.
const agy = (projectPath, body, extra = {}) => message(projectPath, body, { provider: "antigravity", model: "gemini-3-pro", ...extra });

async function runningAgyChat(t, options) {
  const h = harness(options);
  t.after(() => h.manager.closeAll());
  const chat = await h.host.send(agy(ALPHA, "build it"));
  await waitUntil(() => h.session(ALPHA)?.turns.length === 1);
  h.session(ALPHA).emit({ type: "session-started", nativeId: "agy-1" });
  h.session(ALPHA).emit({ type: "turn-started", turnId: "t1" });
  h.session(ALPHA).emit({ type: "text-delta", messageId: "m1", text: "Building." });
  await waitUntil(() => h.host.runs[`${ALPHA}#${chat.sessionId}`]?.text === "Building.");
  return { ...h, chat, chatId: `${ALPHA}#${chat.sessionId}` };
}

test("a message for a running turn that can't be steered is queued, then starts its own turn when that one completes", async (t) => {
  const { host, saved, session, chat, chatId, broadcasts } = await runningAgyChat(t);
  const first = await host.send(agy(ALPHA, "then add tests", { sessionId: chat.sessionId, clientMessageId: "c-1", effort: "high" }));
  await host.send(agy(ALPHA, "and docs", { sessionId: chat.sessionId }));
  assert.equal(first.queued, true);

  const queued = saved.get(ALPHA).sessions[chat.sessionId].queued;
  assert.deepEqual(
    queued.map((item) => item.body),
    ["then add tests", "and docs"],
  );
  assert.equal(queued[0].clientMessageId, "c-1");
  assert.equal(broadcasts.at(-1).state.sessions[chat.sessionId].queued.length, 2);
  // Not in the transcript, the reply isn't split and the agent got nothing yet.
  assert.deepEqual(chatMessages(saved.get(ALPHA), chat.sessionId), [{ role: "user", body: "build it" }]);
  assert.equal(host.runs[chatId].text, "Building.");
  assert.equal(session(ALPHA).turns.length, 1);

  session(ALPHA).emit({ type: "turn-completed" });
  await waitUntil(() => session(ALPHA).turns.length === 2);
  assert.equal(session(ALPHA).turns[1].prompt, "then add tests");
  assert.equal(session(ALPHA).turns[1].effort, "high");
  assert.deepEqual(
    saved.get(ALPHA).sessions[chat.sessionId].queued.map((item) => item.body),
    ["and docs"],
  );
  assert.equal((await first.started).turnId, "t2");
  assert.equal(saved.get(ALPHA).messages.find((item) => item.body === "then add tests").clientMessageId, "c-1");

  // One turn per message, in order.
  session(ALPHA).emit({ type: "turn-started", turnId: "t2" });
  session(ALPHA).emit({ type: "turn-completed" });
  await waitUntil(() => session(ALPHA).turns.length === 3);
  assert.equal(session(ALPHA).turns[2].prompt, "and docs");
  await waitUntil(() => saved.get(ALPHA).sessions[chat.sessionId].queued === undefined);
  session(ALPHA).emit({ type: "turn-started", turnId: "t3" });
  session(ALPHA).emit({ type: "turn-completed" });
  await waitUntil(() => chatMessages(saved.get(ALPHA), chat.sessionId).length === 6);
  assert.deepEqual(
    chatMessages(saved.get(ALPHA), chat.sessionId).map((item) => item.body),
    ["build it", "Building.", "then add tests", "The agent finished without a reply.", "and docs", "The agent finished without a reply."],
  );
});

test("a resend of a message still in the queue is not queued twice, and it runs once", async (t) => {
  const { host, saved, session, chat } = await runningAgyChat(t);
  const first = await host.send(agy(ALPHA, "then add tests", { sessionId: chat.sessionId, clientMessageId: "c-1" }));
  assert.equal(first.queued, true);
  // The phone never saw the answer and sent the same message again.
  const again = await host.send(agy(ALPHA, "then add tests", { sessionId: chat.sessionId, clientMessageId: "c-1" }));
  assert.equal(again.duplicate, true);
  assert.equal(again.sessionId, chat.sessionId);
  assert.equal(await again.started, null);
  assert.equal(saved.get(ALPHA).sessions[chat.sessionId].queued.length, 1);

  session(ALPHA).emit({ type: "turn-completed" });
  await waitUntil(() => session(ALPHA).turns.length === 2);
  await waitUntil(() => saved.get(ALPHA).sessions[chat.sessionId].queued === undefined);
  assert.equal(saved.get(ALPHA).messages.filter((item) => item.clientMessageId === "c-1").length, 1);
});

test("a message for a running Claude turn still steers it", async (t) => {
  const { host, manager, saved, session } = harness();
  t.after(() => manager.closeAll());
  const chat = await host.send(message(ALPHA, "start"));
  await waitUntil(() => session(ALPHA));
  session(ALPHA).emit({ type: "turn-started", turnId: "t1" });
  await waitUntil(() => host.runs[`${ALPHA}#${chat.sessionId}`]);
  const sent = await host.send(message(ALPHA, "also this", { sessionId: chat.sessionId }));
  assert.equal(sent.queued, undefined);
  await waitUntil(() => session(ALPHA).turns.length === 2);
  assert.equal(saved.get(ALPHA).sessions[chat.sessionId].queued, undefined);
});

test("Stop holds the queue; Send now starts a message and the rest follow it, Remove drops one", async (t) => {
  const { host, saved, session, chat, chatId } = await runningAgyChat(t);
  const removed = await host.send(agy(ALPHA, "first", { sessionId: chat.sessionId }));
  await host.send(agy(ALPHA, "second", { sessionId: chat.sessionId }));
  await host.send(agy(ALPHA, "third", { sessionId: chat.sessionId }));

  session(ALPHA).emit({ type: "turn-cancelled" });
  await waitUntil(() => saved.get(ALPHA).sessions[chat.sessionId].queueHeld === true);
  assert.equal(session(ALPHA).turns.length, 1);
  assert.equal(saved.get(ALPHA).sessions[chat.sessionId].queued.length, 3);

  const [first, second, third] = saved.get(ALPHA).sessions[chat.sessionId].queued;
  assert.equal(await host.removeQueued(chatId, first.id), true);
  assert.equal(await host.removeQueued(chatId, first.id), false);
  assert.deepEqual(await removed.started, { turnId: null, steered: false, cancelled: true, removed: true });

  // Send now on the last one: it starts at once, and the held queue is released.
  assert.deepEqual(await host.sendQueuedNow(chatId, third.id), { interrupt: false });
  await waitUntil(() => session(ALPHA).turns.length === 2);
  assert.equal(session(ALPHA).turns[1].prompt, "third");
  const after = saved.get(ALPHA).sessions[chat.sessionId];
  assert.deepEqual(
    after.queued.map((item) => item.id),
    [second.id],
  );
  assert.equal(after.queueHeld, undefined);
  await assert.rejects(host.sendQueuedNow(chatId, third.id), /already sent or removed/);

  session(ALPHA).emit({ type: "turn-started", turnId: "t2" });
  session(ALPHA).emit({ type: "turn-completed" });
  await waitUntil(() => session(ALPHA).turns.length === 3);
  assert.equal(session(ALPHA).turns[2].prompt, "second");
});

test("Send now while the turn runs stops it, then starts that message even though the turn was cancelled", async (t) => {
  const { host, saved, session, chat, chatId } = await runningAgyChat(t);
  await host.send(agy(ALPHA, "later", { sessionId: chat.sessionId }));
  await host.send(agy(ALPHA, "urgent", { sessionId: chat.sessionId }));
  const urgent = saved.get(ALPHA).sessions[chat.sessionId].queued[1];
  assert.deepEqual(await host.sendQueuedNow(chatId, urgent.id), { interrupt: true });
  // The runtime stops the turn; the agent ends it as cancelled.
  session(ALPHA).emit({ type: "turn-cancelled" });
  await waitUntil(() => session(ALPHA).turns.length === 2);
  assert.equal(session(ALPHA).turns[1].prompt, "urgent");
  assert.equal(saved.get(ALPHA).sessions[chat.sessionId].queueHeld, undefined);
  session(ALPHA).emit({ type: "turn-started", turnId: "t2" });
  session(ALPHA).emit({ type: "turn-completed" });
  await waitUntil(() => session(ALPHA).turns.length === 3);
  assert.equal(session(ALPHA).turns[2].prompt, "later");
});

test("a queued message whose save fails stays queued, and the queue waits for Send now", async (t) => {
  const { host, saved, session, chat, states } = await runningAgyChat(t);
  await host.send(agy(ALPHA, "next", { sessionId: chat.sessionId }));
  const flush = states.flush.bind(states);
  states.flush = async () => {
    states.flush = flush;
    throw new Error("disk full");
  };
  const warn = t.mock.method(console, "warn", () => {});
  session(ALPHA).emit({ type: "turn-completed" });
  await waitUntil(() => saved.get(ALPHA).sessions[chat.sessionId].queueHeld === true);
  assert.deepEqual(
    saved.get(ALPHA).sessions[chat.sessionId].queued.map((item) => item.body),
    ["next"],
  );
  assert.equal(
    saved.get(ALPHA).messages.some((item) => item.body === "next"),
    false,
  );
  assert.equal(session(ALPHA).turns.length, 1);
  assert.match(warn.mock.calls[0].arguments.join(" "), /disk full/);
});

test("a failed turn holds the queue too", async (t) => {
  const { host, saved, session, chat } = await runningAgyChat(t);
  await host.send(agy(ALPHA, "next", { sessionId: chat.sessionId }));
  session(ALPHA).emit({ type: "turn-failed", message: "boom" });
  await waitUntil(() => saved.get(ALPHA).sessions[chat.sessionId].queueHeld === true);
  assert.equal(session(ALPHA).turns.length, 1);
});

test("a quit keeps the queue, and it moves on once the resumed turn completes; nothing runs twice", async (t) => {
  const { host, saved, session, chat, states } = await runningAgyChat(t);
  await host.send(agy(ALPHA, "queued before quit", { sessionId: chat.sessionId }));
  await waitUntil(() => saved.get(ALPHA).sessions[chat.sessionId].native_session_id === "agy-1");
  await host.suspendRunning();
  await states.flush();
  session(ALPHA).emit({ type: "turn-cancelled" });
  await waitUntil(() => chatMessages(saved.get(ALPHA), chat.sessionId).length === 2);
  const stored = saved.get(ALPHA);
  assert.equal(stored.sessions[chat.sessionId].queued.length, 1);
  assert.equal(stored.sessions[chat.sessionId].queueHeld, undefined);
  assert.ok(stored.sessions[chat.sessionId].resumeTurn);
  assert.equal(session(ALPHA).turns.length, 1);

  // Milagre opens again: the stopped turn resumes first, then the queue.
  const next = harness({ read: async () => structuredClone(stored) });
  t.after(() => next.manager.closeAll());
  await next.host.resumeInterrupted(ALPHA, await next.states.get(ALPHA));
  await next.states.flush();
  await waitUntil(() => next.session(ALPHA)?.turns.length === 1);
  assert.match(next.session(ALPHA).turns[0].prompt, /closed while you were working/);
  next.session(ALPHA).emit({ type: "turn-started", turnId: "t1" });
  next.session(ALPHA).emit({ type: "turn-completed" });
  await waitUntil(() => next.session(ALPHA).turns.length === 2);
  assert.equal(next.session(ALPHA).turns[1].prompt, "queued before quit");
  await waitUntil(() => next.saved.get(ALPHA)?.sessions[chat.sessionId].queued === undefined);
  // Opening again finds nothing left to run.
  await next.host.resumeInterrupted(ALPHA, await next.states.get(ALPHA));
  assert.equal(next.session(ALPHA).turns.length, 2);
  assert.equal(next.saved.get(ALPHA).messages.filter((item) => item.body === "queued before quit").length, 1);
});

test("a queue left waiting by a restart with no turn to resume moves on when the project opens; a held one waits", async (t) => {
  const { host, manager, states, saved, session } = harness();
  t.after(() => manager.closeAll());
  const entry = { id: "q1", body: "pick this up", model: "gemini-3-pro", provider: "antigravity", queuedAt: NOW, turn: { permissionMode: "auto" } };
  const held = { ...entry, id: "q2", body: "held one" };
  await states.update(ALPHA, (state) => ({
    ...state,
    next_id: 9,
    sessions: {
      7: { id: 7, worktree_id: 1, agent_name: "main", status: "Created", provider: "antigravity", native_session_id: "a", queued: [entry] },
      8: { id: 8, worktree_id: 1, agent_name: "main", status: "Created", provider: "antigravity", native_session_id: "b", queued: [held], queueHeld: true },
    },
  }));
  await states.flush();
  await host.resumeInterrupted(ALPHA, saved.get(ALPHA));
  await waitUntil(() => session(ALPHA)?.turns.length === 1);
  assert.equal(session(ALPHA).turns[0].prompt, "pick this up");
  assert.equal(saved.get(ALPHA).sessions[7].queued, undefined);
  assert.equal(saved.get(ALPHA).sessions[8].queued.length, 1);
});

test("a queued message's images are stored when it is sent and reach the agent when its turn starts", async (t) => {
  const fs = require("node:fs/promises");
  const path = require("node:path");
  const os = require("node:os");
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-queue-image-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataUrl = "data:image/png;base64," + (await fs.readFile(path.join(__dirname, "../../../../scripts/fixtures/photo.png"))).toString("base64");
  const { host, saved, session, manager } = harness({ read: async () => projectState(root) });
  t.after(() => manager.closeAll());
  const chat = await host.send(agy(root, "build it"));
  await waitUntil(() => session(root)?.turns.length === 1);
  session(root).emit({ type: "session-started", nativeId: "agy-1" });
  session(root).emit({ type: "turn-started", turnId: "t1" });
  await waitUntil(() => host.runs[`${root}#${chat.sessionId}`]);
  await host.send(agy(root, "look", { sessionId: chat.sessionId, images: [{ id: "i", name: "photo.png", dataUrl }] }));
  const [queued] = saved.get(root).sessions[chat.sessionId].queued;
  assert.equal(queued.images[0].dataUrl, undefined);
  assert.ok(queued.images[0].path.startsWith(path.join(root, ".milagre", "images")));
  session(root).emit({ type: "turn-completed" });
  await waitUntil(() => session(root).turns.length === 2);
  assert.deepEqual(session(root).turns[1].images, [{ id: "i", name: "photo.png", dataUrl }]);
});

test("a message sent while a handoff to Antigravity prepares is queued behind that turn", async (t) => {
  let release;
  const { host, manager, saved, session, created } = harness({
    handoverTools: { writeTranscript: async () => "/tmp/t.md", brief: () => new Promise((resolve) => (release = resolve)) },
  });
  t.after(() => manager.closeAll());
  const sessionId = await chatWithReply(host, session, saved);
  await host.send(agy(ALPHA, "move over", { sessionId }));
  await waitUntil(() => release);
  const queued = await host.send(agy(ALPHA, "after the move", { sessionId }));
  assert.equal(queued.queued, true);
  release("BRIEF");
  const agent = () => created.find((item) => item.provider === "antigravity");
  await waitUntil(() => agent()?.turns.length === 1);
  agent().emit({ type: "session-started", nativeId: "agy-9" });
  agent().emit({ type: "turn-started", turnId: "t1" });
  agent().emit({ type: "turn-completed" });
  await waitUntil(() => agent().turns.length === 2);
  assert.deepEqual(
    agent().turns.map((turn) => turn.prompt),
    [`${framed("BRIEF")}\n\nmove over`, "after the move"],
  );
});

test("a queued message nobody waits on since a restart tells the runtime when it starts or is removed", async (t) => {
  const started = [];
  const removed = [];
  const { host, manager, states, saved } = harness({
    hooks: {
      onQueuedStart: (chatId, entry, run) => started.push({ chatId, entry, run }),
      onQueuedRemoved: (chatId, entry) => removed.push({ chatId, entry }),
    },
  });
  t.after(() => manager.closeAll());
  const context = { kind: "delegation", delegationId: "d1", from: "/api#1", fromLabel: "api" };
  const entry = { id: "q1", body: "Add it", context, model: "gemini-3-pro", provider: "antigravity", queuedAt: NOW, turn: { permissionMode: "auto" } };
  await states.update(ALPHA, (state) => ({
    ...state,
    next_id: 9,
    sessions: {
      7: { id: 7, worktree_id: 1, agent_name: "main", status: "Created", provider: "antigravity", native_session_id: "a", queued: [entry] },
      8: {
        id: 8,
        worktree_id: 1,
        agent_name: "main",
        status: "Created",
        provider: "antigravity",
        native_session_id: "b",
        queued: [{ ...entry, id: "q2" }],
        queueHeld: true,
      },
    },
  }));
  await states.flush();
  await host.resumeInterrupted(ALPHA, saved.get(ALPHA));
  await waitUntil(() => started.length === 1);
  assert.equal(started[0].chatId, `${ALPHA}#7`);
  assert.deepEqual(started[0].entry.context, context);
  assert.equal((await started[0].run).turnId, "t1");
  // The message keeps the Delegation's context, which its report is found by.
  await waitUntil(() => saved.get(ALPHA).messages.some((item) => item.body === "Add it"));
  assert.deepEqual(saved.get(ALPHA).messages.find((item) => item.body === "Add it").context, context);

  assert.equal(await host.removeQueued(`${ALPHA}#8`, "q2"), true);
  assert.deepEqual(
    removed.map((item) => [item.chatId, item.entry.id, item.entry.context.kind]),
    [[`${ALPHA}#8`, "q2", "delegation"]],
  );
  assert.equal(started.length, 1);
});

test("saving a new message clears suggestions before checkpoint preparation and publication", async (t) => {
  let release;
  const checkpoint = new Promise((resolve) => {
    release = resolve;
  });
  let preparing = false;
  const h = harness({
    hooks: {
      beforeTask: async () => {
        if (preparing) await checkpoint;
      },
    },
  });
  t.after(() => h.manager.closeAll());
  const sessionId = await chatWithReply(h.host, h.session, h.saved);
  await h.states.update(ALPHA, (state) => ({
    ...state,
    sessions: { ...state.sessions, [sessionId]: { ...state.sessions[sessionId], suggestion: { text: "Continue", turnId: "t1" }, suggestionTurnId: "t1" } },
  }));
  preparing = true;
  const send = h.host.send(message(ALPHA, "Next", { sessionId }));
  try {
    await waitUntil(() => h.saved.get(ALPHA)?.messages.at(-1)?.body === "Next");
    const staged = h.saved.get(ALPHA).sessions[sessionId];
    assert.equal(staged.suggestion, undefined);
    assert.equal(staged.suggestionTurnId, undefined);
  } finally {
    release();
    await send;
  }
  const sent = h.published.findLast(({ event }) => event.type === "message-sent").state.sessions[sessionId];
  assert.equal(sent.suggestion, undefined);
  assert.equal(sent.suggestionTurnId, undefined);
});
