const { test } = require("node:test");
const assert = require("node:assert/strict");
const { b64url } = require("@milagre/shared/relay-crypto");
const { startTestMac, connectDesktop, connectPhone, until } = require("./relay-test-kit.cjs");

const PIECE = 512 * 1024;

test("a first desktop pairs over the private route with owner approval", async (t) => {
  const mac = await startTestMac(t);
  const status = await mac.client.call("phone:status");
  const option = status.pairingOptions.find((entry) => entry.id === "private");
  assert.ok(option, "Settings offers a private pairing link");
  const { parsePairing } = require("@milagre/shared/pairing-link");
  const pairing = parsePairing(option.link, { allowLocalRelay: true });
  assert.ok(pairing.relay.url.startsWith("ws://127.0.0.1:"));
  const desktop = mac.dial(connectDesktop, { relayUrl: pairing.relay.url, name: "Direct Mac" });
  assert.ok((await desktop.hello()).channel);
  assert.equal((await desktop.call("daemon:status")).result.version, "9.8.7");
  assert.equal((await mac.client.call("devices:list"))[0].route, "lan");
});

/** Waits for `promise`, failing the test instead of hanging the suite when it never settles. */
function within(promise, label, ms = 10_000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** True when every 512 KiB piece boundary of `json`'s UTF-8 bytes (the frame writer's split) falls inside a character. */
function cutsEveryBoundary(json) {
  const bytes = Buffer.from(json);
  const boundaries = [];
  for (let at = PIECE; at < bytes.length; at += PIECE) boundaries.push(at);
  return boundaries.length >= 2 && boundaries.every((at) => (bytes[at] & 0xc0) === 0x80);
}

test("a desktop pairs through the relay in the pairing window and drives this Mac's daemon, except pairing and devices", async (t) => {
  const mac = await startTestMac(t);
  const desktop = mac.dial(connectDesktop, { name: "studio" });
  assert.ok((await desktop.hello()).channel);
  const key = b64url(desktop.key.publicKey);
  // Settings › Devices lists it under Computers.
  assert.deepEqual(
    (await mac.client.call("devices:list")).map((device) => [device.key, device.kind, device.name, device.route]),
    [[key, "computer", "studio", "relay"]],
  );

  const status = (await desktop.call("daemon:status")).result;
  assert.equal(status.version, "9.8.7");
  assert.ok(status.capabilities.includes("desktop-peer-v1"));
  assert.ok(status.methods.includes("project:recent"));
  assert.ok(status.methods.includes("peer:routes"));
  for (const denied of [
    "devices:list",
    "devices:remove",
    "devices:pending",
    "devices:allow",
    "devices:deny",
    "devices:take-notices",
    "devices:confirm-notices",
    "devices:acknowledge",
    "phone:status",
    "phone:open-pairing",
    "push:register",
    "daemon:stop",
  ])
    assert.equal(status.methods.includes(denied), false, denied);
  assert.deepEqual((await desktop.call("devices:remove", [key])).error, { code: "NOT_AVAILABLE_REMOTELY", message: "Not available on a remote computer" });
  assert.equal((await mac.client.call("devices:list")).length, 1, "the refused call removed nothing");
  for (const method of ["devices:pending", "devices:allow", "devices:deny"])
    assert.equal((await desktop.call(method, [key])).error?.code, "NOT_AVAILABLE_REMOTELY", `${method} is the owner's alone`);

  // A change made in this Mac's window reaches the desktop as an event.
  const opened = await mac.client.call("project:open", [mac.project]);
  const chatId = Object.values(opened.state.sessions)[0].id;
  await mac.client.call("chat:patch", [mac.project, chatId, { title: "Set on this Mac" }]);
  await desktop.event("project:state", (payload) => payload.path === mac.project && payload.state?.sessions?.[chatId]?.title === "Set on this Mac");

  // A request and its reply over 768 KiB travel in parts through the relay. Each frame's JSON is built here exactly as it
  // goes on the wire, with an ASCII pad (the chosen k) so that every 512 KiB piece boundary, in the request and in the
  // reply, lands on a UTF-8 continuation byte: the pieces cut characters, whatever the temp folder's path length.
  const id = desktop.frames.filter((frame) => frame.id !== undefined).length + 1; // the desktop's next request id
  const content = "ação" + "🙂".repeat(350_000); // 1.4 MB: boundaries at 512 KiB and 1 MiB
  const requestJson = (value) => JSON.stringify({ v: 1, id, method: "worktree:pull-requests", args: [mac.project, [value]] });
  const replyJson = (value) => JSON.stringify({ v: 1, id, result: [value] });
  let big;
  for (let k = 0; k < 400 && big === undefined; k++) {
    const candidate = "a".repeat(k) + content;
    if (cutsEveryBoundary(requestJson(candidate)) && cutsEveryBoundary(replyJson(candidate))) big = candidate;
  }
  assert.ok(big, "a pad length that cuts a character at every piece boundary of both frames");
  assert.ok(cutsEveryBoundary(requestJson(big)), "the request's piece boundaries fall inside characters");
  assert.ok(cutsEveryBoundary(replyJson(big)), "the reply's piece boundaries fall inside characters");
  const before = desktop.messages.filter((message) => message.t === "part").length;
  const reply = await desktop.call("worktree:pull-requests", [mac.project, [big]]);
  assert.equal(reply.id, id);
  assert.equal(JSON.stringify(reply), replyJson(big), "the reply frame is the one whose boundaries were checked");
  assert.deepEqual(reply.result, [big]);
  assert.ok(desktop.messages.filter((message) => message.t === "part").length - before >= 3, "the reply came in parts");

  // Phone status changes broadcast phone:status, with the link and its token: none of it reaches the desktop, while an
  // allowed event sent after them does (events arrive in order, so the earlier ones had their chance).
  const heard = [];
  mac.client.on("event", (event) => heard.push(event.channel));
  await mac.client.call("phone:open-pairing");
  await mac.client.call("phone:set-lan", [false]);
  await mac.client.call("phone:set-lan", [true]);
  await mac.client.call("phone:open-pairing");
  await mac.client.call("chat:patch", [mac.project, chatId, { title: "Set after the phone changes" }]);
  await desktop.event("project:state", (payload) => payload.state?.sessions?.[chatId]?.title === "Set after the phone changes");
  await desktop.call("daemon:status");
  // The Mac's own window did hear phone:status in the same stretch, so the desktop's silence is the filter, not a quiet daemon.
  assert.ok(heard.includes("phone:status"), "phone:status was emitted");
  assert.deepEqual(
    desktop.frames.filter((frame) => frame.event?.channel?.startsWith("phone:")),
    [],
  );
  assert.equal(desktop.error, null);
});

