const test = require("node:test");
const assert = require("node:assert/strict");
const { registerComputers } = require("./computers-ipc.cjs");

const studio = {
  id: "c1",
  name: "studio",
  hostId: "h".repeat(22),
  relayHost: "relay.milagre.cloud",
  state: "online",
  route: "lan",
  lastSeen: 1,
  addedAt: 1,
  message: null,
  lan: true,
  lanRoutes: ["ws://192.168.1.5:8798"],
};

/** ipcMain as computers-ipc.cjs uses it, and a window that records what it is sent. */
function setup(computers, { cache } = {}) {
  const handlers = new Map();
  const sent = [];
  const windowSent = [];
  const sender = { isDestroyed: () => false, send: (channel, payload) => windowSent.push([channel, payload]) };
  const ipc = registerComputers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    computers: { loaded: Promise.resolve(), list: () => [studio], ...computers },
    thisMac: () => "victor-mbp",
    cache,
    send: (channel, payload) => sent.push([channel, payload]),
  });
  const call = (channel, ...args) => handlers.get(channel)({ sender }, ...args);
  return { ipc, call, sent, windowSent, handlers };
}

test("the window reads this Mac's name with the computers, and hears each change", async () => {
  const { ipc, call, sent } = setup({});
  assert.deepEqual(await call("computers:list"), { thisMac: "victor-mbp", computers: [studio] });
  ipc.changed();
  assert.deepEqual(sent, [["computers:changed", { thisMac: "victor-mbp", computers: [studio] }]]);
});

test("adding tells the asking window when the other Mac asks its owner, and a refusal comes back as words and a code", async () => {
  const calls = [];
  const { call, windowSent } = setup({
    async add(link, options, { onPending }) {
      calls.push([link, options]);
      onPending();
      if (link === "bad") throw Object.assign(new Error("studio didn't allow this Mac."), { code: "denied" });
      return studio;
    },
  });
  assert.deepEqual(await call("computers:add", "milagre://pair?x", { name: "Studio" }), { ok: true, computer: studio });
  assert.deepEqual(calls, [["milagre://pair?x", { name: "Studio" }]]);
  assert.deepEqual(windowSent, [["computers:pending", undefined]]);
  assert.deepEqual(await call("computers:add", "bad", {}), { ok: false, code: "denied", message: "studio didn't allow this Mac." });
  assert.deepEqual(await call("computers:add", "plain", { name: 7 }), { ok: true, computer: studio });
  assert.deepEqual(calls.at(-1), ["plain", { name: undefined }], "a name that isn't text is left out");
});

test("a call to a computer goes out without its id and comes back naming it, and its events reach every window named too", async () => {
  const ID = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
  const invoked = [];
  const { ipc, call, sent } = setup({
    invoke: async (id, method, args) => {
      invoked.push([id, method, args]);
      return method === "project:switch" ? { path: "/p", name: "p", state: {} } : null;
    },
  });
  ipc.event(ID, "project:state", { path: "/p" });
  assert.deepEqual(sent, [["computers:event", { computerId: ID, channel: "project:state", payload: { path: `${ID}|/p` } }]]);
  assert.deepEqual(await call("computers:invoke", ID, "project:switch", [`${ID}|/p`]), { path: `${ID}|/p`, name: "p", state: {} });
  await call("computers:invoke", ID, "project:open-at", [`${ID}|/q`, { takeNotice: true }]);
  assert.deepEqual(invoked, [
    [ID, "project:switch", ["/p"]],
    [ID, "project:open", ["/q", { takeNotice: true }]],
  ]);
  await assert.rejects(call("computers:invoke", ID, "project:reveal", ["/p"]), { message: "Not available on a remote computer" });
  assert.equal(invoked.length, 2, "a local-only call never reaches the computer");
});

