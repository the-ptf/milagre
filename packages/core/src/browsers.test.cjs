const test = require("node:test");
const assert = require("node:assert/strict");
const { createBrowsers } = require("./browsers.cjs");

const BROWSER = "0b5c2e5e-1111-4222-8333-944444444444";
const OTHER = "0b5c2e5e-1111-4222-8333-955555555555";
const PAGE = "A".repeat(32),
  SECOND = "B".repeat(32),
  FOREIGN = "C".repeat(32);
const DOWN = { kind: "mouse", phase: "down", x: 0.25, y: 0.5, button: "left", clickCount: 1 };

function fixture(t, options = {}) {
  let time = 1000;
  const events = [],
    channels = [];
  const world = {
    // Agent 10 started an MCP server (11) that launched the browser (12). 40 is unrelated.
    processes: [
      { pid: 10, ppid: 1 },
      { pid: 11, ppid: 10 },
      { pid: 12, ppid: 11 },
      { pid: 40, ppid: 1 },
      { pid: 20, ppid: 1 },
    ],
    browsers: [
      {
        id: BROWSER,
        pid: 12,
        product: "Chrome 141",
        pages: [
          { id: PAGE, title: "Login", url: "https://example.com/login" },
          { id: SECOND, title: "Docs", url: "https://example.com/docs" },
        ],
      },
      { id: OTHER, pid: 40, product: "Chrome 141", pages: [{ id: FOREIGN, title: "Mine", url: "https://example.org/" }] },
    ],
  };
  const roots = new Map([
    ["chat-a", { pid: 10 }],
    ["chat-b", { pid: 20 }],
  ]);
  const adapter = {
    discovered: 0,
    async discover() {
      this.discovered++;
      return structuredClone(world);
    },
    async connect(browserId, pageId) {
      const listeners = new Set();
      const channel = {
        browserId,
        pageId,
        closed: false,
        state: { ready: true, width: 800, height: 600, title: "Login", url: "https://example.com/login", canGoBack: false, canGoForward: false },
        latest: null,
        status() {
          return { ...this.state };
        },
        frame() {
          return this.latest;
        },
        onFrame(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        push(data = "jpeg") {
          this.latest = { sequence: (this.latest?.sequence ?? 0) + 1, data, viewport: { width: this.state.width, height: this.state.height } };
          for (const listener of Array.from(listeners)) listener();
        },
        send(event) {
          events.push(structuredClone(event));
        },
        async close() {
          this.closed = true;
        },
      };
      channels.push(channel);
      return channel;
    },
    sessions: [],
    async session(browser, pageId) {
      const session = {
        browser,
        pageId,
        closed: false,
        on: () => () => {},
        send: async () => ({}),
        close() {
          this.closed = true;
        },
      };
      this.sessions.push(session);
      return session;
    },
    async stop() {
      this.stopped = true;
    },
  };
  const service = createBrowsers({ adapter, roots: () => roots, supported: true, now: () => time, frameWaitMs: 50, ...options });
  t.after(() => service.close());
  return {
    service,
    adapter,
    world,
    roots,
    events,
    channels,
    advance: (ms) => {
      time += ms;
    },
  };
}
const target = (id, browser = BROWSER) => `${browser}:${id}`;
test("an execution advisor's browser belongs to its parent Chat", async (t) => {
  const f = fixture(t);
  f.roots.set("chat-a", { pid: 99, agents: [10] });
  const own = await f.service.list({ chatId: "chat-a" });
  assert.ok(own.targets.some((page) => page.id === target(PAGE) && page.source === "agent"));
  const other = await f.service.list({ chatId: "chat-b" });
  assert.ok(!other.targets.some((page) => page.id === target(PAGE)));
  assert.ok(!other.others.some((browser) => browser.id === BROWSER));
});
async function controller(f, owner = "owner-a", chatId = "chat-a", pageId = PAGE) {
  const viewer = await f.service.open({ chatId, targetId: target(pageId) }, owner);
  const status = await f.service.control({ viewerId: viewer.viewerId, takeOver: false }, owner);
  return { ...viewer, ...status, owner };
}
const input = (f, v, event = DOWN, sequence = 1, generation = v.generation) => f.service.input({ viewerId: v.viewerId, sequence, generation, event }, v.owner);

test("a Chat lists only pages of browsers its agent started, never the debugging endpoint", async (t) => {
  const f = fixture(t);
  const list = await f.service.list({ chatId: "chat-a" });
  assert.deepEqual(
    list.targets.map((item) => [item.id, item.title, item.source]),
    [
      [target(PAGE), "Login", "agent"],
      [target(SECOND), "Docs", "agent"],
    ],
  );
  assert.deepEqual(list.others, [{ id: OTHER, browser: "Chrome 141", pages: 1, title: "Mine" }]);
  assert.equal(JSON.stringify(list).includes("pid"), false);
  // Chat B's agent did not start either browser; Chat A's browser is not offered to it either.
  const other = await f.service.list({ chatId: "chat-b" });
  assert.deepEqual(other.targets, []);
  assert.deepEqual(
    other.others.map((item) => item.id),
    [OTHER],
  );
  assert.equal(f.channels.length, 0, "discovery never starts capture");
});

test("lineage is remembered after the agent exits, until the browser itself exits", async (t) => {
  const f = fixture(t);
  await f.service.list({ chatId: "chat-a" });
  f.roots.delete("chat-a");
  f.world.processes = f.world.processes.filter((row) => row.pid !== 10 && row.pid !== 11);
  f.advance(5000);
  assert.equal((await f.service.list({ chatId: "chat-a" })).targets.length, 2);
  f.world.browsers = f.world.browsers.filter((item) => item.id !== BROWSER);
  f.advance(5000);
  await f.service.list({ chatId: "chat-a" });
  f.world.browsers.push({ id: BROWSER, pid: 77, product: "Chrome 141", pages: [] });
  f.advance(5000);
  assert.equal((await f.service.list({ chatId: "chat-a" })).targets.length, 0, "a reused identifier does not inherit old ownership");
});

test("a Chat that can own no page is answered from a recent reading; one that can, and the agent's tool, read afresh", async (t) => {
  const f = fixture(t);
  const tool = require("./chat-browsers.cjs")
    .browserToolDefinitions("chat-a", f.service)
    .find((item) => item.name === "browser_list");
  // Chat Z's agent isn't running, and no browser was attached to it or started by it.
  const first = await f.service.list({ chatId: "chat-z" });
  assert.deepEqual(first.targets, []);
  assert.deepEqual(
    first.others.map((item) => item.id),
    [OTHER],
  );
  assert.equal(f.adapter.discovered, 1);
  // Windows and phones ask every 15 s for each Chat on screen; such Chats take the last reading.
  f.advance(15_000);
  assert.deepEqual(await f.service.list({ chatId: "chat-z" }), first);
  await f.service.list({ chatId: "chat-y" });
  assert.equal(f.adapter.discovered, 1, "no new reading for Chats that own nothing");
  // A Chat whose agent runs reads afresh, through its agent's browser_list too.
  assert.equal(JSON.parse(await tool.run({})).targets.length, 2);
  assert.equal(f.adapter.discovered, 2);
  f.advance(2500);
  await f.service.list({ chatId: "chat-a" });
  assert.equal(f.adapter.discovered, 3);
  // An attached browser makes the Chat one that owns a page.
  f.advance(2500);
  await f.service.attach({ chatId: "chat-z", browserId: OTHER });
  f.advance(2500);
  assert.equal((await f.service.list({ chatId: "chat-z" })).targets.length, 1);
  assert.equal(f.adapter.discovered, 5);
  // Past 30 s even a Chat that owns nothing reads the table again.
  f.advance(30_000);
  await f.service.list({ chatId: "chat-y" });
  assert.equal(f.adapter.discovered, 6);
});

test("attach is explicit, per Chat, and refuses browsers another Chat started", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.service.open({ chatId: "chat-b", targetId: target(FOREIGN, OTHER) }, "owner"), /page/i);
  await assert.rejects(f.service.attach({ chatId: "chat-b", browserId: BROWSER }), /browser/i);
  const attached = await f.service.attach({ chatId: "chat-b", browserId: OTHER });
  assert.deepEqual(
    attached.targets.map((item) => [item.id, item.source]),
    [[target(FOREIGN, OTHER), "attached"]],
  );
  assert.deepEqual(attached.others, []);
  assert.equal((await f.service.list({ chatId: "chat-a" })).others.length, 1, "attachment does not move the browser out of other Chats");
  const viewer = await f.service.open({ chatId: "chat-b", targetId: target(FOREIGN, OTHER) }, "owner");
  assert.equal(viewer.target.title, "Mine");
});