test("a paired desktop finds the LAN route over the relay and makes a round trip on it", async (t) => {
  const mac = await startTestMac(t);
  const desktop = mac.dial(connectDesktop);
  assert.ok((await desktop.hello()).channel);
  const reply = await desktop.call("peer:routes");
  const routes = reply.result;
  assert.deepEqual(Object.keys(routes).toSorted(), ["hostId", "key", "lan"]);
  assert.ok(Array.isArray(routes.lan) && routes.lan.every((url) => typeof url === "string" && url.startsWith("ws://")));
  // Field names, not substrings: the key is random base64 and may spell "qr" by chance.
  const names = [];
  JSON.stringify(reply, (name, value) => (names.push(name), value));
  for (const secret of ["token", "link", "qr"])
    assert.equal(
      names.some((name) => name.toLowerCase().includes(secret)),
      false,
      secret,
    );
  const text = JSON.stringify(reply);
  assert.equal(text.includes(mac.token), false, "the pairing token");
  assert.equal(routes.hostId, mac.identity.hostId);
  assert.equal(routes.key, b64url(mac.identity.box.publicKey));
  assert.equal(routes.lan.length, 1);
  assert.match(routes.lan[0], /^ws:\/\/127\.0\.0\.1:\d+$/);
  const lan = mac.dial(connectDesktop, { relayUrl: routes.lan[0], key: desktop.key });
  assert.ok((await lan.hello()).channel);
  assert.equal((await lan.call("daemon:status")).result.version, "9.8.7");
  await until(async () => (await mac.client.call("devices:list"))[0]?.route === "lan", "the device shows on the LAN");
});

