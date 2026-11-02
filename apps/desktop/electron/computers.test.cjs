const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { boxKeyPair, b64url, hostAccept } = require("@milagre/shared/relay-crypto");
const { createFrameReader, createFrameWriter } = require("@milagre/shared/peer-frames");
const { createComputers } = require("./computers.cjs");
const { thisComputer, ThisComputer } = require("@milagre/shared/host-computer");

const OWN = "o".repeat(22);
const HOST = "h".repeat(22);
const keychain = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(text, "utf8").map((byte) => byte ^ 0x5a),
  decryptString: (bytes) =>
    Buffer.from(bytes)
      .map((byte) => byte ^ 0x5a)
      .toString("utf8"),
};
const link = ({ relay = "wss://relay.milagre.cloud", host = HOST, name = "studio" } = {}) =>
  `milagre://pair?relay=${encodeURIComponent(relay)}&host=${host}&key=${"k".repeat(43)}&token=${"a".repeat(64)}&name=${encodeURIComponent(name)}`;

async function setup(t, { saved } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "computers-"));
  // A write that was in flight when the test ended may land after the first attempt; rm tries again.
  t.after(() => fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  if (saved) await fs.writeFile(path.join(dataDir, "computers.json"), JSON.stringify(saved), { mode: 0o600 });
  const changes = [];
  const computers = createComputers({
    dataDir,
    safeStorage: keychain,
    name: () => "desk",
    ownHostId: async () => OWN,
    onChange: (list) => changes.push(list),
    networkMs: 60_000,
  });
  t.after(() => computers.close());
  return { dataDir, computers, changes };
}
const studio = { id: "c1", hostId: HOST, name: "studio", relay: "wss://relay.milagre.cloud", lanRoutes: [], addedAt: 1, lastSeen: 1 };

test("a relay link previews as the computer it names and how it is reached, without its token", async (t) => {
  const { computers } = await setup(t);
  assert.deepEqual(await computers.preview(link()), { name: "studio", hostId: HOST, relayHost: "relay.milagre.cloud" });
});

test("a pasted link that isn't a relay link, this Mac's own, or a computer already added, is refused before any socket opens", async (t) => {
  const { computers } = await setup(t, { saved: [studio] });
  await assert.rejects(computers.preview("hello"), { message: "That isn't a Milagre pairing link. Copy it from Settings › Devices on the other computer." });
  await assert.rejects(computers.preview(link({ relay: "ws://127.0.0.1:9000" })), /isn't a Milagre pairing link/);
  await assert.rejects(computers.preview(`milagre://pair?address=${encodeURIComponent("https://mac.example.com")}&token=${"a".repeat(64)}&name=x`), {
    message: "This link reaches its computer through a Cloudflare tunnel, which computers can't use yet.",
  });
  await assert.rejects(computers.preview(link({ host: OWN })), { message: `That's ${thisComputer}'s own link. Copy the one on the other computer.` });
  await assert.rejects(computers.preview(link({ name: "anything" })), { message: "studio is already in your computers." });
  await assert.rejects(computers.add(link()), { message: "studio is already in your computers." });
});

test("saved computers are off until Other computers is on, and one whose keys are gone says so and stops", async (t) => {
  const { computers } = await setup(t, { saved: [studio] });
  await computers.loaded;
  assert.deepEqual(
    computers.list().map((computer) => [computer.name, computer.state, computer.route]),
    [["studio", "off", null]],
  );
  await computers.setEnabled(true);
  for (let i = 0; i < 200 && computers.list()[0].state !== "refused"; i++) await delay(5);
  assert.deepEqual(computers.list()[0].state, "refused");
  assert.equal(computers.list()[0].message, `${ThisComputer} lost its keys for studio. Remove it and pair again.`);
  await assert.rejects(computers.invoke("c1", "daemon:status"), /studio is offline/);
  await computers.setEnabled(false);
  assert.equal(computers.list()[0].state, "off");
});

test("a computer is renamed here only, and removed with its keys", async (t) => {
  const { dataDir, computers, changes } = await setup(t, { saved: [studio] });
  await computers.rename("c1", "  lab  ");
  assert.equal(computers.list()[0].name, "lab");
  assert.equal(changes.at(-1)[0].name, "lab");
  await assert.rejects(computers.rename("c1", ""), /Give it a name/);
  await computers.remove("c1");
  assert.deepEqual(computers.list(), []);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, "computers.json"), "utf8")), []);
});

