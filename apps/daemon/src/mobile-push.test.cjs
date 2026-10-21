const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createMobilePush } = require("./mobile-push.cjs");

const deviceId = "b6e2df4b-972b-4e7b-bc65-6cda0a173798";
const token = "ExpoPushToken[phone-one]";
const chatId = "/project#1";
const approval = { type: "permission-request", requestId: "request-1", kind: "command", title: "Run?", command: "ls", tool: "Shell" };
const registration = (extra = {}) => ({ deviceId, token, hostId: "https://mac.example.com", notifyWhenWaiting: true, notifyOnCompletion: true, ...extra });

test("named Link notifications retain their canonical owner and focus suppresses them", async (t) => {
  const { push, messages } = await fixture(t);
  const owner = "milagre-link:40996067-6cc2-4427-bc1e-9007c5f51875";
  const linkedChat = `${owner}#1`;
  await push.register(registration());
  push.observe(linkedChat, { type: "turn-started" });
  push.observe(linkedChat, approval);
  await push.settled();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].data.projectPath, owner);
  push.focus({ deviceId, chatId: linkedChat });
  push.observe(linkedChat, { type: "turn-completed" });
  await push.settled();
  assert.equal(messages.length, 1);
  assert.throws(() => push.focus({ deviceId, chatId: "milagre-link:invalid#1" }), /Invalid focused Chat/);
});

test("accepted input followed by a startup failure starts a fresh notification lifecycle", async (t) => {
  const { push, messages } = await fixture(t);
  await push.register(registration());
  push.observe(chatId, { type: "turn-started", turnId: "old" });
  push.observe(chatId, { type: "turn-completed" });
  await push.settled();
  push.observe(chatId, { type: "message-sent" });
  push.observe(chatId, { type: "turn-failed", message: "CLI unavailable" });
  push.observe(chatId, { type: "turn-failed", message: "CLI unavailable" });
  await push.settled();
  assert.equal(messages.length, 2);
  assert.equal(messages[1].body, "Turn failed: CLI unavailable");
});

