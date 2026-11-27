const assert = require("node:assert/strict");
const test = require("node:test");
const { registerChatEdit } = require("./chat-edit.cjs");

const PROJECT = "/projects/alpha";
const CHAT = `${PROJECT}#4`;

function fixture({ running = false, files = [], wait, beforeSend, native = { provider: "claude", prompt: "p10" } } = {}) {
  const calls = { stopped: 0, restored: [], sent: [], notes: [] };
  let busy = running;
  const messages = [
    { id: 10, session_id: 4, role: "user", body: "add Retry", context: null, native, images: [], files: [] },
    { id: 11, session_id: 4, role: "assistant", body: "Added.", context: null },
    { id: 12, session_id: 4, role: "user", body: "show the error", context: null },
    { id: 13, session_id: 4, role: "assistant", body: "Shown.", context: null },
    { id: 14, session_id: 4, role: "user", body: "Answered", context: null, answered: [{ header: "Color", question: "Which?", answers: ["Red"] }] },
  ];
  const state = { next_id: 30, sessions: { 4: { id: 4, provider: "claude", native_session_id: "native-1" } }, messages };
  const handlers = {};
  const states = {
    has: () => true,
    get: async () => state,
    chatMessages: async () => state.messages,
    update: async (_path, change) => {
      Object.assign(state, change(state));
      return { state };
    },
  };
  const agentNotes = new Map();
  const edits = registerChatEdit({
    commands: { handle: (name, handler) => (handlers[name] = handler) },
    chats: { editing: new Map(), isBusy: () => busy, states, runs: {}, preparing: new Map(), startingTurns: new Map(), broadcast: () => {} },
    agents: { isTurnActive: () => false, backgroundWork: () => 0 },
    checkpoints: {
      capturing: () => false,
      rewind: async () => (files.length ? { token: "tok", revision: "current", files } : null),
      restore: async (_chatId, request) => {
        calls.restored.push(request);
        const kept = Object.values(request.decisions).filter((value) => value === "keep").length;
        return { restored: files.length - kept, kept, recoveryId: "rec-1" };
      },
    },
    stopChat: async () => {
      calls.stopped += 1;
      busy = false;
    },
    sendAsUser: async (request) => {
      await beforeSend?.(request);
      if (calls.fail) throw calls.fail;
      calls.sent.push(request);
      return { sessionId: 4 };
    },
    agentNotes,
    wait,
  });
  calls.notes = {
    get length() {
      return agentNotes.get(CHAT)?.length ?? 0;
    },
  };
  const request = (extra = {}) => ({
    projectPath: PROJECT,
    sessionId: 4,
    worktreeId: 1,
    messageId: 10,
    body: "add Retry to the sheet and the chip",
    prompt: "add Retry to the sheet and the chip",
    images: [],
    files: [],
    provider: "claude",
    model: "claude-opus-5-5",
    permissionMode: "auto",
    ...extra,
  });
  return { calls, edits, handlers, state, states, request };
}

const divider = (state) => state.messages.find((message) => message.context?.kind === "message-edit");

test("an edit stops the running turn, undoes the removed turns' files except later edits, then sends with the rewind", async () => {
  const files = [
    { key: "0:a.ts", path: "a.ts", conflict: false },
    { key: "0:b.ts", path: "b.ts", conflict: true },
  ];
  const f = fixture({ running: true, files });
  await assert.rejects(f.handlers["chat:edit"]({}, f.request({ undoFiles: { revision: "old", decisions: { "0:b.ts": "restore" } } })), /Files changed/);
  await assert.rejects(f.handlers["chat:edit"]({}, f.request({ undoFiles: { decisions: {} } })), /Choose Keep current or Undo/);
  assert.deepEqual(f.calls.restored, []);
  assert.equal(f.state.messages.length, 5);
  await f.handlers["chat:edit"]({}, f.request({ undoFiles: { revision: "current", decisions: { "0:b.ts": "keep" } } }));
  assert.equal(f.calls.stopped, 1);
  assert.deepEqual(f.calls.restored, [{ token: "tok", decisions: { "0:a.ts": "restore", "0:b.ts": "keep" }, approved: true }]);
  assert.equal(f.calls.notes.length, 1);
  const [sent] = f.calls.sent;
  assert.equal(sent.messageId, undefined);
  assert.deepEqual(sent.rewind, { claude: { prompt: "p10", dropsTurn: true } });
  assert.deepEqual(
    f.state.messages.map((message) => message.id),
    [30],
  );
  assert.deepEqual(divider(f.state).context, { kind: "message-edit", edited: 10, removed: 4, restored: 1, kept: 1, recoveryId: "rec-1" });
  assert.equal(divider(f.state).body, "Edited · removed 4 messages · undid 1 file");
  assert.equal(f.state.sessions[4].native_session_id, "native-1");
});