test("removing a desktop closes it on the relay and the LAN, and it pairs again only in a window opened later", async (t) => {
  const mac = await startTestMac(t);
  const desktop = mac.dial(connectDesktop, { name: "studio" });
  assert.ok((await desktop.hello()).channel);
  const lanUrl = (await desktop.call("peer:routes")).result.lan[0];
  const lan = mac.dial(connectDesktop, { relayUrl: lanUrl, key: desktop.key });
  assert.ok((await lan.hello()).channel);
  const key = b64url(desktop.key.publicKey);

  await mac.client.call("devices:remove", [key]);
  assert.equal((await within(desktop.closed, "the desktop socket to close")).code, 1000);
  assert.equal((await within(lan.closed, "the lan socket to close")).code, 1000);
  assert.deepEqual(await mac.client.call("devices:list"), []);
  // The window it was removed in is still open; its redial is refused on both routes.
  assert.deepEqual((await mac.dial(connectDesktop, { key: desktop.key }).hello()).error, { t: "error", code: "unknown-phone" });
  assert.deepEqual((await mac.dial(connectDesktop, { relayUrl: lanUrl, key: desktop.key }).hello()).error, { t: "error", code: "unknown-phone" });

  mac.clock.now += 1000;
  await mac.client.call("phone:open-pairing");
  const again = mac.dial(connectDesktop, { key: desktop.key, name: "studio" });
  assert.ok((await again.hello()).channel);
  assert.deepEqual(
    (await mac.client.call("devices:list")).map((device) => [device.key, device.kind]),
    [[key, "computer"]],
  );
});

test("a phone removed while the pairing window is open stays out until a later window, with the real relay host", async (t) => {
  const mac = await startTestMac(t);
  const phone = mac.dial(connectPhone, { name: "Victor's iPhone" });
  assert.ok((await phone.hello()).channel);
  const key = b64url(phone.key.publicKey);
  assert.deepEqual(
    (await mac.client.call("devices:list")).map((device) => [device.key, device.kind, device.name]),
    [[key, "phone", "Victor's iPhone"]],
  );
  await mac.client.call("devices:remove", [key]);
  assert.equal((await within(phone.closed, "the phone socket to close")).code, 1000);
  // Settings › Devices still shows the QR, so the window is open: the phone redials at once and is refused.
  assert.deepEqual((await mac.dial(connectPhone, { key: phone.key }).hello()).error, { t: "error", code: "unknown-phone" });
  mac.clock.now += 1000;
  await mac.client.call("phone:open-pairing");
  assert.ok((await mac.dial(connectPhone, { key: phone.key, name: "Victor's iPhone" }).hello()).channel);
  assert.equal((await mac.client.call("devices:list")).length, 1);
});

test("a new computer waits for Allow, which only this Mac's window hears; Deny saves nothing, and a late Allow finds nothing", async (t) => {
  const mac = await startTestMac(t, { autoAllow: false });
  const heard = [];
  mac.client.on("event", ({ channel, payload }) => {
    if (channel === "devices:pending") heard.push(payload.requests);
  });
  const waitingFor = (key) => until(() => heard.at(-1)?.some((request) => request.key === key), "the window to hear the request");

  // A computer the owner allows.
  const known = mac.dial(connectDesktop, { name: "known" });
  const knownHello = known.hello({ ms: 10_000 });
  const knownKey = b64url(known.key.publicKey);
  await waitingFor(knownKey);
  await until(() => known.notices.length > 0, "the waiting notice");
  assert.deepEqual(await mac.client.call("devices:list"), [], "nothing saved before Allow");
  await mac.client.call("devices:allow", [knownKey]);
  assert.ok((await knownHello).channel);

  // Another asks: the window hears it, the computer already connected doesn't, and it can't answer for this Mac.
  const studio = mac.dial(connectDesktop, { name: "studio" });
  const studioHello = studio.hello({ ms: 10_000 });
  const studioKey = b64url(studio.key.publicKey);
  await waitingFor(studioKey);
  assert.deepEqual(
    (await mac.client.call("devices:pending")).map((request) => [request.key, request.name]),
    [[studioKey, "studio"]],
  );
  assert.deepEqual((await known.call("devices:allow", [studioKey])).error, { code: "NOT_AVAILABLE_REMOTELY", message: "Not available on a remote computer" });
  await known.call("daemon:status");
  assert.deepEqual(
    known.frames.filter((frame) => frame.event?.channel?.startsWith("devices:")),
    [],
  );
  await mac.client.call("devices:deny", [studioKey]);
  assert.deepEqual(await studioHello, { error: { t: "error", code: "unknown-phone", reason: "denied" } });
  assert.deepEqual(
    (await mac.client.call("devices:list")).map((device) => device.key),
    [knownKey],
  );

  // One that leaves before the owner answers: its request goes, and Allow afterwards changes nothing.
  const late = mac.dial(connectDesktop, { name: "late" });
  void late.hello({ ms: 2000 }).catch(() => {});
  const lateKey = b64url(late.key.publicKey);
  await waitingFor(lateKey);
  late.close();
  await until(() => heard.at(-1)?.length === 0, "the request to go");
  await assert.rejects(mac.client.call("devices:allow", [lateKey]), /no longer waiting/);
  assert.equal((await mac.client.call("devices:list")).length, 1);
});