test("detach ends only this Chat's attachment and its viewers of that browser", async (t) => {
  const f = fixture(t);
  await f.service.attach({ chatId: "chat-b", browserId: OTHER });
  await f.service.attach({ chatId: "chat-c", browserId: OTHER });
  const mine = await f.service.open({ chatId: "chat-b", targetId: target(FOREIGN, OTHER) }, "owner-b");
  const theirs = await f.service.open({ chatId: "chat-c", targetId: target(FOREIGN, OTHER) }, "owner-c");
  await assert.rejects(f.service.detach({ chatId: "chat-a", browserId: BROWSER }), /not attached/i, "a browser the agent started is not an attachment");
  await assert.rejects(f.service.detach({ chatId: "chat-b", browserId: BROWSER }), /not attached/i);
  const after = await f.service.detach({ chatId: "chat-b", browserId: OTHER });
  assert.deepEqual(after.targets, []);
  assert.equal(after.others.length, 1, "the browser is offered for attach again");
  await assert.rejects(f.service.status({ viewerId: mine.viewerId }, "owner-b"), /viewer/i, "this Chat's viewer is closed");
  assert.equal((await f.service.status({ viewerId: theirs.viewerId }, "owner-c")).ready, true, "the other Chat's viewer keeps running");
  assert.equal(f.channels[0].closed, false, "the shared capture stays while another viewer uses it");
  assert.equal((await f.service.list({ chatId: "chat-c" })).targets.length, 1, "the other Chat's attachment stays");
  await assert.rejects(f.service.detach({ chatId: "chat-b", browserId: OTHER }), /not attached/i, "detaching twice fails plainly");
});

