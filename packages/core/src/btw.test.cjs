const test = require("node:test");
const assert = require("node:assert/strict");
const { createBtw } = require("./btw.cjs");
const { waitUntil } = require("./agents/test-helpers.cjs");

function fixture(t, overrides = {}) {
  const sessions = [];
  const events = [];
  const btw = createBtw({
    now: () => 42,
    contextFor: async () => ({ provider: "claude", model: "model", transcript: "Saved context" }),
    launch: async (options) => {
      const session = {
        options,
        turns: [],
        closed: false,
        interrupted: false,
        async startTurn(turn) {
          this.turns.push(turn);
        },
        async interrupt() {
          this.interrupted = true;
          options.emit({ type: "text-delta", text: "Late output" });
        },
        async close() {
          this.closed = true;
        },
      };
      sessions.push(session);
      return session;
    },
    emit: (channel, payload) => events.push({ channel, payload }),
    ...overrides,
  });
  t.after(() => btw.close());
  return { btw, sessions, events };
}
const request = { chatId: "/project#1", prompt: "What is this?" };

test("replacement and Stop reject late output and stop only the side session", async (t) => {
  const { btw, sessions } = fixture(t);
  const first = await btw.ask(request);
  await waitUntil(() => sessions[0]?.turns.length);
  await btw.ask({ ...request, prompt: "Another question" });
  await waitUntil(() => sessions[1]?.turns.length);
  assert.equal(sessions[0].closed, true);
  sessions[0].options.emit({ type: "text-delta", text: "Old answer" });
  assert.notEqual(btw.read(request.chatId).requestId, first.requestId);
  assert.equal(btw.read(request.chatId).text, "");
  await btw.stop(request.chatId, null);
  sessions[1].options.emit({ type: "turn-completed" });
  assert.equal(btw.read(request.chatId).status, "cancelled");
  assert.equal(btw.read(request.chatId).text, "");
  assert.equal(sessions[1].closed, true);
});

test("completion closes its process, retains a readable answer, and a later ask takes fresh context", async (t) => {
  let context = "First context";
  const f = fixture(t, { contextFor: async () => ({ provider: "kiro", model: "m", transcript: context }) });
  await f.btw.ask(request);
  await waitUntil(() => f.sessions[0]?.turns.length);
  assert.match(f.sessions[0].turns[0].prompt, /First context/);
  f.sessions[0].options.emit({ type: "text-delta", text: "Answer" });
  f.sessions[0].options.emit({ type: "turn-completed" });
  await waitUntil(() => f.sessions[0].closed);
  assert.equal(f.btw.read(request.chatId).text, "Answer");
  context = "New context";
  await f.btw.ask(request);
  await waitUntil(() => f.sessions[1]?.turns.length);
  assert.match(f.sessions[1].turns[0].prompt, /New context/);
  assert.doesNotMatch(f.sessions[1].turns[0].prompt, /First context/);
});

test("Stop during launch closes the new process before sending a prompt", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let closed = false;
  const f = fixture(t, {
    launch: async () => {
      await gate;
      return {
        startTurn() {
          assert.fail("Stopped launch sent a prompt");
        },
        async interrupt() {},
        async close() {
          closed = true;
        },
      };
    },
  });
  await f.btw.ask(request);
  await f.btw.stop(request.chatId);
  release();
  await f.btw.closeChat(request.chatId);
  assert.equal(closed, true);
  assert.equal(f.btw.read(request.chatId), null);
});

for (const provider of ["claude", "codex"]) {
  test(`${provider} forks the parent session rather than resuming it in place`, async (t) => {
    const f = fixture(t, { contextFor: async () => ({ provider, model: "m", parentNativeId: "parent" }) });
    await f.btw.ask(request);
    await waitUntil(() => f.sessions[0]?.turns.length);
    assert.equal(f.sessions[0].options.forkSession, true);
    assert.equal(f.sessions[0].options.resumeId, "parent");
    assert.equal(f.sessions[0].turns[0].prompt, request.prompt);
  });
}
