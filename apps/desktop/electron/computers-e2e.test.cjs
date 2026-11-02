const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { startTestMac, until } = require("../../daemon/src/relay-test-kit.cjs");
const { createComputers } = require("./computers.cjs");
const { thisComputer } = require("@milagre/shared/host-computer");

const keychain = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(text, "utf8").map((byte) => byte ^ 0x5a),
  decryptString: (bytes) =>
    Buffer.from(bytes)
      .map((byte) => byte ^ 0x5a)
      .toString("utf8"),
};

/**
 * This Mac's side: computers.cjs in a folder of its own (never Victor's userData), turned on, dialing with Node's
 * WebSocket. Every test calls it before startTestMac: node:test runs t.after in the order registered, so this Mac stops
 * dialing first, then the daemon closes, then its relay and its folder.
 */
async function desk(t, options = {}) {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "computers-e2e-")));
  const sockets = [];
  const events = [];
  const computers = createComputers({
    dataDir,
    safeStorage: keychain,
    name: () => "desk",
    allowLocalRelay: true,
    reconnectMs: 50,
    networkMs: 60_000,
    createSocket: (url) => {
      sockets.push(url);
      return new WebSocket(url);
    },
    emit: (id, channel, payload) => events.push({ id, channel, payload }),
    ...options,
  });
  t.after(async () => {
    await within(computers.close(), "computers to close");
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await computers.setEnabled(true);
  return { computers, sockets, events, dataDir };
}
const linkOf = async (mac) => (await within(mac.client.call("phone:status"), "phone:status")).pairingLink;
/** Every request list this Mac's window heard (devices:pending), newest last. */
function pendingHeard(mac) {
  const heard = [];
  mac.client.on("event", ({ channel, payload }) => {
    if (channel === "devices:pending") heard.push(payload.requests);
  });
  return heard;
}
const first = (computers) => computers.list()[0];
/** A promise that must settle soon: a pairing that never answers fails the test instead of hanging it. */
const within = (promise, label, ms = 10_000) =>
  Promise.race([promise, delay(ms, undefined, { ref: false }).then(() => Promise.reject(new Error(`Timed out waiting for ${label}`)))]);

test("a connected Mac previews a file shared outside the remote Worktree", async (t) => {
  const { computers } = await desk(t);
  const { demoRuntimeOptions } = require("../../daemon/src/demo-agent.cjs");
  const demo = demoRuntimeOptions();
  let file;
  const mac = await startTestMac(t, {
    lan: false,
    runtime: {
      ...demo,
      createSession: (provider, context) => demoRuntimeOptions({ copy: { ack: "", reply: `[Report](${encodeURI(file)})` } }).createSession(provider, context),
    },
  });
  file = path.join(mac.home, "shared report.md");
  await fs.writeFile(file, "Report shared across computers");
  const added = await computers.add(await linkOf(mac));
  await until(() => first(computers)?.state === "online", "the paired Mac to come online");
  const opened = await computers.invoke(added.id, "project:open", [mac.project]);
  await assert.rejects(computers.invoke(added.id, "attachment:preview", [file]), /attached file|open Worktree/);
  await computers.invoke(added.id, "chat:send", [
    {
      projectPath: mac.project,
      sessionId: Number(Object.keys(opened.state.sessions)[0]),
      body: "Share the report",
      provider: "codex",
      model: "demo",
    },
  ]);
  await until(async () => {
    const messages = await mac.client.call("chat:all-messages", [mac.project]);
    return messages.some((message) => message.role === "assistant" && message.body.includes("[Report]"));
  }, "the assistant to share its report");
  assert.equal((await computers.invoke(added.id, "attachment:preview", [file])).text, "Report shared across computers");
  const chunks = [];
  await require("@milagre/shared/attachment-download").downloadAttachment(
    (offset, version) => computers.invoke(added.id, "attachment:read", version === undefined ? [file, offset] : [file, offset, version]),
    (bytes) => {
      chunks.push(Buffer.from(bytes));
    },
  );
  assert.equal(Buffer.concat(chunks).toString(), "Report shared across computers");
});

test("a new computer waits for Allow, then drives the Mac over the relay and moves to its LAN", async (t) => {
  const { computers, events, dataDir } = await desk(t);
  const mac = await startTestMac(t, { autoAllow: false });
  const heard = pendingHeard(mac);
  const link = await linkOf(mac);
  assert.deepEqual(Object.keys(await within(computers.preview(link), "the preview")).toSorted(), ["hostId", "name", "relayHost"]);
  let told = 0;
  const adding = computers.add(link, { name: "studio" }, { onPending: () => told++ });
  adding.catch(() => {}); // surfaced where it is awaited; a failure before then must not crash the run
  const [request] = await until(() => heard.at(-1)?.length && heard.at(-1), "the Mac's window to hear the request");
  assert.equal(request.name, "desk");
  await until(() => told === 1, "this Mac to hear it waits");
  assert.deepEqual(await within(mac.client.call("devices:list"), "devices:list"), [], "nothing saved before Allow");
  await within(mac.client.call("devices:allow", [request.key]), "devices:allow");
  const added = await within(adding, "the computer to be added");
  assert.equal(added.name, "studio");
  await until(() => first(computers)?.state === "online", "online");
  assert.equal((await computers.invoke(added.id, "daemon:status")).version, "9.8.7");

  // peer:routes taught it the Mac's LAN address; the supervisor moves the runtime there.
  await until(() => first(computers).route === "lan", "the LAN route");
  assert.equal(first(computers).lan, true);
  assert.equal((await computers.invoke(added.id, "daemon:status")).version, "9.8.7");
  await until(async () => (await within(mac.client.call("devices:list"), "devices:list"))[0]?.route === "lan", "the Mac to see it on the LAN");

  // A change made on the Mac reaches this desktop's runtime as an event.
  // The window opens the project on the computer, as it would; the Mac's own window opens it too.
  await within(computers.invoke(added.id, "project:open", [mac.project]), "project:open on the computer");
  const opened = await within(mac.client.call("project:open", [mac.project]), "project:open");
  // A maximum-size image crosses the paired transport in bounded chunks, then comes back in result pages.
  const { uploadAttachment } = require("@milagre/shared/attachment-upload");
  const bytes = Buffer.alloc(50 * 1024 * 1024, 42);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  const uploadRequest = { projectPath: mac.project, name: "photo.png", base64: bytes.toString("base64") };
  const upload = () =>
    uploadAttachment(async (part) => {
      const result = await computers.invoke(added.id, "attachment:upload", [part]);
      if (result.error) throw new Error(result.error.message);
      return result.file;
    }, uploadRequest);
  const uploaded = await within(upload(), "50 MiB attachment upload", 60000);
  assert.ok(uploaded.path.startsWith(mac.dataDir));
  assert.deepEqual(await fs.readFile(uploaded.path), bytes);
  assert.equal((await within(upload(), "repeated upload", 60000)).path, uploaded.path);
  const media = await within(computers.invoke(added.id, "media:read", [{ scope: mac.project, path: uploaded.path }]), "50 MiB image preview", 60000);
  assert.equal(media.base64, uploadRequest.base64);
  const chatId = Object.values(opened.state.sessions)[0].id;
  // A host sends a scope's first state as `resync` (read it with project:snapshot) and every later change as a patch on
  // it, so one patch sets the baseline and the next one is the change that must arrive.
  const patch = (title) => within(mac.client.call("chat:patch", [mac.project, chatId, { title }]), "chat:patch");
  await patch("Before");
  await until(
    () => events.some((event) => event.id === added.id && event.channel === "project:state" && event.payload?.path === mac.project),
    "the first state event",
  );
  await patch("Set on the Mac");
  await until(
    () =>
      events.some(
        (event) =>
          event.id === added.id &&
          event.channel === "project:state" &&
          event.payload?.path === mac.project &&
          !event.payload.resync &&
          JSON.stringify(event.payload.patch).includes("Set on the Mac"),
      ),
    "the state event carrying the new title",
  );

  // The token and the Mac's key are sealed in computer-keys.json; computers.json has neither.
  const saved = await fs.readFile(path.join(dataDir, "computers.json"), "utf8");
  assert.deepEqual(
    JSON.parse(saved).map((computer) => [computer.name, computer.hostId]),
    [["studio", mac.identity.hostId]],
  );
  for (const file of ["computers.json", "computer-keys.json"])
    assert.equal((await fs.readFile(path.join(dataDir, file), "utf8")).includes(mac.token), false, file);
});

test("Deny, and a link whose window closed, turn the computer away and save nothing on either Mac", async (t) => {
  const { computers } = await desk(t);
  const mac = await startTestMac(t, { autoAllow: false });
  const heard = pendingHeard(mac);
  const link = await linkOf(mac);
  const { name } = await within(computers.preview(link), "the preview");
  const adding = computers.add(link, { name: "studio" });
  adding.catch(() => {});
  const [request] = await until(() => heard.at(-1)?.length && heard.at(-1), "the request");
  await within(mac.client.call("devices:deny", [request.key]), "devices:deny");
  await assert.rejects(within(adding, "Deny to turn the computer away"), { message: `${name} didn't allow ${thisComputer}.` });
  assert.deepEqual(computers.list(), []);
  assert.deepEqual(await within(mac.client.call("devices:list"), "devices:list"), []);
  mac.clock.now += 11 * 60_000;
  await assert.rejects(within(computers.add(link, { name: "studio" }), "the expired link to be refused"), {
    message: `This link expired. Copy a new one on ${name}.`,
  });
  assert.deepEqual(computers.list(), []);
});

test("a computer removed on the Mac it drives stops dialing and says so", async (t) => {
  const { computers, sockets } = await desk(t);
  const mac = await startTestMac(t, { lan: false });
  const added = await within(computers.add(await linkOf(mac), { name: "studio" }), "the computer to be added");
  await until(() => first(computers)?.state === "online", "online");
  const [device] = await within(mac.client.call("devices:list"), "devices:list");
  await within(mac.client.call("devices:remove", [device.key]), "devices:remove");
  await until(() => first(computers)?.state === "refused", "refused");
  assert.equal(first(computers).message, "Removed on studio. Pair again with a new link.");
  const dialed = sockets.length;
  await delay(500);
  assert.equal(sockets.length, dialed, "no more hellos");
  await assert.rejects(within(computers.invoke(added.id, "daemon:status"), "the refused computer to answer"), /studio is offline/);
});

test("a computer whose relay drops reads Reconnecting, comes back by itself and reads the Mac's state again", async (t) => {
  const states = [];
  const { computers, events } = await desk(t, { onChange: (list) => states.push(list[0]?.state) });
  const mac = await startTestMac(t, { lan: false });
  await within(computers.add(await linkOf(mac), { name: "studio" }), "the computer to be added");
  await until(() => first(computers)?.state === "online", "online");
  const snapshots = () => events.filter((event) => event.channel === "runtime:snapshot").length;
  const before = snapshots();
  mac.relay.hostSockets.at(-1).terminate();
  await until(() => states.includes("reconnecting"), "reconnecting");
  await until(() => first(computers).state === "online" && snapshots() > before, "back online with a fresh snapshot", 10_000);
  assert.equal(first(computers).route, "relay");
});

test("the window's routing drives a real Mac: its Project and chats named by computer, events, and its cache once away", async (t) => {
  const { registerComputers } = require("./computers-ipc.cjs");
  const { createComputerCaches } = require("./computer-cache.cjs");
  const forwarded = [];
  // computers.cjs emits into the IPC once it exists; desk() builds computers first, so the hook reads a late binding.
  let ipc = null;
  const { computers, dataDir } = await desk(t, { emit: (id, channel, payload) => ipc?.event(id, channel, payload) });
  const cache = createComputerCaches({ dir: path.join(dataDir, "computers") });
  t.after(() => cache.close());
  const handlers = new Map();
  ipc = registerComputers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    computers,
    thisMac: () => "desk",
    send: (channel, payload) => forwarded.push({ channel, payload }),
    cache,
  });
  const call = (channel, ...args) => within(handlers.get(channel)({ sender: { isDestroyed: () => false, send() {} } }, ...args), channel);
  const mac = await startTestMac(t, { lan: false });
  const added = await within(computers.add(await linkOf(mac), { name: "studio" }), "the computer to be added");
  await until(() => first(computers)?.state === "online", "online");
  const id = added.id;
  const projectKey = `${id}|${mac.project}`;

  const opened = await call("computers:invoke", id, "project:open-at", [projectKey]);
  assert.equal(opened.path, projectKey, "the Project's path names its computer");
  const recent = await call("computers:invoke", id, "project:recent", []);
  assert.ok(recent.some((project) => project.path === projectKey));
  const chatId = Object.values(opened.state.sessions)[0].id;

  await call("computers:invoke", id, "chat:patch", [projectKey, chatId, { title: "Named from the desk" }]);
  const onMac = await within(mac.client.call("project:open", [mac.project]), "project:open on the Mac");
  assert.equal(onMac.state.sessions[chatId].title, "Named from the desk", "the patch reached the Mac with its own path");
  await until(
    () =>
      forwarded.some(
        ({ channel, payload }) =>
          channel === "computers:event" && payload.computerId === id && payload.channel === "project:state" && payload.payload?.path === projectKey,
      ),
    "a state event naming the computer",
  );
  const reread = await call("computers:invoke", id, "project:read", [projectKey]);
  assert.equal(reread.state.sessions[chatId].title, "Named from the desk");
  // The window forwards the scope's whole state as it changes (offline-cache.ts); that is what the cache keeps.
  const remembered = structuredClone(reread.state);
  remembered.sessions[chatId].title = "Remembered by the window";
  await call("computers:remember", id, { kind: "state", scope: projectKey, state: remembered });
  const page = await call("computers:invoke", id, "chat:messages", [projectKey, chatId, { turns: 20 }]);
  assert.ok(Array.isArray(page.messages));
  await call("computers:remember", id, {
    kind: "chat",
    scope: projectKey,
    chatId,
    window: { messages: [{ id: 1, session_id: chatId, role: "user", body: "kept here" }], hasMore: false, total: 1 },
  });

  // Its folders, from its own home: the Project's folder is listed and already a Project.
  const listing = await within(call("computers:invoke", id, "fs:list-dirs", [{}]), "fs:list-dirs");
  assert.equal(listing.path, mac.home);
  assert.ok(
    listing.entries.some((entry) => entry.name === "project" && entry.project),
    "the opened Project reads as Added",
  );
  await assert.rejects(call("computers:invoke", id, "fs:list-dirs", [{ path: "/etc" }]), /Only folders in the home folder/);

  // An image the chat shows, read through media:read; one outside the Project's roots is refused.
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const shot = path.join(mac.project, ".milagre", "images", "shot.png");
  await fs.mkdir(path.dirname(shot), { recursive: true });
  await fs.writeFile(shot, png);
  const media = await within(call("computers:invoke", id, "media:read", [{ scope: projectKey, path: shot }]), "media:read");
  assert.equal(media.type, "image/png");
  assert.deepEqual(Buffer.from(media.base64, "base64"), png);
  await fs.writeFile(path.join(mac.home, "secret.png"), png);
  await assert.rejects(call("computers:invoke", id, "media:read", [{ scope: projectKey, path: path.join(mac.home, "secret.png") }]), /not available/);

  // Away: not online is all the cache asks, so turning the computer off stands in for it going offline.
  await within(computers.setEnabled(false), "setEnabled(false)");
  assert.ok((await call("computers:invoke", id, "project:recent", [])).some((project) => project.path === projectKey));
  const kept = await call("computers:invoke", id, "project:switch", [projectKey]);
  assert.equal(kept.path, projectKey);
  assert.equal(kept.state.sessions[chatId].title, "Remembered by the window");
  assert.equal((await call("computers:invoke", id, "chat:messages", [projectKey, chatId, { turns: 20 }])).messages[0].body, "kept here");
  const started = Date.now();
  const uncached = await call("computers:invoke", id, "chat:messages", [projectKey, chatId + 99, { turns: 20 }]);
  assert.deepEqual(uncached.messages, [], "a chat with no copy reads empty");
  assert.ok(Date.now() - started < 8000, "and promptly, without waiting on the offline computer");
  await assert.rejects(call("computers:invoke", id, "chat:patch", [projectKey, chatId, { title: "x" }]), { message: "studio is offline." });
  // Opening a remote Project goes only to the computer: this Mac's own recent-projects list is written by its own host.
  await assert.rejects(fs.stat(path.join(dataDir, "recent-projects.json")), { code: "ENOENT" });
  await call("computers:remove", id);
  await assert.rejects(fs.stat(path.join(dataDir, "computers", id)), { code: "ENOENT" });
});
