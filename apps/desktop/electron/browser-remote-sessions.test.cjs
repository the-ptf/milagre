const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { clearSignIns, computerPartition, createRemoteBrowserSessions, removeChatPartitions } = require("./browser-remote-sessions.cjs");
const { qualifyKey } = require("@milagre/shared/chat-scopes");
const chatKeyFor = (computerId, project, id) => qualifyKey(computerId, `${project}#${id}`);

function setup({ ports = { studio: 50001 } } = {}) {
  const sessions = new Map();
  const hardened = [];
  const asked = [];
  const remote = createRemoteBrowserSessions({
    fromPartition: (partition) => {
      if (!sessions.has(partition))
        sessions.set(partition, {
          proxies: [],
          closed: 0,
          async setProxy(config) {
            this.proxies.push(config);
          },
          async closeAllConnections() {
            this.closed++;
          },
        });
      return sessions.get(partition);
    },
    proxyPort: async (computerId) => {
      asked.push(computerId);
      if (!ports[computerId]) throw new Error(`${computerId} is offline.`);
      return ports[computerId];
    },
    harden: (session) => hardened.push(session),
  });
  return { remote, sessions, hardened, asked, ports };
}

test("a remote Chat's pages share its computer's session, which goes through that computer's proxy, localhost included", async () => {
  const { remote, sessions, hardened, asked } = setup({ ports: { studio: 50001, santo: 50002 } });
  const key = chatKeyFor("studio", "/Users/v/app", 7);
  const partition = await remote.prepare(key);
  assert.equal(partition, computerPartition("studio"));
  assert.match(partition, /^persist:milagre-browser-computer-[a-f0-9]{24}$/);
  assert.deepEqual(asked, ["studio"]);
  const session = sessions.get(partition);
  assert.deepEqual(session.proxies, [{ proxyRules: "socks5://127.0.0.1:50001", proxyBypassRules: "<-loopback>" }]);
  assert.equal(session.closed, 1);
  assert.deepEqual(hardened, [session]);
  assert.equal(remote.isReady(partition), true);
  assert.equal(await remote.prepare(chatKeyFor("studio", "/Users/v/other", 8)), partition, "another Chat on the computer, the same session");
  assert.equal(session.closed, 1, "the same proxy again keeps the other Chats' connections");
  assert.equal(hardened.length, 1, "a session is hardened once");
  assert.notEqual(await remote.prepare(chatKeyFor("santo", "/Users/v/app", 7)), partition, "another computer, another session");
});

test("a Chat on this Mac, or a computer that can't be reached, gets no routed session", async () => {
  const { remote } = setup();
  await assert.rejects(remote.prepare("/Users/v/app#3"), /this Mac's session/);
  const key = chatKeyFor("santo", "/Users/v/app", 1);
  await assert.rejects(remote.prepare(key), /santo is offline/);
  assert.equal(remote.isReady(computerPartition("santo")), false);
  assert.equal(remote.isReady("persist:milagre-browser"), false);
});

test("a host started again moves every routed session to its new proxy; one it can't route stops attaching", async () => {
  const { remote, sessions, ports } = setup({ ports: { studio: 50001, santo: 50002 } });
  const studio = await remote.prepare(chatKeyFor("studio", "/a", 1));
  const santo = await remote.prepare(chatKeyFor("santo", "/b", 1));
  ports.studio = 50101;
  delete ports.santo;
  await remote.refresh();
  assert.equal(sessions.get(studio).proxies.at(-1).proxyRules, "socks5://127.0.0.1:50101");
  assert.equal(remote.isReady(studio), true);
  assert.equal(remote.isReady(santo), false);
});

test("a host started again with the same ports leaves every session's connections alone", async () => {
  const { remote, sessions } = setup();
  const studio = await remote.prepare(chatKeyFor("studio", "/a", 1));
  await remote.refresh();
  assert.equal(sessions.get(studio).closed, 1);
});

test("the per-Chat sessions of the build before are removed, and nothing else", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-partitions-"));
  const folder = path.join(userData, "Partitions");
  const names = [
    "milagre-browser",
    "milagre-browser-chat-0123456789abcdef01234567",
    "milagre-browser-computer-0123456789abcdef01234567",
    "milagre-browser-chat-x",
  ];
  for (const name of names) fs.mkdirSync(path.join(folder, name, "Cookies"), { recursive: true });
  await removeChatPartitions(userData);
  assert.deepEqual(fs.readdirSync(folder).sort(), ["milagre-browser", "milagre-browser-chat-x", "milagre-browser-computer-0123456789abcdef01234567"]);
  await removeChatPartitions(path.join(userData, "missing"));
  fs.rmSync(userData, { recursive: true, force: true });
});

test("clearing sign-ins empties the session and reloads only its own open pages", async () => {
  const calls = [];
  const session = {
    clearStorageData: async () => calls.push("storage"),
    clearAuthCache: async () => calls.push("auth"),
    clearCache: async () => calls.push("cache"),
    closeAllConnections: async () => calls.push("connections"),
  };
  const page = (own, destroyed = false) => ({
    session: own ? session : {},
    isDestroyed: () => destroyed,
    reloaded: 0,
    reload() {
      this.reloaded++;
    },
  });
  const guests = [page(true), page(false), page(true, true)];
  await clearSignIns(/** @type {any} */ (session), /** @type {any} */ (guests));
  assert.deepEqual(calls, ["storage", "auth", "cache", "connections"]);
  assert.deepEqual(
    guests.map((guest) => guest.reloaded),
    [1, 0, 0],
  );
});