test("a paired desktop reads and manages this Mac's Routines, and hears them change", async (t) => {
  const mac = await startTestMac(t);
  const desktop = mac.dial(connectDesktop);
  assert.ok((await desktop.hello()).channel);
  const status = (await desktop.call("daemon:status")).result;
  for (const method of ["routines:list", "routines:create", "routines:update", "routines:delete", "routines:hook"])
    assert.ok(status.methods.includes(method), method);
  assert.equal((await desktop.call("routines:list")).error, undefined);
  // A Routine made in this Mac's window reaches the desktop as routines:changed. An older desktop saving the old switch
  // changes nothing: this Mac runs Routines.
  await mac.client.call("project:open", [mac.project]);
  await mac.client.call("routines:create", [
    {
      name: "Daily",
      prompt: "Look",
      trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" },
      target: { kind: "new-chat", projectPath: mac.project, workspace: "project" },
    },
  ]);
  await within(
    desktop.event("routines:changed", () => true),
    "routines:changed",
  );
  assert.deepEqual((await desktop.call("routines:enabled:save", [false])).result, { enabled: true });
  assert.deepEqual(await mac.client.call("routines:enabled:read"), { enabled: true });
  assert.equal(desktop.error, null);
});

test("a paired desktop receives live usage while provider account changes are refused", async (t) => {
  const unavailable = (provider) => async () => ({ provider, status: "unavailable", windows: [] });
  const mac = await startTestMac(t, {
    runtime: {
      agentCli: async () => ({ problem: "Provider CLI unavailable in this fixture" }),
      usageReaders: { claude: unavailable("claude"), codex: unavailable("codex"), antigravity: unavailable("antigravity") },
    },
  });
  const desktop = mac.dial(connectDesktop, { name: "Usage viewer" });
  await desktop.hello();
  await mac.client.call("project:open", [mac.project]);
  // A first usage read is slow under a full suite's load: 15 s here, the kit's 5 s everywhere else.
  const changed = desktop.event("usage:changed", (payload) => payload.scopeKey === mac.project, 15_000);
  const fresh = await desktop.call("usage:read", [mac.project], 15_000);
  assert.equal(fresh.error, undefined);
  assert.ok(fresh.result.accountKey);
  await within(changed, "remote usage signal", 15_000);
  const cached = await desktop.call("usage:cached", [mac.project]);
  assert.equal(cached.result.accountKey, fresh.result.accountKey);
  for (const method of ["accounts:add", "accounts:select", "accounts:login", "accounts:cancel", "accounts:remove", "accounts:assign", "chat:limit-switch"])
    assert.equal((await desktop.call(method, [mac.project, "claude", "default"])).error?.code, "NOT_AVAILABLE_REMOTELY", method);
});