test("steering an active turn preserves request deduplication", async (t) => {
  const { push, messages } = await fixture(t);
  await push.register(registration());
  push.observe(chatId, { type: "turn-started" });
  push.observe(chatId, approval);
  await push.settled();
  push.observe(chatId, { type: "message-sent" });
  push.observe(chatId, approval);
  await push.settled();
  assert.equal(messages.length, 1);
});
test("a quiet chat sends approvals but no completion", async (t) => {
  const { push, messages } = await fixture(t, { isQuietChat: (id) => id === chatId });
  await push.register(registration());
  push.observe(chatId, { type: "turn-started" });
  push.observe(chatId, approval);
  await push.settled();
  push.observe(chatId, { type: "permission-resolved", requestId: approval.requestId, decision: "allow" });
  push.observe(chatId, { type: "turn-completed" });
  await push.settled();
  assert.equal(messages.length, 1);
  assert.match(messages[0].body, /ls/);
  // Another Chat still announces its end.
  push.observe("/project#2", { type: "turn-started" });
  push.observe("/project#2", { type: "turn-completed" });
  await push.settled();
  assert.equal(messages.length, 2);
});

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-push-"));
  const messages = [];
  let clock = 1000;
  const push = createMobilePush({
    dataDir,
    now: () => clock,
    send: async (message, current) => {
      if (current()) messages.push(message);
    },
    context: async () => ({ projectName: "Project", worktreeName: "fix-login", chatTitle: "Login", provider: "codex" }),
    ...options,
  });
  await push.load();
  t.after(async () => {
    await push.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return {
    push,
    dataDir,
    messages,
    advance: (ms) => {
      clock += ms;
    },
  };
}

test("sends approvals, questions, completion and failure without an attached client", async (t) => {
  const { push, messages } = await fixture(t);
  await push.register(registration());
  push.observe(chatId, { type: "turn-started", turnId: "turn-1" });
  push.observe(chatId, approval);
  await push.settled();
  assert.equal(messages[0].title, "Login");
  assert.ok(!messages[0].subtitle);
  assert.match(messages[0].body, /needs approval: Run: ls/);
  assert.deepEqual(messages[0].data, {
    kind: "milagre-chat",
    hostId: "https://mac.example.com",
    projectPath: "/project",
    sessionId: 1,
    eventId: messages[0].data.eventId,
  });
  push.observe(chatId, { type: "question-request", requestId: "question-1", questions: [{ question: "Which branch?" }] });
  await push.settled();
  assert.equal(messages[1].title, "Login");
  assert.match(messages[1].body, /needs input: Which branch\?/);
  push.observe(chatId, { type: "text-delta", text: "Done fixing login." });
  push.observe(chatId, { type: "turn-completed" });
  await push.settled();
  assert.equal(messages[2].title, "Login");
  assert.equal(messages[2].body, "Done fixing login.");
  push.observe(chatId, { type: "turn-started", turnId: "turn-2" });
  push.observe(chatId, { type: "turn-failed", message: "Provider unavailable" });
  await push.settled();
  assert.equal(messages[3].title, "Login");
  assert.equal(messages[3].body, "Turn failed: Provider unavailable");
  push.observe(chatId, { type: "turn-started", turnId: "turn-3" });
  push.observe(chatId, { type: "turn-cancelled" });
  await push.settled();
  assert.equal(messages.length, 4);
});

test("duplicates and requests resolved before delivery never produce another alert", async (t) => {
  let release;
  const contextReady = new Promise((resolve) => {
    release = resolve;
  });
  const { push, messages } = await fixture(t, { context: () => contextReady });
  await push.register(registration());
  push.observe(chatId, { type: "turn-started" });
  push.observe(chatId, approval);
  push.observe(chatId, approval);
  push.observe(chatId, { type: "permission-resolved", requestId: approval.requestId });
  release({ projectName: "Project" });
  await push.settled();
  assert.equal(messages.length, 0);
  push.observe(chatId, { ...approval, requestId: "still-open" });
  await push.settled();
  push.observe(chatId, { ...approval, requestId: "still-open" });
  push.observe(chatId, { type: "turn-completed" });
  push.observe(chatId, { type: "turn-completed" });
  await push.settled();
  assert.equal(messages.length, 2);
});

test("focus suppresses only the viewing device and expires after 15 seconds", async (t) => {
  const { push, messages, advance } = await fixture(t);
  await push.register(registration());
  await push.register(registration({ deviceId: "4ca2caa8-0c0f-4c7e-8f84-b1de42861eb6", token: "ExpoPushToken[phone-two]" }));
  push.focus({ deviceId, chatId });
  push.observe(chatId, approval);
  await push.settled();
  assert.deepEqual(
    messages.map((message) => message.to),
    ["ExpoPushToken[phone-two]"],
  );
  advance(15001);
  push.observe(chatId, { ...approval, requestId: "after-suspend" });
  await push.settled();
  assert.equal(messages.length, 3);
  push.focus({ deviceId, chatId: null });
  push.observe(chatId, { ...approval, requestId: "unfocused" });
  await push.settled();
  assert.equal(messages.length, 5);
});

test("a Chat open in a focused desktop window reaches no phone", async (t) => {
  let viewed = chatId;
  const { push, messages } = await fixture(t, { isChatFocused: (id) => id === viewed });
  await push.register(registration());
  push.observe(chatId, approval);
  push.observe("/project#2", approval);
  await push.settled();
  assert.deepEqual(
    messages.map((message) => message.data.sessionId),
    [2],
  );
  viewed = null;
  push.observe(chatId, { type: "turn-completed" });
  await push.settled();
  assert.deepEqual(
    messages.map((message) => message.data.sessionId),
    [2, 1],
  );
});

test("preferences, token rotation and unregister are private and survive restart", async (t) => {
  const { push, dataDir, messages } = await fixture(t);
  await push.register(registration({ notifyWhenWaiting: false }));
  const file = path.join(dataDir, "mobile-push.json");
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  push.observe(chatId, approval);
  await push.settled();
  assert.equal(messages.length, 0);
  const second = createMobilePush({ dataDir, send: async (message) => messages.push(message), context: async () => ({ projectName: "Project" }) });
  await second.load();
  await second.register(registration({ token: "ExpoPushToken[rotated]", notifyOnCompletion: false }));
  second.observe(chatId, approval);
  second.observe(chatId, { type: "turn-completed" });
  await second.settled();
  // Ending the turn invalidates the queued approval too.
  assert.equal(messages.length, 0);
  second.observe(chatId, { type: "turn-started" });
  second.observe(chatId, approval);
  await second.settled();
  assert.equal(messages[0].to, "ExpoPushToken[rotated]");
  await second.unregister({ deviceId });
  second.observe(chatId, { ...approval, requestId: "after-forget" });
  await second.settled();
  assert.equal(messages.length, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), []);
  await second.close();
});