test("lineage is recorded in the background and ends another Chat's earlier attachment", async (t) => {
  const f = fixture(t, { lineagePollMs: 10 });
  // The browser is not under any agent yet: Chat B attaches it.
  f.world.processes = f.world.processes.map((row) => (row.pid === 11 ? { pid: 11, ppid: 1 } : row));
  await f.service.attach({ chatId: "chat-b", browserId: BROWSER });
  // Its launcher turns out to be Chat A's agent; nobody opens a list.
  f.world.processes = f.world.processes.map((row) => (row.pid === 11 ? { pid: 11, ppid: 10 } : row));
  f.advance(5000);
  for (let i = 0; i < 50 && f.adapter.discovered < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(f.adapter.discovered >= 2, "discovery ran without a list request");
  assert.equal((await f.service.list({ chatId: "chat-b" })).targets.length, 0);
  assert.equal((await f.service.list({ chatId: "chat-a" })).targets.length, 2);
});

test("a page that fails ends a pending frame wait at once", async (t) => {
  const f = fixture(t, { frameWaitMs: 60000 }),
    v = await controller(f);
  const waiting = f.service.frame({ viewerId: v.viewerId, after: 0 }, v.owner);
  await new Promise((resolve) => setImmediate(resolve));
  f.channels[0].state = { ...f.channels[0].state, ready: false, error: "This page closed." };
  f.channels[0].push();
  f.channels[0].latest = null;
  await assert.rejects(waiting, /page closed/);
});

test("every viewer command checks the trusted connection owner", async (t) => {
  const f = fixture(t),
    v = await controller(f);
  for (const [method, extra] of [
    ["status", {}],
    ["frame", { after: 0 }],
    ["control", { takeOver: true }],
    ["input", { event: DOWN, sequence: 1, generation: v.generation }],
    ["closeViewer", {}],
  ]) {
    await assert.rejects(f.service[method]({ viewerId: v.viewerId, ...extra }, "intruder"), /viewer|owner/i);
    await assert.rejects(f.service[method]({ viewerId: "missing", ...extra }, v.owner), /viewer/i);
  }
  assert.equal(f.events.length, 0);
});

test("frames are pulled, newest only, and a wait ends without a frame", async (t) => {
  const f = fixture(t),
    v = await controller(f);
  assert.equal(await f.service.frame({ viewerId: v.viewerId, after: 0 }, v.owner), null);
  const waiting = f.service.frame({ viewerId: v.viewerId, after: 0 }, v.owner);
  await assert.rejects(f.service.frame({ viewerId: v.viewerId, after: 0 }, v.owner), /pending/i);
  f.channels[0].push("one");
  const first = await waiting;
  assert.deepEqual([first.sequence, first.data, first.generation], [1, "one", v.generation]);
  f.channels[0].push("two");
  f.channels[0].push("three");
  assert.equal((await f.service.frame({ viewerId: v.viewerId, after: 1 }, v.owner)).data, "three");
});

test("viewers of one page share a capture; closing the last stops it without closing the page", async (t) => {
  const f = fixture(t);
  const a = await f.service.open({ chatId: "chat-a", targetId: target(PAGE) }, "a");
  const b = await f.service.open({ chatId: "chat-a", targetId: target(PAGE) }, "b");
  assert.equal(f.channels.length, 1);
  await f.service.closeViewer({ viewerId: a.viewerId }, "a");
  assert.equal(f.channels[0].closed, false);
  await f.service.closeViewer({ viewerId: b.viewerId }, "b");
  assert.equal(f.channels[0].closed, true);
  assert.equal(f.events.length, 0, "closing sends nothing to the page");
});

test("takeover releases held input and invalidates the old controller and generation", async (t) => {
  const f = fixture(t),
    a = await controller(f);
  const b = await f.service.open({ chatId: "chat-a", targetId: target(PAGE) }, "owner-b");
  assert.equal((await f.service.control({ viewerId: b.viewerId, takeOver: false }, "owner-b")).controlling, false, "viewing alone never claims control");
  assert.deepEqual(await input(f, a), { accepted: true });
  await input(f, a, { kind: "key", phase: "down", key: "a", code: "KeyA", keyCode: 65, text: "a" }, 2);
  const taken = await f.service.control({ viewerId: b.viewerId, takeOver: true }, "owner-b");
  assert.equal(taken.controlling, true);
  assert.ok(taken.generation > a.generation);
  assert.deepEqual(f.events.slice(-2), [
    { kind: "mouse", phase: "up", x: 0.25, y: 0.5, button: "left", clickCount: 1 },
    { kind: "key", phase: "up", key: "a", code: "KeyA", keyCode: 65 },
  ]);
  assert.deepEqual(await input(f, a, DOWN, 3), { accepted: false });
  const bv = { ...b, ...taken, owner: "owner-b" };
  assert.deepEqual(await input(f, bv, DOWN, 1, a.generation), { accepted: false });
  assert.deepEqual(await input(f, bv), { accepted: true });
});

test("status and control advertise resize support while legacy clients keep their viewport and input", async (t) => {
  const f = fixture(t),
    a = await controller(f);
  assert.equal(a.supportsViewport, true);
  assert.equal((await f.service.status({ viewerId: a.viewerId }, a.owner)).supportsViewport, true);
  // A pre-resize client ignores unknown status fields and sends its original input protocol.
  assert.deepEqual(await input(f, a), { accepted: true });
  assert.deepEqual(await input(f, a, { ...DOWN, phase: "up" }, 2), { accepted: true });
  const b = await f.service.open({ chatId: "chat-a", targetId: target(PAGE) }, "legacy-phone");
  const taken = await f.service.control({ viewerId: b.viewerId, takeOver: true }, "legacy-phone");
  assert.equal(taken.supportsViewport, true);
  assert.deepEqual(await input(f, { ...b, ...taken, owner: "legacy-phone" }, { kind: "text", text: "hello" }), { accepted: true });
  f.channels[0].push();
  assert.deepEqual((await f.service.frame({ viewerId: b.viewerId, after: 0 }, "legacy-phone")).viewport, { width: 800, height: 600 });
  assert.equal(
    f.events.some((event) => event.kind === "viewport"),
    false,
  );
});

test("input rejects malformed events, replays, unmatched buttons and stale viewports", async (t) => {
  const f = fixture(t),
    v = await controller(f);
  for (const event of [
    { ...DOWN, x: 1.5 },
    { ...DOWN, button: "side" },
    { kind: "wheel", x: 0, y: 0, deltaX: 0, deltaY: 1e9 },
    { kind: "text", text: "" },
    { kind: "text", text: "x".repeat(2000) },
    { kind: "key", phase: "down", key: "a".repeat(40), code: "KeyA", keyCode: 65 },
    { kind: "key", phase: "down", key: "a", code: "KeyA", keyCode: 65, commands: ["shutdown"] },
    { kind: "navigate", action: "close" },
    { kind: "viewport", width: 99, height: 600 },
    { kind: "viewport", width: 800, height: 5000 },
    { kind: "viewport", width: 800.5, height: 600 },
    { kind: "eval", script: "1" },
  ]) {
    await assert.rejects(input(f, v, event), /input/i);
  }
  assert.deepEqual(await input(f, v, { ...DOWN, phase: "up" }), { accepted: false }, "no button is held");
  assert.deepEqual(await input(f, v, DOWN, 2), { accepted: true });
  assert.deepEqual(await input(f, v, DOWN, 2), { accepted: false }, "replayed sequence");
  assert.deepEqual(await input(f, v, DOWN, 3), { accepted: false }, "a second press while one is held");
  f.channels[0].state.width = 1024;
  const status = await f.service.status({ viewerId: v.viewerId }, v.owner);
  assert.ok(status.generation > v.generation);
  assert.deepEqual(f.events.at(-1), { kind: "mouse", phase: "up", x: 0.25, y: 0.5, button: "left", clickCount: 1 }, "resize ends the held press");
  assert.deepEqual(await input(f, v, { ...DOWN, phase: "move", button: "none" }, 4), { accepted: false }, "old viewport generation");
  assert.deepEqual(await input(f, v, { kind: "navigate", action: "back" }, 5, status.generation), { accepted: true });
  assert.deepEqual(await input(f, v, { kind: "text", text: "héllo" }, 6, status.generation), { accepted: true });
  assert.deepEqual(await input(f, v, { kind: "viewport", width: 640, height: 480, extra: true }, 7, status.generation), { accepted: true });
  assert.deepEqual(f.events.slice(-3), [
    { kind: "navigate", action: "back" },
    { kind: "text", text: "héllo" },
    { kind: "viewport", width: 640, height: 480 },
  ]);
});

test("input rate is bounded and a flood releases held input", async (t) => {
  const f = fixture(t),
    v = await controller(f);
  let accepted = 0;
  for (let sequence = 1; sequence <= 400; sequence++)
    if ((await input(f, v, { kind: "wheel", x: 0.5, y: 0.5, deltaX: 0, deltaY: 10 }, sequence)).accepted) accepted++;
  assert.ok(accepted <= 240 && accepted > 100);
});

test("a closed page fails its viewers instead of reporting stale status", async (t) => {
  const f = fixture(t),
    v = await controller(f);
  f.channels[0].state = { ...f.channels[0].state, ready: false, error: "This page closed." };
  await assert.rejects(f.service.status({ viewerId: v.viewerId }, v.owner), /page closed/);
  await assert.rejects(f.service.frame({ viewerId: v.viewerId, after: 0 }, v.owner), /page closed/);
  // Reopening replaces the failed capture.
  await f.service.open({ chatId: "chat-a", targetId: target(PAGE) }, "owner-b");
  assert.equal(f.channels.length, 2);
  assert.equal(f.channels[0].closed, true);
});

test("expiry, disconnect and shutdown release viewers and stop captures", async (t) => {
  const f = fixture(t, { viewerTtlMs: 1000 });
  const a = await controller(f);
  await input(f, a);
  f.advance(1500);
  await assert.rejects(f.service.status({ viewerId: a.viewerId }, a.owner), /viewer/i);
  assert.equal(f.channels[0].closed, true);
  assert.deepEqual(f.events.at(-1), { kind: "mouse", phase: "up", x: 0.25, y: 0.5, button: "left", clickCount: 1 });
  const b = await controller(f, "owner-b");
  await f.service.disconnect("owner-b");
  assert.equal(f.channels[1].closed, true);
  await assert.rejects(f.service.status({ viewerId: b.viewerId }, "owner-b"), /viewer/i);
  await controller(f, "owner-c");
  await f.service.close();
  assert.equal(f.channels[2].closed, true);
  assert.equal(f.adapter.stopped, true);
  await assert.rejects(f.service.list({ chatId: "chat-a" }), /closed/);
});

test("a disconnect during open closes the late viewer", async (t) => {
  const f = fixture(t);
  let release;
  const connect = f.adapter.connect.bind(f.adapter);
  f.adapter.connect = async (...args) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    return connect(...args);
  };
  const opening = f.service.open({ chatId: "chat-a", targetId: target(PAGE) }, "gone");
  await new Promise((resolve) => setImmediate(resolve));
  const disconnected = f.service.disconnect("gone");
  release();
  await assert.rejects(opening, /disconnected/);
  await disconnected;
  assert.equal(f.channels[0].closed, true);
});