test("a paired desktop opens TCP streams from the computer, over the relay and the LAN, and reaches its localhost", async (t) => {
  const http = require("node:http");
  const { boxKeyPair } = require("@milagre/shared/relay-crypto");
  const { connectPeer } = require("./peer-client.cjs");
  const { random, listen } = require("./relay-test-kit.cjs");
  // A dev server on the computer's loopback only, as `npm run dev` binds it.
  const page = "<!doctype html><title>Checkout</title>".padEnd(300_000, "x");
  const server = http.createServer((_request, response) => response.end(page));
  const port = await listen(server);
  t.after(() => server.close());
  const mac = await startTestMac(t);
  const key = boxKeyPair(random);
  const peer = (url) =>
    connectPeer({ url, hostId: mac.identity.hostId, hostKey: b64url(mac.identity.box.publicKey), token: mac.token, identity: key, name: "studio" });
  const fetchThrough = async (client) => {
    const stream = await client.openStream("127.0.0.1", port);
    const chunks = [];
    const done = new Promise((resolve, reject) => {
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", resolve);
      stream.on("error", reject);
    });
    stream.end("GET / HTTP/1.0\r\nHost: localhost\r\n\r\n");
    await within(done, "the page through the stream");
    return Buffer.concat(chunks).toString();
  };
  const relayed = await within(peer(mac.relay.url), "the desktop over the relay");
  t.after(() => relayed.close());
  assert.ok(relayed.status.capabilities.includes("peer-tcp-v1"));
  const overRelay = await fetchThrough(relayed);
  assert.match(overRelay, /^HTTP\/1\.1 200/);
  assert.ok(overRelay.endsWith(page), "the whole page, in order");
  await assert.rejects(relayed.openStream("127.0.0.1", 1), { code: "refused" });
  // Daemon calls keep working beside the streams.
  assert.equal((await relayed.call("daemon:status")).version, "9.8.7");

  const routes = await relayed.call("peer:routes");
  const lan = await within(peer(routes.lan[0]), "the desktop on the LAN");
  t.after(() => lan.close());
  assert.ok((await fetchThrough(lan)).endsWith(page));
});

test("a desktop's Browser page for this Mac's Chat is reached back over its channel, by the agent and the phone alike", async (t) => {
  const net = require("node:net");
  const { boxKeyPair } = require("@milagre/shared/relay-crypto");
  const { connectPeer } = require("./peer-client.cjs");
  const { random } = require("./relay-test-kit.cjs");
  const { createCdpProxy } = require("@milagre/core/cdp-proxy");
  // The desktop's real DevTools proxy for its panel pages (cdp-proxy.cjs), on its own loopback, over a stand-in page.
  const pageId = "B".repeat(32);
  const asked = [];
  const proxy = createCdpProxy({
    product: "test",
    pages: () => [{ id: pageId, title: "Checkout", url: "http://localhost:5173/" }],
    session: () => ({
      send: async (method) => {
        asked.push(method);
        return method === "Page.getNavigationHistory" ? { currentIndex: 0, entries: [{ id: 1, url: "http://localhost:5173/", title: "Checkout" }] } : {};
      },
      onEvent: () => () => {},
      release() {},
    }),
  });
  const { port: endpoint, token } = await proxy.start();
  t.after(() => proxy.close());
  const prefix = `/${token}`;
  const mac = await startTestMac(t);
  const elsewhere = net.createServer();
  await new Promise((resolve) => elsewhere.listen(0, "127.0.0.1", resolve));
  t.after(() => elsewhere.close());
  const desktop = await within(
    connectPeer({
      url: mac.relay.url,
      hostId: mac.identity.hostId,
      hostKey: b64url(mac.identity.box.publicKey),
      token: mac.token,
      identity: boxKeyPair(random),
      name: "studio",
      // As computer-service.cjs: only the panel pages' proxy.
      acceptStream: (target, port) => {
        if (target !== "127.0.0.1" || port !== endpoint) throw Object.assign(new Error("no"), { code: "ECONNREFUSED" });
        return net.connect({ host: target, port });
      },
    }),
    "the desktop",
  );
  t.after(() => desktop.close());
  assert.ok(desktop.status.capabilities.includes("peer-panel-pages-v1"));
  const chatId = `${mac.project}#7`;
  await desktop.call("browser:panel-pages", [
    { via: "peer", port: endpoint, prefix, pages: [{ id: pageId, chatId, title: "Checkout", url: "http://localhost:5173/" }] },
  ]);
  const listed = await mac.client.call("browser:list", [{ chatId }]);
  const target = listed.targets.find((item) => item.source === "panel");
  assert.equal(target?.url, "http://localhost:5173/");
  // The Mac's own viewer (as the phone's) opens it: the DevTools session goes back over the desktop's channel.
  const viewer = await within(mac.client.call("browser:open", [{ chatId, targetId: target.id }]), "the viewer");
  assert.ok(viewer.viewerId);
  await until(async () => asked.includes("Page.startScreencast"), "the screencast starts on the desktop's page");
  await mac.client.call("browser:close", [{ viewerId: viewer.viewerId }]);
  // The desktop going takes its pages away.
  desktop.close();
  await until(async () => !(await mac.client.call("browser:list", [{ chatId }])).targets.some((item) => item.source === "panel"), "the page is gone");
});