test("a phone's chime picks its push sound and Android channel, and survives a restart", async (t) => {
  const { push, dataDir, messages } = await fixture(t);
  await push.register(registration());
  push.observe(chatId, { type: "turn-started" });
  push.observe(chatId, approval);
  await push.settled();
  assert.equal(messages[0].sound, "default");
  assert.equal(messages[0].channelId, "chats");
  await push.register(registration({ chime: "bombastic-side-eye" }));
  push.observe(chatId, { type: "turn-completed" });
  await push.settled();
  assert.equal(messages[1].sound, "chime_bombastic_side_eye.wav");
  assert.equal(messages[1].channelId, "chats-bombastic_side_eye");
  const second = createMobilePush({ dataDir, send: async (message) => messages.push(message), context: async () => ({ projectName: "Project" }) });
  await second.load();
  second.observe(chatId, { type: "turn-started" });
  second.observe(chatId, { type: "turn-completed" });
  await second.settled();
  assert.equal(messages.at(-1).sound, "chime_bombastic_side_eye.wav");
  // A chime a newer phone added, unknown here, plays the system sound.
  await second.register(registration({ chime: "air-horn" }));
  second.observe(chatId, { type: "turn-started" });
  second.observe(chatId, { type: "turn-completed" });
  await second.settled();
  assert.equal(messages.at(-1).sound, "default");
  await second.close();
});

test("clear and token rotation invalidate deliveries already queued in a sender", async (t) => {
  const queued = [];
  const { push } = await fixture(t, { send: async (message, current) => queued.push({ message, current }) });
  await push.register(registration());
  push.observe(chatId, approval);
  await push.settled();
  assert.equal(queued[0].current(), true);
  await push.register(registration({ token: "ExpoPushToken[new]" }));
  assert.equal(queued[0].current(), false);
  push.observe(chatId, { ...approval, requestId: "new" });
  await push.settled();
  await push.clear();
  assert.equal(queued[1].current(), false);
});

test("invalid receipt removes only the matching token, never a newer registration", async (t) => {
  const { push, dataDir } = await fixture(t);
  await push.register(registration());
  await push.register(registration({ token: "ExpoPushToken[new]" }));
  await push.invalidate(token);
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, "mobile-push.json"), "utf8")).length, 1);
  await push.invalidate("ExpoPushToken[new]");
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, "mobile-push.json"), "utf8")), []);
});

test("registration rejects invalid tokens, origins, device IDs and preferences", async (t) => {
  const { push } = await fixture(t);
  for (const extra of [
    { deviceId: "../file" },
    { token: "secret" },
    { hostId: "http://evil.example" },
    { hostId: "https://user:secret@mac.example" },
    { hostId: "https://mac.example/path" },
    { notifyWhenWaiting: "yes" },
    { notifyOnCompletion: 1 },
  ]) {
    await assert.rejects(push.register(registration(extra)), /Invalid/);
  }
  assert.throws(() => push.focus({ deviceId, chatId }), /not registered/);
});

test("caps notification copy, isolates errors and never places credentials in data", async (t) => {
  const errors = [];
  const { push, messages } = await fixture(t, {
    onError: (error) => errors.push(error),
    context: async () => ({ projectName: "x".repeat(200), chatTitle: "y".repeat(200) }),
  });
  await push.register(registration());
  push.observe(chatId, { ...approval, command: "z".repeat(1000) });
  await push.settled();
  assert.ok(messages[0].title.length <= 120);
  assert.ok(messages[0].body.length <= 240);
  assert.ok(!JSON.stringify(messages[0].data).includes(token));
  const failing = await fixture(t, {
    send: async () => {
      throw new Error("private payload");
    },
    onError: (error) => errors.push(error),
  });
  await failing.push.register(registration());
  failing.push.observe(chatId, approval);
  await failing.push.settled();
  assert.equal(errors.length, 1);
  assert.ok(!errors[0].message.includes("private payload"));
});