test("while a computer isn't online, the window's reads come from its cache; anything else says it is offline", async (t) => {
  const fs = require("node:fs/promises");
  const os = require("node:os");
  const path = require("node:path");
  const { createComputerCaches } = require("./computer-cache.cjs");
  const ID = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "computers-ipc-cache-"));
  const cache = createComputerCaches({ dir });
  t.after(async () => {
    cache.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  let state = "online";
  let listed = true;
  const removed = [];
  const { call } = setup(
    {
      list: () => (listed ? [{ ...studio, id: ID, state }] : []),
      invoke: async (_id, method) =>
        method === "project:recent"
          ? [{ path: "/p", name: "p" }]
          : method === "project:switch"
            ? { path: "/p", name: "p", state: { sessions: { 4: { id: 4 } } } }
            : method === "routines:list"
              ? { routines: [{ id: "abcd1234", target: { kind: "chat", chatId: "/p#4" }, runs: [] }] }
              : method === "routines:enabled:read"
                ? { enabled: true }
                : method === "routines:hook"
                  ? { url: "https://secret", signed: false }
                  : null,
      remove: async (id) => void removed.push(id),
    },
    { cache },
  );
  // Online: answers go through, and the lists and states they carry are kept.
  assert.deepEqual(await call("computers:invoke", ID, "project:recent", []), [{ path: `${ID}|/p`, name: "p" }]);
  await call("computers:invoke", ID, "project:switch", [`${ID}|/p`]);
  await call("computers:invoke", ID, "routines:list", []);
  await call("computers:invoke", ID, "routines:enabled:read", []);
  await call("computers:invoke", ID, "routines:hook", [`${ID}|abcd1234`]);
  await call("computers:remember", ID, {
    kind: "chat",
    scope: `${ID}|/p`,
    chatId: 4,
    window: { messages: [{ id: 9, body: "kept" }], hasMore: true, total: 30 },
  });
  await call("computers:remember", ID, { kind: "state", scope: `${ID}|/p`, state: { sessions: { 4: { id: 4, title: "newer" } } } });

  state = "offline";
  assert.deepEqual(await call("computers:invoke", ID, "project:recent", []), [{ path: `${ID}|/p`, name: "p" }]);
  assert.deepEqual(await call("computers:invoke", ID, "project:switch", [`${ID}|/p`]), {
    path: `${ID}|/p`,
    name: "p",
    state: { sessions: { 4: { id: 4, title: "newer" } } },
  });
  assert.deepEqual(await call("computers:invoke", ID, "chat:messages", [`${ID}|/p`, 4, { turns: 20 }]), {
    messages: [{ id: 9, body: "kept" }],
    hasMore: false,
    total: 30,
  });
  assert.deepEqual(
    await call("computers:invoke", ID, "chat:messages", [`${ID}|/p`, 5, { turns: 20 }]),
    { messages: [], hasMore: false, total: 0 },
    "a chat never kept reads empty",
  );
  assert.deepEqual(await call("computers:invoke", ID, "chat:messages", [`${ID}|/p`, 4, { before: 9 }]), { messages: [], hasMore: false, total: 30 });
  assert.deepEqual(await call("computers:invoke", ID, "chat:runs", []), { runs: {}, seq: 0 });
  await assert.rejects(call("computers:invoke", ID, "project:switch", [`${ID}|/never`]), { message: "studio is offline." });
  await assert.rejects(call("computers:invoke", ID, "chat:send", [{ projectPath: `${ID}|/p` }]), { message: "studio is offline." });
  // Its Routines read as last seen; a webhook URL is a secret, never kept, and a change waits for it.
  assert.deepEqual(await call("computers:invoke", ID, "routines:list", []), {
    routines: [{ id: `${ID}|abcd1234`, target: { kind: "chat", chatId: `${ID}|/p#4` }, runs: [] }],
  });
  assert.deepEqual(await call("computers:invoke", ID, "routines:enabled:read", []), { enabled: true });
  await assert.rejects(call("computers:invoke", ID, "routines:targets", []), { message: "studio is offline." });
  await assert.rejects(call("computers:invoke", ID, "routines:hook", [`${ID}|abcd1234`]), { message: "studio is offline." });
  await assert.rejects(call("computers:invoke", ID, "routines:update", [`${ID}|abcd1234`, { enabled: false }]), { message: "studio is offline." });

  // The window paints a chat from its copy while the computer, online, answers: the copy comes back qualified.
  await call("computers:remember", ID, {
    kind: "chat",
    scope: `${ID}|/p`,
    chatId: 7,
    window: { messages: [{ id: 70, body: "kept copy" }], hasMore: true, total: 12 },
  });
  assert.deepEqual(await call("computers:recall", ID, { kind: "chat", scope: `${ID}|/p`, chatId: 7 }), {
    messages: [{ id: 70, body: "kept copy" }],
    hasMore: false,
    total: 12,
  });
  assert.equal(await call("computers:recall", ID, { kind: "chat", scope: `${ID}|/p`, chatId: 8 }), null, "a chat never kept has no copy");
  assert.equal(await call("computers:recall", ID, { kind: "state", scope: `${ID}|/p` }), null, "only chats are recalled");

  await call("computers:remove", ID);
  assert.deepEqual(removed, [ID]);
  assert.equal(cache.get(ID, "recent", ""), null, "its cache went with it");

  // A write the window had held back arrives after Remove: the folder stays gone.
  state = "online";
  listed = false;
  await call("computers:remember", ID, { kind: "chat", scope: `${ID}|/p`, chatId: 4, window: { messages: [], hasMore: false, total: 0 } });
  await call("computers:invoke", ID, "project:recent", []);
  await assert.rejects(fs.stat(path.join(dir, ID)), { code: "ENOENT" });
});

