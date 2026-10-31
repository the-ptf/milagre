const test = require("node:test");
const assert = require("node:assert/strict");
const { createRemoteBrowserSessions, chatPartition } = require("./browser-remote-sessions.cjs");
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

test("a remote Chat's session goes through its computer's proxy, localhost included, and is its own", async () => {
  const { remote, sessions, hardened, asked } = setup();
  const key = chatKeyFor("studio", "/Users/v/app", 7);
  const partition = await remote.prepare(key);
  assert.equal(partition, chatPartition(key));
  assert.match(partition, /^persist:milagre-browser-chat-[a-f0-9]{24}$/);
  assert.deepEqual(asked, ["studio"]);
  const session = sessions.get(partition);
  assert.deepEqual(session.proxies, [{ proxyRules: "socks5://127.0.0.1:50001", proxyBypassRules: "<-loopback>" }]);
  assert.equal(session.closed, 1);
  assert.deepEqual(hardened, [session]);
  assert.equal(remote.isReady(partition), true);
  assert.notEqual(await remote.prepare(chatKeyFor("studio", "/Users/v/app", 8)), partition, "another Chat, another session");
  await remote.prepare(key);
  assert.equal(hardened.length, 2, "a session is hardened once");
});

test("a Chat on this Mac, or a computer that can't be reached, gets no routed session", async () => {
  const { remote } = setup();
  await assert.rejects(remote.prepare("/Users/v/app#3"), /shared session/);
  const key = chatKeyFor("santo", "/Users/v/app", 1);
  await assert.rejects(remote.prepare(key), /santo is offline/);
  assert.equal(remote.isReady(chatPartition(key)), false);
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