test("a relay computer registers, survives a restart, and a malformed relay id is rejected", async (t) => {
  const relayId = "relay://AbCdEfGhIjKlMnOpQrSt_-";
  const { push, dataDir, messages } = await fixture(t);
  assert.deepEqual(await push.register(registration({ hostId: relayId })), { registered: true });
  const errors = [];
  const second = createMobilePush({
    dataDir,
    send: async (message) => messages.push(message),
    context: async () => ({ projectName: "Project" }),
    onError: (error) => errors.push(error),
  });
  await second.load();
  assert.deepEqual(errors, []);
  second.observe(chatId, approval);
  await second.settled();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].data.hostId, relayId);
  await second.close();
  for (const hostId of [
    "relay://short",
    "relay://AbCdEfGhIjKlMnOpQrSt_-x",
    "relay://AbCdEfGhIjKlMnOpQrSt+/",
    "relay://AbCdEfGhIjKlMnOpQrSt_-/",
    "RELAY://AbCdEfGhIjKlMnOpQrSt_-",
  ]) {
    await assert.rejects(push.register(registration({ hostId })), /Invalid push computer address/, hostId);
  }
});
test("a turn that ends while a background subagent runs is held; the turn its result wakes, or the last subagent ending, announces it", async (t) => {
  const { push, messages } = await fixture(t);
  await push.register(registration());
  const agent = (id, status, background = true) => ({
    type: "subagent-update",
    agent: { id, title: "Review", status, ...(background ? { background } : {}), startedAt: 1, updatedAt: 1, transcript: [] },
  });
  push.observe(chatId, { type: "turn-started", turnId: "t1" });
  push.observe(chatId, agent("a", "running"));
  push.observe(chatId, { type: "text-delta", text: "Waiting on the reviewer." });
  push.observe(chatId, { type: "turn-completed" });
  await push.settled();
  assert.equal(messages.length, 0);
  push.observe(chatId, { type: "turn-started", turnId: "t2", continues: "t1" });
  push.observe(chatId, agent("a", "completed"));
  push.observe(chatId, agent("b", "running"));
  push.observe(chatId, { type: "text-delta", text: "First review in; waiting on the second." });
  push.observe(chatId, { type: "turn-completed" });
  await push.settled();
  assert.equal(messages.length, 0);
  push.observe(chatId, agent("b", "completed"));
  await push.settled();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].title, "Login");
  assert.equal(messages[0].body, "First review in; waiting on the second.");
  push.observe(chatId, { type: "turn-started", turnId: "t3" });
  push.observe(chatId, agent("c", "running"));
  push.observe(chatId, { type: "turn-failed", message: "Provider unavailable" });
  await push.settled();
  assert.equal(messages.length, 2);
  push.observe(chatId, agent("c", "cancelled"));
  await push.settled();
  assert.equal(messages.length, 2);
  push.observe(chatId, { type: "turn-started", turnId: "t4" });
  push.observe(chatId, agent("d", "running", false));
  push.observe(chatId, { type: "turn-completed" });
  await push.settled();
  assert.equal(messages.length, 3);
});

test("a stopped turn announces nothing, even once its background subagent ends; a running advisor holds a completion too", async (t) => {
  const { push, messages } = await fixture(t);
  await push.register(registration());
  const agent = (id, status, extra = { background: true }) => ({
    type: "subagent-update",
    agent: { id, title: "Review", status, ...extra, startedAt: 1, updatedAt: 1, transcript: [] },
  });
  push.observe(chatId, { type: "turn-started", turnId: "t1" });
  push.observe(chatId, agent("a", "running"));
  push.observe(chatId, { type: "turn-cancelled" });
  push.observe(chatId, agent("a", "cancelled"));
  await push.settled();
  assert.equal(messages.length, 0);
  push.observe(chatId, { type: "turn-started", turnId: "t2" });
  push.observe(chatId, agent("advisor", "running", { source: "milagre-advisor" }));
  push.observe(chatId, { type: "text-delta", text: "Asked an advisor." });
  push.observe(chatId, { type: "turn-completed" });
  await push.settled();
  assert.equal(messages.length, 0);
  push.observe(chatId, agent("advisor", "completed", { source: "milagre-advisor" }));
  await push.settled();
  assert.deepEqual(
    messages.map((message) => message.body),
    ["Asked an advisor."],
  );
});