test("unsupported hosts and invalid requests reach no browser", async (t) => {
  const f = fixture(t, { supported: false });
  assert.deepEqual(await f.service.list({ chatId: "chat-a" }), { supported: false, targets: [], others: [] });
  await assert.rejects(f.service.open({ chatId: "chat-a", targetId: target(PAGE) }, "a"), /supported/);
  assert.equal(f.adapter.discovered, 0);
  const g = fixture(t);
  for (const request of [{}, { chatId: "chat-a", targetId: "ws://127.0.0.1:9222/devtools/page/x" }, { chatId: "chat-a", targetId: `${BROWSER}:../x` }]) {
    await assert.rejects(g.service.open(request, "a"), /page|chat/i);
  }
  await assert.rejects(g.service.list({}), /chat/i);
  await assert.rejects(g.service.open({ chatId: "chat-a", targetId: target(PAGE) }, ""), /owner/i);
});

test("a desktop's Browser panel pages belong to the Chat whose panel shows them, and go with the desktop", async (t) => {
  const f = fixture(t);
  const PANEL_A = "D".repeat(32),
    PANEL_B = "E".repeat(32);
  const prefix = `/${"f".repeat(48)}`;
  await f.service.setPanelPages(
    {
      port: 51234,
      prefix,
      pages: [
        { id: PANEL_A, chatId: "chat-a", title: "Checkout", url: "http://localhost:5173/checkout" },
        { id: PANEL_B, chatId: "chat-c", title: "Docs", url: "http://localhost:3000/" },
      ],
    },
    "desktop-1",
  );
  const own = (await f.service.list({ chatId: "chat-a" })).targets.filter((page) => page.source === "panel");
  assert.deepEqual(
    own.map((page) => [page.title, page.url, page.browser]),
    [["Checkout", "http://localhost:5173/checkout", "Browser panel"]],
  );
  // A Chat without an agent running still sees its panel's pages; another Chat sees neither, nor can attach them.
  const c = await f.service.list({ chatId: "chat-c" });
  assert.deepEqual(
    c.targets.map((page) => page.title),
    ["Docs"],
  );
  assert.ok(!c.others.some((browser) => browser.id.startsWith("panel-")));
  assert.ok(!(await f.service.list({ chatId: "chat-b" })).targets.some((page) => page.source === "panel"));
  // Viewing one connects through the endpoint's token path.
  const viewer = await f.service.open({ chatId: "chat-a", targetId: own[0].id }, "phone");
  assert.equal(f.channels.at(-1).browserId.port, 51234);
  assert.equal(f.channels.at(-1).browserId.prefix, prefix);
  await assert.rejects(f.service.open({ chatId: "chat-b", targetId: own[0].id }, "phone"), /not available in this Chat/);
  // The page closing in the panel closes its viewers; the desktop going takes the rest.
  await f.service.setPanelPages({ port: 51234, prefix, pages: [{ id: PANEL_B, chatId: "chat-c", title: "Docs", url: "http://localhost:3000/" }] }, "desktop-1");
  assert.equal(f.channels.at(-1).closed, true);
  await assert.rejects(f.service.status({ viewerId: viewer.viewerId }, "phone"), /Unknown browser viewer/);
  await f.service.disconnect("desktop-1");
  assert.deepEqual((await f.service.list({ chatId: "chat-c" })).targets, []);
});