test("a damaged cache file is deleted so it rebuilds, warns once, and never fails the call", async (t) => {
  const fs = require("node:fs/promises");
  const os = require("node:os");
  const path = require("node:path");
  const { createComputerCaches } = require("./computer-cache.cjs");
  const ID = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "computers-ipc-corrupt-"));
  const seed = createComputerCaches({ dir });
  const cache = createComputerCaches({ dir });
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => void warnings.push(args.join(" "));
  t.after(async () => {
    console.warn = original;
    cache.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  seed.put(ID, "recent", "", [{ path: "/p", name: "p" }]);
  seed.close();
  await fs.writeFile(path.join(dir, ID, "cache.sqlite"), Buffer.alloc(4096, 7));
  let state = "offline";
  const { call } = setup({ list: () => [{ ...studio, id: ID, state }], invoke: async () => [{ path: "/p", name: "p" }] }, { cache });
  await assert.rejects(call("computers:invoke", ID, "chat:send", [{}]), { message: "studio is offline." });
  assert.equal(await call("computers:invoke", ID, "chat:messages", [`${ID}|/p`, 1, {}]).then((r) => r.total), 0);
  await call("computers:invoke", ID, "project:recent", []);
  await assert.rejects(fs.stat(path.join(dir, ID, "cache.sqlite")), { code: "ENOENT" }, "the damaged copy was deleted");
  assert.equal(warnings.length, 1, "warned once for this computer and kind of error");
  state = "online";
  await call("computers:invoke", ID, "project:recent", []);
  assert.deepEqual(cache.get(ID, "recent", ""), [{ path: "/p", name: "p" }], "it rebuilds");
});

test("a computer's events reach main's own listener already naming it", () => {
  const ID = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
  const heard = [];
  const handlers = new Map();
  const ipc = registerComputers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    computers: { loaded: Promise.resolve(), list: () => [] },
    thisMac: () => "victor-mbp",
    send: () => {},
    onRemoteEvent: (...event) => heard.push(event),
  });
  ipc.event(ID, "notification:waiting", { chatId: "/p#2", requestId: "q", title: "t", subtitle: "Fix login" });
  assert.deepEqual(heard, [[ID, "notification:waiting", { chatId: `${ID}|/p#2`, requestId: "q", title: "t", subtitle: "Fix login" }]]);
});