test("phone completion notifications summarize the latest reply without project or branch labels", async (t) => {
  const { push, messages } = await fixture(t);
  await push.register(registration());
  push.observe(chatId, { type: "turn-started" });
  push.observe(chatId, { type: "text-delta", text: "I'll investigate the redirect." });
  push.observe(chatId, { type: "text-delta", text: "\n\n", startsMessage: true });
  push.observe(chatId, { type: "text-delta", text: "## Login fixed\n\n**The redirect** now uses [the callback](/src/auth.ts).\n- Tests passed. " });
  push.observe(chatId, { type: "text-delta", text: "Further details about the fix. ".repeat(30) });
  push.observe(chatId, { type: "turn-completed" });
  await push.settled();
  assert.equal(messages[0].title, "Login");
  assert.ok(!messages[0].subtitle);
  assert.ok(messages[0].body.startsWith("Login fixed The redirect now uses the callback. Tests passed."));
  assert.ok(!messages[0].body.includes("investigate"));
  assert.ok(!/[#*[\]\n]/.test(messages[0].body));
  assert.ok(messages[0].body.length <= 240);
  assert.ok(messages[0].body.endsWith("…"));
  assert.ok(/\w…$/.test(messages[0].body));
});

test("phone notifications with no chat name never show the project name", async (t) => {
  const { push, messages } = await fixture(t, { context: async () => ({ projectName: "Project", worktreeName: "fix-login" }) });
  await push.register(registration());
  push.observe(chatId, approval);
  await push.settled();
  push.observe(chatId, { type: "turn-completed" });
  await push.settled();
  assert.deepEqual(
    messages.map(({ title }) => title),
    ["Milagre", "Milagre"],
  );
  assert.ok(messages.every(({ subtitle }) => !subtitle));
});

test("phone previews preserve paragraphs and shell patterns in approvals", async (t) => {
  const { push, messages } = await fixture(t);
  await push.register(registration());
  push.observe(chatId, { type: "turn-started" });
  push.observe(chatId, { ...approval, command: "find . -name *test* && printf '%s' 'two   spaces' && rm -rf __pycache__" });
  await push.settled();
  assert.equal(messages[0].body, "Codex needs approval: Run: find . -name *test* && printf '%s' 'two   spaces' && rm -rf __pycache__");
  for (const text of ["Login fixed.", "\n\n", "Tests passed."]) push.observe(chatId, { type: "text-delta", text });
  push.observe(chatId, { type: "turn-completed" });
  await push.settled();
  assert.equal(messages[1].body, "Login fixed. Tests passed.");
});

// A heartbeat whose reply was a "(pass)" ends quiet: nothing to tell the phone about.
test("a quiet turn sends no completion push; the same turn without quiet sends one", async (t) => {
  const { push, messages } = await fixture(t);
  await push.register(registration());
  push.observe(chatId, { type: "turn-started", turnId: "beat-1" });
  push.observe(chatId, { type: "text-delta", text: "(pass) CI green" });
  push.observe(chatId, { type: "turn-completed", quiet: true });
  await push.settled();
  assert.equal(messages.length, 0);
  push.observe(chatId, { type: "turn-started", turnId: "beat-2" });
  push.observe(chatId, { type: "text-delta", text: "CI failed, fixing." });
  push.observe(chatId, { type: "turn-completed" });
  await push.settled();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].body, "CI failed, fixing.");
});

// A heartbeat that fails again after a failed beat is marked quiet too: one push for a broken heartbeat, not one per beat.
test("a quiet failed turn sends no push; a failed turn without quiet sends one", async (t) => {
  const { push, messages } = await fixture(t);
  await push.register(registration());
  push.observe(chatId, { type: "turn-started", turnId: "beat-1" });
  push.observe(chatId, { type: "turn-failed", message: "Claude Code isn't installed.", quiet: true });
  await push.settled();
  assert.equal(messages.length, 0);
  push.observe(chatId, { type: "turn-started", turnId: "beat-2" });
  push.observe(chatId, { type: "turn-failed", message: "Claude Code isn't installed." });
  await push.settled();
  assert.equal(messages.length, 1);
});