test("Browser panel pages must name a loopback endpoint's token path, page ids and Chats", async (t) => {
  const f = fixture(t);
  const page = { id: "D".repeat(32), chatId: "chat-a", title: "x", url: "http://localhost/" };
  await assert.rejects(f.service.setPanelPages({ port: 51234, prefix: "/short", pages: [page] }, "desktop-1"), /endpoint/);
  await assert.rejects(f.service.setPanelPages({ port: 0, prefix: `/${"f".repeat(48)}`, pages: [page] }, "desktop-1"), /endpoint/);
  await assert.rejects(f.service.setPanelPages({ port: 51234, prefix: `/${"f".repeat(48)}`, pages: [{ ...page, id: "nope" }] }, "desktop-1"), /page/);
  await assert.rejects(f.service.setPanelPages({ port: 51234, prefix: `/${"f".repeat(48)}`, pages: [{ ...page, chatId: "" }] }, "desktop-1"), /Chat/);
  await assert.rejects(f.service.setPanelPages({ pages: [] }, ""), /desktop connection/);
});

test("the agent's DevTools session acts on the Chat's newest panel page, is reused, and ends when the page leaves", async (t) => {
  const f = fixture(t);
  const prefix = `/${"f".repeat(48)}`;
  const panel = (pages) => f.service.setPanelPages({ port: 51234, prefix, pages }, "desktop-1");
  await panel([
    { id: "D".repeat(32), chatId: "chat-a", title: "Old", url: "http://localhost:5173/a" },
    { id: "E".repeat(32), chatId: "chat-a", title: "New", url: "http://localhost:5173/b" },
  ]);
  const first = await f.service.devtools({ chatId: "chat-a" });
  assert.equal(first.target.title, "New");
  assert.equal(first.session.browser.prefix, prefix);
  const again = await f.service.devtools({ chatId: "chat-a" });
  assert.equal(again.session, first.session, "the session and what the tools remember are kept between calls");
  assert.equal(again.state, first.state);
  // A named page of the Chat (the agent's own browser), and nobody else's.
  assert.equal((await f.service.devtools({ chatId: "chat-a", page: target(PAGE) })).target.title, "Login");
  await assert.rejects(f.service.devtools({ chatId: "chat-b", page: first.target.id }), /not in this Chat/);
  await assert.rejects(f.service.devtools({ chatId: "chat-c" }), /no browser page/);
  await panel([{ id: "D".repeat(32), chatId: "chat-a", title: "Old", url: "http://localhost:5173/a" }]);
  assert.equal(first.session.closed, true, "a session on a page that left the panel is closed");
  // Two tools at once share the session being made, and the refs one of them keeps.
  const [one, two] = await Promise.all([f.service.devtools({ chatId: "chat-a" }), f.service.devtools({ chatId: "chat-a" })]);
  assert.equal(one.session, two.session);
  assert.equal(one.state, two.state);
  await f.service.disconnect("desktop-1");
  assert.equal(one.session.closed, true, "the desktop going ends the sessions on its pages");
});