// ---- a paired Mac at the other end of in-memory sockets --------------------------------------------------------------

const random = (n) => new Uint8Array(randomBytes(n));
const TOKEN = "a".repeat(64);
const LAN = "ws://192.168.1.5:8798";
const encoder = new TextEncoder();
const STATUS = { version: "9.8.7", methods: ["project:recent"], capabilities: ["desktop-v1", "desktop-peer-v1", "result-pages-v1"] };

/**
 * A Mac as peer-client.test.cjs fakes one, for any number of sockets. `mac.hello` is how the next hello is answered
 * ("accept", "pending" until mac.accept(), "full" or a refusal body) and can change while the desktop is connected.
 * `mac.hold(socket, frame)` returning true keeps that reply back until `mac.release()`.
 */
function fakeMac({ lan = [], hello = "accept" } = {}) {
  const host = boxKeyPair(random);
  const mac = {
    hostKey: b64url(host.publicKey),
    hello,
    lan,
    sockets: [],
    urls: [],
    times: [],
    calls: [],
    focus: [],
    accepts: [],
    held: [],
    hold: null,
    status: STATUS,
    failing: null,
  };
  mac.release = () => mac.held.splice(0).forEach((send) => send());
  mac.accept = () => mac.accepts.splice(0).forEach((accept) => accept());
  mac.drop = () => mac.sockets.forEach((socket) => socket.closeWith(1000));
  mac.push = (event) => mac.open().forEach((socket) => socket.push(event));
  mac.open = () => mac.sockets.filter((socket) => !socket.closed);
  const answer = (frame) => {
    mac.calls.push(frame.method);
    if (frame.method === "daemon:focus") mac.focus.push(frame.args?.[0]?.focused);
    if (frame.method === mac.failing) return { v: 1, id: frame.id, error: { code: "EFAIL", message: "no" } };
    const result =
      frame.method === "daemon:status"
        ? mac.status
        : frame.method === "peer:routes"
          ? { hostId: HOST, key: mac.hostKey, lan: mac.lan }
          : frame.method === "daemon:snapshot"
            ? { snapshotId: "s", pageCount: 1 }
            : frame.method === "daemon:snapshot-page"
              ? JSON.stringify({ eventSeq: 0 })
              : { echo: frame.args };
    return { v: 1, id: frame.id, result };
  };
  mac.createSocket = (url) => {
    mac.urls.push(url);
    mac.times.push(Date.now());
    const reader = createFrameReader("rpc");
    const writer = createFrameWriter("evt");
    let channel = null;
    const target = new EventTarget();
    const socket = {
      url,
      binaryType: "",
      addEventListener: target.addEventListener.bind(target),
      emit(type, event = {}) {
        target.dispatchEvent(Object.assign(new Event(type), event));
      },
      closed: null,
      deliver(bytes) {
        const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        queueMicrotask(() => socket.emit("message", { data }));
      },
      closeWith(code) {
        if (socket.closed) return;
        socket.closed = code;
        queueMicrotask(() => socket.emit("close", { code }));
      },
      close() {
        socket.closeWith(1000);
      },
      push(event) {
        for (const text of writer.write(JSON.stringify({ v: 1, event }))) socket.deliver(channel.sealEncoded(text));
      },
      send(bytes) {
        if (socket.closed) throw new Error("closed");
        if (!channel) {
          const mode = mac.hello;
          if (mode === "full") return socket.closeWith(4429);
          if (typeof mode === "object") return socket.deliver(new Uint8Array([0x04, ...encoder.encode(JSON.stringify({ t: "error", ...mode }))]));
          const accepted = hostAccept({ host, hello: bytes, isKnown: () => false, canPair: true, token: TOKEN, random });
          const accept = () => {
            socket.deliver(accepted.reply);
            channel = accepted.channel;
          };
          if (mode === "pending") {
            mac.accepts.push(accept);
            socket.deliver(new Uint8Array([0x05, ...encoder.encode('{"t":"pending"}')]));
          } else accept();
          return;
        }
        const message = channel.open(bytes);
        if (message.t === "ping") return socket.deliver(channel.seal({ t: "pong" }));
        const read = reader.read(message);
        if (!read) return;
        const reply = () => {
          for (const text of writer.write(JSON.stringify(answer(read.frame)))) socket.deliver(channel.sealEncoded(text));
        };
        if (mac.hold?.(socket, read.frame)) mac.held.push(reply);
        else reply();
      },
    };
    mac.sockets.push(socket);
    queueMicrotask(() => socket.emit("open"));
    return socket;
  };
  return mac;
}