test("an edit leaves files alone when asked, tells the agent, puts the messages back if the send fails, and refuses messages the user didn't type", async () => {
  const f = fixture({ files: [{ key: "0:a.ts", path: "a.ts", conflict: false }] });
  await f.handlers["chat:edit"]({}, f.request({ undoFiles: null }));
  assert.deepEqual(f.calls.restored, []);
  assert.equal(f.calls.notes.length, 1);
  assert.deepEqual(divider(f.state).context, { kind: "message-edit", edited: 10, removed: 4 });

  const g = fixture();
  g.calls.fail = new Error("disk full");
  await assert.rejects(g.handlers["chat:edit"]({}, g.request()), /disk full/);
  assert.deepEqual(
    g.state.messages.map((message) => message.id),
    [10, 11, 12, 13, 14],
  );
  await assert.rejects(g.handlers["chat:edit"]({}, g.request({ messageId: 14 })), /can't be edited/);
  await assert.rejects(g.handlers["chat:edit"]({}, g.request({ messageId: 11 })), /can't be edited/);
});

test("a provider that can't rewind continues in a new session, replacing the edit's divider and failed reply", async () => {
  const f = fixture({ native: null });
  await f.handlers["chat:edit"]({}, f.request());
  assert.deepEqual(f.calls.sent[0].rewind, { fresh: true });
  assert.equal(divider(f.state).context.newSession, undefined);
  assert.equal(f.state.sessions[4].native_session_id, undefined);

  const g = fixture();
  await g.handlers["chat:edit"]({}, g.request());
  g.state.messages.push(
    {
      id: 31,
      session_id: 4,
      role: "user",
      clientMessageId: g.calls.sent[0].clientMessageId,
      body: "add Retry to the sheet and the chip",
      context: null,
      images: [],
      files: [],
    },
    { id: 32, session_id: 4, role: "assistant", outcome: "failed", body: "", context: null },
  );
  g.state.next_id = 33;
  await g.edits.observe(CHAT, { type: "turn-failed", message: "Resume rejected by --resume-drops-turn: x", rewindFailed: true });
  const retry = g.calls.sent[1];
  assert.deepEqual(retry.rewind, { fresh: true });
  assert.ok(retry.clientMessageId);
  assert.notEqual(retry.clientMessageId, g.calls.sent[0].clientMessageId);
  assert.deepEqual(
    g.state.messages.map((message) => message.id),
    [33],
  );
  assert.deepEqual(divider(g.state).context, { kind: "message-edit", edited: 10, removed: 4, newSession: true });

  await g.edits.observe(CHAT, { type: "turn-failed", message: "again", rewindFailed: true });
  assert.equal(g.calls.sent.length, 2);
});

test("a delayed rewind failure cannot retry over a later user send or another edit", async () => {
  for (const next of ["send", "edit"]) {
    const waiting = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const f = fixture({
      wait: async () => {
        waiting.resolve();
        await resume.promise;
      },
    });
    await f.edits.editAsUser(f.request());
    f.state.messages.push(
      { id: 31, session_id: 4, role: "user", body: "replacement", clientMessageId: f.calls.sent[0].clientMessageId },
      { id: 32, session_id: 4, role: "assistant", outcome: "failed" },
    );
    f.state.next_id = 33;
    const retry = f.edits.observe(CHAT, { type: "turn-failed", rewindFailed: true });
    await waiting.promise;
    if (next === "edit") await f.edits.editAsUser(f.request({ messageId: 31, body: "newer edit" }));
    f.state.messages.push({ id: f.state.next_id++, session_id: 4, role: "user", body: "newer message", clientMessageId: "newer" });
    const before = structuredClone(f.state);
    resume.resolve();
    await retry;
    assert.deepEqual(f.state, before);
    assert.equal(f.calls.sent.length, next === "edit" ? 2 : 1);
    assert.equal(f.calls.stopped, 0);
  }
});

test("an overlapping edit cannot rewind while an earlier edit is sending or rolling back", async () => {
  const sending = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const f = fixture({
    beforeSend: () => {
      sending.resolve();
      return finish.promise;
    },
  });
  const first = f.edits.editAsUser(f.request({ messageId: 12 }));
  await sending.promise;
  await assert.rejects(f.edits.editAsUser(f.request({ messageId: 10 })), /being edited/);
  f.state.sessions[4].title = "renamed on the phone";
  f.state.messages.push({ id: 31, session_id: 4, role: "assistant", body: "note added by another device" });
  const rejected = assert.rejects(first, /send failed/);
  finish.reject(new Error("send failed"));
  await rejected;
  assert.deepEqual(
    f.state.messages.map((m) => m.id),
    [10, 11, 12, 13, 14, 31],
  );
  assert.equal(f.state.sessions[4].title, "renamed on the phone");
});

test("retry rechecks the failed turn inside the transcript update", async (t) => {
  const f = fixture();
  await f.edits.editAsUser(f.request());
  f.state.messages.push(
    { id: 31, session_id: 4, role: "user", body: "replacement", clientMessageId: f.calls.sent[0].clientMessageId },
    { id: 32, session_id: 4, role: "assistant", outcome: "failed" },
  );
  f.state.next_id = 33;
  const update = f.states.update;
  t.mock.method(f.states, "update", (...args) => {
    f.state.messages.push({ id: f.state.next_id++, session_id: 4, role: "assistant", body: "new activity" });
    return update(...args);
  });
  await f.edits.observe(CHAT, { type: "turn-failed", rewindFailed: true });
  assert.deepEqual(
    f.state.messages.map((m) => m.id),
    [30, 31, 32, 33],
  );
  assert.equal(f.calls.sent.length, 1);
});