// What a LAN address that answers says to its probe (lan-host.cjs /v1/hello).
const helloAnswer = () => ({ ok: true, json: async () => ({ v: 1, hostId: HOST }) });
const macLink = (mac) => link().replace(`key=${"k".repeat(43)}`, `key=${mac.hostKey}`);

async function until(check, label, ms = 3000) {
  for (let i = 0; i < ms / 5; i++) {
    if (check()) return;
    await delay(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function paired(t, mac, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "computers-"));
  // A write that was in flight when the test ended may land after the first attempt; rm tries again.
  t.after(() => fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const changes = [];
  const events = [];
  const probed = [];
  const computers = createComputers({
    dataDir,
    safeStorage: keychain,
    name: () => "desk",
    ownHostId: async () => OWN,
    createSocket: mac.createSocket,
    fetch: async (url) => {
      probed.push(url);
      return { ok: true, json: async () => ({ v: 1, hostId: HOST }) };
    },
    onChange: (list) => changes.push(list),
    emit: (...event) => events.push(event),
    reconnectMs: 10,
    offlineAfterMs: 120,
    backoffMs: [10],
    networkMs: 60_000,
    ...options,
  });
  t.after(() => computers.close());
  const state = () => computers.list()[0]?.state;
  return { dataDir, computers, changes, events, probed, state };
}

test("pairing saves the computer with its keys sealed, and it connects only once Other computers is on", async (t) => {
  const mac = fakeMac();
  const { dataDir, computers, state } = await paired(t, mac);
  const added = await computers.add(macLink(mac), { name: "  Studio Mac " });
  assert.equal(added.name, "Studio Mac");
  assert.equal(added.state, "off");
  // The pairing channel is closed again, and nothing is connected while the setting is off.
  assert.equal(mac.open().length, 0);
  assert.equal(state(), "off");
  assert.deepEqual(mac.urls, [`wss://relay.milagre.cloud/v1/phone?id=${HOST}`]);
  const saved = await fs.readFile(path.join(dataDir, "computers.json"), "utf8");
  assert.ok(!saved.includes(TOKEN) && !saved.includes(mac.hostKey), "no secret in computers.json");
  const sealed = await fs.readFile(path.join(dataDir, "computer-keys.json"), "utf8");
  assert.ok(!sealed.includes(TOKEN) && !sealed.includes(mac.hostKey), "keys are sealed");
  await computers.setEnabled(true);
  await until(() => state() === "online", "online");
  assert.equal(computers.list()[0].route, "relay");
  assert.deepEqual(await computers.invoke(added.id, "project:recent", [1]), { echo: [1] });
  await computers.setEnabled(false);
  assert.equal(mac.open().length, 0);
  assert.equal(state(), "off");
});

test("adding while Other computers is on uses the pairing channel as the first connection", async (t) => {
  const mac = fakeMac();
  const { computers, state } = await paired(t, mac);
  await computers.setEnabled(true);
  await computers.add(macLink(mac), { name: "studio" });
  await until(() => state() === "online", "online");
  assert.equal(mac.urls.length, 1, "no second socket");
  assert.equal(computers.list()[0].lastSeen > 1, true);
});

test("a Mac holding the first pairing for Allow is waited for, and cancelling saves nothing", async (t) => {
  const mac = fakeMac({ hello: "pending" });
  const { computers } = await paired(t, mac);
  let pending = 0;
  const adding = computers.add(macLink(mac), { name: "studio" }, { onPending: () => pending++ });
  const rejected = assert.rejects(adding, { message: "Cancelled.", code: "cancelled" });
  await until(() => pending === 1, "the pending notice");
  computers.cancelAdd();
  await rejected;
  assert.deepEqual(computers.list(), []);
  // The slot is free again.
  mac.hello = "accept";
  await computers.add(macLink(mac), { name: "studio" });
  assert.equal(computers.list().length, 1);
});

test("a refusal while pairing is worded for pairing, with its code", async (t) => {
  for (const [hello, message, code] of [
    [{ code: "unknown-phone" }, "This link expired. Copy a new one on studio.", "unknown-phone"],
    [{ code: "unknown-phone", reason: "denied" }, `studio didn't allow ${thisComputer}.`, "denied"],
    [{ code: "bad-hello", reason: "kind" }, "Update Milagre on studio to connect.", "kind"],
    ["full", "studio has too many devices connected. Remove one in its Settings › Devices.", "full"],
  ]) {
    const mac = fakeMac({ hello });
    const { computers } = await paired(t, mac);
    await assert.rejects(computers.add(macLink(mac), { name: "studio" }), { message, code });
    assert.deepEqual(computers.list(), []);
  }
});

test("a refusal retrying can't fix stops the computer for good instead of retrying", async (t) => {
  const mac = fakeMac();
  const { computers, state, changes } = await paired(t, mac);
  await computers.setEnabled(true);
  await computers.add(macLink(mac), { name: "studio" });
  await until(() => state() === "online", "online");
  // The owner removed this Mac: the next hello is refused as unknown, and the channel is gone.
  mac.hello = { code: "unknown-phone" };
  mac.drop();
  await until(() => state() === "refused", "refused");
  assert.equal(computers.list()[0].message, "Removed on studio. Pair again with a new link.");
  assert.equal(computers.list()[0].route, null);
  await assert.rejects(computers.invoke(computers.list()[0].id, "project:recent"), /studio is offline/);
  // No more sockets are opened, however long it waits (the runtime retried every 10 ms here).
  const opened = mac.urls.length;
  await delay(150);
  assert.equal(mac.urls.length, opened, "stopped retrying");
  assert.equal(computers.list()[0].state, "refused");
  assert.equal(changes.at(-1)[0].state, "refused");
});

test("every refusal that retrying can't fix refuses, with its words", async (t) => {
  for (const [hello, message] of [
    [{ code: "unknown-phone", reason: "denied" }, `studio didn't allow ${thisComputer}.`],
    [{ code: "bad-token", reason: "reset" }, "studio was reset. Pair again with a new link."],
    [{ code: "bad-token" }, "studio has a new pairing link. Pair again with it."],
    [{ code: "bad-hello", reason: "kind" }, "Update Milagre on studio to connect."],
  ]) {
    const mac = fakeMac();
    const { computers, state } = await paired(t, mac);
    await computers.add(macLink(mac), { name: "studio" });
    mac.hello = hello;
    await computers.setEnabled(true);
    await until(() => state() === "refused", "refused");
    assert.equal(computers.list()[0].message, message);
    const opened = mac.urls.length;
    await delay(60);
    assert.equal(mac.urls.length, opened, "stopped retrying");
    await computers.close();
  }
});

test("a refused computer is paired again from a new link, replacing the old entry", async (t) => {
  const mac = fakeMac();
  const { computers, state } = await paired(t, mac);
  await computers.add(macLink(mac), { name: "studio" });
  const first = computers.list()[0].id;
  mac.hello = { code: "unknown-phone" };
  await computers.setEnabled(true);
  await until(() => state() === "refused", "refused");
  mac.hello = "accept";
  await computers.add(macLink(mac), { name: "studio" });
  assert.equal(computers.list().length, 1);
  assert.notEqual(computers.list()[0].id, first);
  await until(() => state() === "online", "online again");
});

test("a computer that stops answering reads Reconnecting…, then Offline, and comes back", async (t) => {
  const mac = fakeMac();
  const { computers, state } = await paired(t, mac);
  await computers.add(macLink(mac), { name: "studio" });
  await computers.setEnabled(true);
  await until(() => state() === "online", "online");
  mac.hello = "full";
  mac.drop();
  await until(() => state() === "reconnecting", "reconnecting");
  await until(() => computers.list()[0].message !== null, "the reason");
  assert.equal(computers.list()[0].message, "studio has too many devices connected. Remove one in its Settings › Devices.");
  await until(() => state() === "offline", "offline");
  mac.hello = "accept";
  await until(() => state() === "online", "online again");
  assert.equal(computers.list()[0].message, null);
});

test("the LAN is used when the computer gave an address that answers, the relay otherwise, with no outage in the switch", async (t) => {
  const mac = fakeMac({ lan: [LAN] });
  const { computers, changes, state, probed } = await paired(t, mac);
  await computers.add(macLink(mac), { name: "studio" });
  await computers.setEnabled(true);
  await until(() => state() === "online", "online");
  await until(() => computers.list()[0].route === "lan" && state() === "online", "on the LAN");
  assert.equal(computers.list()[0].lan, true);
  assert.deepEqual(computers.list()[0].lanRoutes, [LAN]);
  assert.equal(typeof computers.list()[0].addedAt, "number");
  assert.deepEqual(probed.slice(0, 1), [`${LAN.replace("ws:", "http:")}/v1/hello`]);
  assert.ok(mac.urls.some((url) => url.startsWith(`${LAN}/v1/phone`)));
  // Moving from the relay to the LAN is a switch, not an outage.
  assert.equal(
    changes.some((list) => list[0]?.state === "reconnecting"),
    false,
  );
  // The LAN goes away: back to the relay.
  mac.lan = [];
  for (const socket of mac.sockets.filter((item) => item.url.startsWith(LAN))) socket.closeWith(1000);
  await until(() => computers.list()[0].route === "relay" && state() === "online", "back on the relay");
});

test("a LAN address that doesn't answer doesn't hold a reconnect off the relay, and the runtime moves there once it does", async (t) => {
  const mac = fakeMac({ lan: [LAN] });
  // The saved LAN address is on another network: its probe waits (up to PROBE_TIMEOUT in the app) until the test says.
  let lanAnswers = false;
  const probes = [];
  const { computers, changes, state } = await paired(t, mac, {
    lanWaitMs: 50,
    fetch: () => new Promise((resolve) => (lanAnswers ? resolve(helloAnswer()) : probes.push(() => resolve(helloAnswer())))),
  });
  await computers.add(macLink(mac), { name: "studio" });
  await computers.setEnabled(true);
  await until(() => state() === "online", "online");
  await until(() => probes.length > 0, "the LAN address learned and probed");
  const dropped = Date.now();
  mac.drop();
  await until(() => state() === "reconnecting", "the drop");
  await until(() => state() === "online", "online again over the relay");
  assert.ok(Date.now() - dropped < 1500, `the reconnect didn't wait for the LAN probe: ${Date.now() - dropped}ms`);
  assert.equal(computers.list()[0].route, "relay");
  const seen = changes.length;
  lanAnswers = true;
  for (const reply of probes.splice(0)) reply();
  await until(() => computers.list()[0].route === "lan" && state() === "online", "on the LAN once it answers");
  assert.equal(
    changes.slice(seen).some((list) => list[0]?.state === "reconnecting"),
    false,
    "moving to the LAN is a switch, not an outage",
  );
});

test("the runtime's events are passed on with the computer's id, except its connection state", async (t) => {
  const mac = fakeMac();
  const { computers, events, state } = await paired(t, mac);
  await computers.add(macLink(mac), { name: "studio" });
  await computers.setEnabled(true);
  await until(() => state() === "online", "online");
  const id = computers.list()[0].id;
  mac.push({ channel: "project:state", payload: { path: "/p" }, seq: 1 });
  await until(() => events.some(([, channel]) => channel === "project:state"), "the event");
  assert.deepEqual(
    events.find(([, channel]) => channel === "project:state"),
    [id, "project:state", { path: "/p" }],
  );
  assert.ok(events.every(([, channel]) => channel !== "runtime:connection"));
});

test("a keychain that can't be opened refuses the computer without retrying", async (t) => {
  const mac = fakeMac();
  const { computers, state } = await paired(t, mac, { safeStorage: { ...keychain, isEncryptionAvailable: () => false } });
  await assert.rejects(computers.add(macLink(mac), { name: "studio" }), {
    code: "keys",
    message: `${ThisComputer} can't keep keys in its keychain, so it can't pair with computers.`,
  });
  assert.equal(mac.urls.length, 0);
  assert.equal(state(), undefined);
});

test("turning Other computers off cancels a hello in flight and quitting closes every channel", async (t) => {
  const mac = fakeMac();
  const { computers } = await paired(t, mac);
  await computers.add(macLink(mac), { name: "studio" });
  mac.hello = "pending";
  await computers.setEnabled(true);
  await until(() => mac.accepts.length === 1, "a hello waiting for Allow");
  await computers.setEnabled(false);
  assert.equal(mac.open().length, 0);
  await computers.setEnabled(true);
  mac.hello = "accept";
  await until(() => computers.list()[0].state === "online", "online");
  await computers.close();
  assert.equal(mac.open().length, 0);
});

// The runtime moves from the relay to the LAN; its snapshot on the LAN is held back so the test is inside the switch.
const holdLanSnapshot = (mac) => {
  mac.hold = (socket, frame) => socket.url.startsWith(LAN) && frame.method === "daemon:snapshot";
};

test("a call made while the runtime moves to the LAN waits for it and goes through", async (t) => {
  const mac = fakeMac({ lan: [LAN] });
  holdLanSnapshot(mac);
  const { computers, state } = await paired(t, mac);
  await computers.add(macLink(mac), { name: "studio" });
  await computers.setEnabled(true);
  await until(() => mac.held.length === 1, "the runtime to be recovering on the LAN");
  assert.equal(state(), "online");
  const id = computers.list()[0].id;
  let settled = false;
  const called = computers.invoke(id, "project:recent", ["x"]).finally(() => (settled = true));
  await delay(40);
  assert.equal(settled, false, "the call waits for the switch");
  mac.hold = null;
  mac.release();
  assert.deepEqual(await called, { echo: ["x"] });
  assert.equal(computers.list()[0].route, "lan");
  // Its dev servers answer on the IP the LAN route dialed: the desktop links them there.
  assert.equal(computers.list()[0].address, new URL(LAN).hostname);
});

test("a switch whose recovery fails reads Reconnecting… and the call waiting on it goes through once it is back", async (t) => {
  const mac = fakeMac({ lan: [LAN] });
  holdLanSnapshot(mac);
  const { computers, changes, state } = await paired(t, mac);
  await computers.add(macLink(mac), { name: "studio" });
  await computers.setEnabled(true);
  await until(() => mac.held.length === 1, "the runtime to be recovering on the LAN");
  const id = computers.list()[0].id;
  const seen = changes.length;
  const called = computers.invoke(id, "project:recent", ["x"]);
  mac.hold = null;
  mac.held.length = 0;
  for (const socket of mac.sockets.filter((item) => item.url.startsWith(LAN))) socket.closeWith(1006);
  await until(() => changes.slice(seen).some((list) => list[0]?.state === "reconnecting"), "the failed switch is not swallowed as part of the switch");
  await until(() => state() === "online", "back online");
  assert.deepEqual(await called, { echo: ["x"] });
});

test("a call made while a computer reconnects waits for it instead of failing as offline, and fails once it is offline", async (t) => {
  const mac = fakeMac();
  const lines = [];
  const { computers, state } = await paired(t, mac, { offlineAfterMs: 300, log: (line) => lines.push(line) });
  await computers.add(macLink(mac), { name: "studio" });
  await computers.setEnabled(true);
  await until(() => state() === "online", "online");
  const id = computers.list()[0].id;
  mac.hello = "full";
  mac.drop();
  await until(() => state() === "reconnecting", "reconnecting");
  let settled = false;
  const called = computers.invoke(id, "project:recent", ["x"]).finally(() => (settled = true));
  await delay(40);
  assert.equal(settled, false, "the call waits for the reconnect");
  mac.hello = "accept";
  assert.deepEqual(await called, { echo: ["x"] });
  assert.ok(
    lines.some((line) => / studio reconnecting from relay: \S/.test(line)) && lines.some((line) => / studio online relay/.test(line)),
    lines.join("\n"),
  );

  mac.hello = "full";
  mac.drop();
  await until(() => state() === "reconnecting", "reconnecting again");
  const waiting = assert.rejects(computers.invoke(id, "project:recent"), /studio is offline/);
  await until(() => state() === "offline", "offline");
  await waiting;
});

test("a computer whose first calls fail keeps no channel open between its retries", async (t) => {
  const mac = fakeMac();
  mac.status = { ...STATUS, capabilities: [...STATUS.capabilities, "state-patches-v1"] };
  const { computers } = await paired(t, mac);
  await computers.add(macLink(mac), { name: "studio" });
  mac.failing = "daemon:state-patches";
  await computers.setEnabled(true);
  let most = 0;
  for (let i = 0; i < 400 && mac.urls.length < 4; i++) {
    most = Math.max(most, mac.open().length);
    await delay(5);
  }
  assert.ok(mac.urls.length >= 4, "it kept retrying");
  assert.ok(most <= 1, `at most the channel being tried is open, saw ${most}`);
  await computers.setEnabled(false);
  assert.equal(mac.open().length, 0);
});

test("a computer that keeps refusing is dialed less and less often, and a connection starts it over", async (t) => {
  const mac = fakeMac();
  const steps = [150, 300, 600];
  const { computers, state } = await paired(t, mac, { backoffMs: steps, reconnectMs: 5, offlineAfterMs: 60_000 });
  await computers.add(macLink(mac), { name: "studio" });
  await computers.setEnabled(true);
  await until(() => state() === "online", "online");
  const failAndCount = async (dials) => {
    const from = mac.urls.length;
    mac.hello = "full";
    mac.drop();
    await until(() => mac.urls.length >= from + dials, `${dials} dials`);
    return mac.times.slice(from - 1, from + dials);
  };
  const [dropped, first, second, third] = await failAndCount(3);
  assert.ok(first - dropped < steps[0], `the first redial is not held back: ${first - dropped}ms`);
  assert.ok(second - first >= steps[0] - 10, `then it waits ${steps[0]}: ${second - first}ms`);
  assert.ok(third - second >= steps[1] - 10, `then ${steps[1]}: ${third - second}ms`);
  assert.equal(state(), "reconnecting");
  // It comes back, and the next trouble starts again at the first step.
  mac.hello = "accept";
  await until(() => state() === "online", "online again", 2000);
  const [lost, again] = await failAndCount(1);
  assert.ok(again - lost < steps[0], `the redial after a success is not held back: ${again - lost}ms`);
  // Turning the computer off ends a wait in progress.
  const started = Date.now();
  await computers.setEnabled(false);
  assert.ok(Date.now() - started < steps[0], "off does not wait out the backoff");
  assert.equal(mac.open().length, 0);
});

test("a keychain that can't be opened for a computer already here is shown and retried, not given up on", async (t) => {
  const mac = fakeMac();
  const first = await paired(t, mac);
  await first.computers.add(macLink(mac), { name: "studio" });
  await first.computers.close();
  // A new launch: the keychain is locked at first.
  let available = false;
  const computers = createComputers({
    dataDir: first.dataDir,
    safeStorage: { ...keychain, isEncryptionAvailable: () => available },
    name: () => "desk",
    createSocket: mac.createSocket,
    fetch: async () => ({ ok: false }),
    reconnectMs: 10,
    offlineAfterMs: 5000,
    backoffMs: [10],
    networkMs: 60_000,
  });
  t.after(() => computers.close());
  await computers.loaded;
  await computers.setEnabled(true);
  const state = () => computers.list()[0].state;
  await until(() => state() === "reconnecting" && computers.list()[0].message !== null, "the keychain's words");
  assert.equal(computers.list()[0].message, `${ThisComputer} can't keep keys in its keychain, so it can't pair with computers.`);
  const opened = mac.urls.length;
  // The keychain comes back (a prompt allowed, the login unlocked): the next retry connects.
  available = true;
  await until(() => state() === "online", "online once the keychain opens");
  assert.equal(mac.urls.length, opened + 1);
  assert.equal(computers.list()[0].message, null);
});

test("a computer whose calls fail after its channel opens is dialed less and less often", async (t) => {
  const mac = fakeMac();
  const steps = [150, 300, 600];
  const { computers, state } = await paired(t, mac, { backoffMs: steps, reconnectMs: 5, offlineAfterMs: 60_000 });
  await computers.add(macLink(mac), { name: "studio" });
  await computers.setEnabled(true);
  await until(() => state() === "online", "online");
  // Every hello is accepted, but the snapshot a reconnect reads fails each time.
  mac.failing = "daemon:snapshot";
  const from = mac.urls.length;
  mac.drop();
  await until(() => mac.urls.length >= from + 3, "three redials");
  const [first, second, third] = mac.times.slice(from, from + 3);
  assert.ok(second - first >= steps[0] - 10, `then it waits ${steps[0]}: ${second - first}ms`);
  assert.ok(third - second >= steps[1] - 10, `then ${steps[1]}: ${third - second}ms`);
  assert.equal(state(), "reconnecting");
  mac.failing = null;
  await until(() => state() === "online", "online again", 3000);
});

test("a call already on the relay when the LAN opens finishes there, and the runtime moves once it is answered", async (t) => {
  const mac = fakeMac({ lan: [LAN] });
  // The relay holds one answer back; the LAN address doesn't answer its probe until the test says so.
  mac.hold = (socket, frame) => !socket.url.startsWith(LAN) && frame.method === "project:recent";
  let lanAnswers = false;
  const { computers, changes, state } = await paired(t, mac, {
    checkEveryMs: 20,
    fetch: async () => ({ ok: lanAnswers, json: async () => ({ v: 1, hostId: HOST }) }),
  });
  await computers.add(macLink(mac), { name: "studio" });
  await computers.setEnabled(true);
  await until(() => state() === "online", "online");
  const id = computers.list()[0].id;
  const slow = computers.invoke(id, "project:recent", ["slow"]);
  await until(() => mac.held.length === 1, "the call to wait on the relay");
  lanAnswers = true;
  await until(() => mac.urls.some((url) => url.startsWith(LAN)), "the LAN channel to open");
  await delay(60);
  assert.equal(computers.list()[0].route, "relay", "no move while a call waits on the relay");
  mac.hold = null;
  mac.release();
  assert.deepEqual(await slow, { echo: ["slow"] });
  await until(() => computers.list()[0].route === "lan", "on the LAN once the relay is free");
  assert.equal(
    changes.some((list) => list[0]?.state === "reconnecting"),
    false,
  );
});

test("the window's focus reaches the computer's daemon, now and after every reconnect, and wins over the runtime's own replay", async (t) => {
  const mac = fakeMac();
  const { computers, state } = await paired(t, mac);
  await computers.add(macLink(mac), { name: "studio" });
  computers.setFocused(true);
  await computers.setEnabled(true);
  await until(() => state() === "online", "online");
  await until(() => mac.focus.at(-1) === true, "focus told after connecting");
  computers.setFocused(false);
  await until(() => mac.focus.at(-1) === false, "blur told");
  computers.setFocused(true);
  await until(() => mac.focus.at(-1) === true, "focus told");
  mac.drop();
  const before = mac.calls.length;
  await until(() => mac.calls.length > before && mac.calls.includes("daemon:snapshot-page") && mac.focus.length > 3, "replayed");
  await delay(50);
  assert.equal(mac.focus.at(-1), true, "the reconnect replays the window's state");
});

test("the first pairing prefers advertised private routes and saves them for reconnects", async (t) => {
  const mac = fakeMac({ lan: [LAN] });
  const { computers, dataDir, state } = await paired(t, mac);
  await computers.setEnabled(true);
  const invitation = macLink(mac) + `&direct=${encodeURIComponent(JSON.stringify([LAN]))}`;
  await computers.add(invitation);
  await until(() => state() === "online", "private computer online");
  assert.ok(mac.urls[0].startsWith(LAN), "the first pairing does not need the relay");
  assert.equal(computers.list()[0].route, "lan");
  assert.equal(computers.list()[0].address, "192.168.1.5");
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, "computers.json"), "utf8"));
  assert.deepEqual(saved[0].lanRoutes, [LAN]);
});
