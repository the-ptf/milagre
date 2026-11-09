const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createBrowserPanelPages } = require("./browser-panel-pages.cjs");

function fakeGuest(id, host, { title = "Checkout", url = "http://localhost:5173/" } = {}) {
  const guest = new EventEmitter();
  const debug = new EventEmitter();
  Object.assign(debug, {
    attached: false,
    commands: [],
    isAttached: () => debug.attached,
    attach: () => (debug.attached = true),
    detach: () => (debug.attached = false),
    sendCommand: async (method, params) => {
      debug.commands.push([method, params]);
      return { ok: method };
    },
  });
  Object.assign(guest, {
    id,
    hostWebContents: host,
    debugger: debug,
    destroyed: false,
    title,
    url,
    isDestroyed: () => guest.destroyed,
    getType: () => "webview",
    getTitle: () => guest.title,
    getURL: () => guest.url,
    reloads: [],
    reload: () => guest.reloads.push("reload"),
    reloadIgnoringCache: () => guest.reloads.push("ignoring cache"),
  });
  return guest;
}

function fixture(t) {
  const sent = [];
  const host = { id: 1, isDestroyed: () => false, send: (channel, payload) => sent.push([channel, payload]) };
  const other = { id: 2, isDestroyed: () => false, send: () => {} };
  const guests = new Map([
    [7, fakeGuest(7, host)],
    [8, fakeGuest(8, host, { title: "Docs", url: "http://localhost:3000/" })],
    [9, fakeGuest(9, other)],
  ]);
  const published = [];
  const pages = createBrowserPanelPages({ fromId: (id) => guests.get(id), publish: async (request) => published.push(request), product: "test" });
  t.after(() => pages.close());
  const settle = () => new Promise((resolve) => setTimeout(resolve, 320));
  return { host, sent, guests, published, pages, settle };
}

test("the window's own webviews are sent to the host with their Chats; a page that goes is taken away", async (t) => {
  const f = fixture(t);
  f.pages.setPages(f.host, [
    { contentsId: 7, chatKey: "/p#1" },
    { contentsId: 8, chatKey: "/p#2" },
    // Another window's webview, a missing one and a Chat-less one are ignored.
    { contentsId: 9, chatKey: "/p#3" },
    { contentsId: 99, chatKey: "/p#4" },
    { contentsId: 7, chatKey: "" },
  ]);
  await f.settle();
  const sent = f.published.at(-1);
  assert.equal(typeof sent.port, "number");
  assert.match(sent.prefix, /^\/[a-f0-9]{48}$/);
  assert.deepEqual(
    sent.pages.map(({ chatId, title, url }) => [chatId, title, url]),
    [
      ["/p#1", "Checkout", "http://localhost:5173/"],
      ["/p#2", "Docs", "http://localhost:3000/"],
    ],
  );
  for (const page of sent.pages) assert.match(page.id, /^[A-F0-9]{32}$/);
  // A navigation updates the title the host shows.
  f.guests.get(7).title = "Review";
  f.guests.get(7).emit("page-title-updated");
  await f.settle();
  assert.equal(f.published.at(-1).pages[0].title, "Review");
  f.guests.get(8).destroyed = true;
  f.guests.get(8).emit("destroyed");
  await f.settle();
  assert.deepEqual(
    f.published.at(-1).pages.map((page) => page.chatId),
    ["/p#1"],
  );
  f.pages.setPages(f.host, []);
  await f.settle();
  assert.deepEqual(f.published.at(-1), { pages: [] });
  // A page the renderer stops listing keeps no listener of ours, however often it is listed again.
  for (let i = 0; i < 3; i++) f.pages.setPages(f.host, [{ contentsId: 7, chatKey: "/p#1" }]);
  f.pages.setPages(f.host, []);
  f.pages.setPages(f.host, [{ contentsId: 7, chatKey: "/p#1" }]);
  assert.equal(f.guests.get(7).listenerCount("did-navigate"), 1);
  f.pages.setPages(f.host, []);
  assert.equal(f.guests.get(7).listenerCount("did-navigate") + f.guests.get(7).listenerCount("destroyed"), 0);
});

test("a DevTools connection to a page attaches its debugger for as long as it is open", async (t) => {
  const f = fixture(t);
  f.pages.setPages(f.host, [{ contentsId: 7, chatKey: "/p#1" }]);
  await f.settle();
  const { port, prefix, pages } = f.published.at(-1);
  const debug = f.guests.get(7).debugger;
  const ws = new WebSocket(`ws://127.0.0.1:${port}${prefix}/devtools/page/${pages[0].id}`);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  assert.equal(debug.attached, true);
  // The window keeps a viewed page painting while its panel is closed.
  assert.deepEqual(f.sent.at(-1), ["browser-panel:viewed", { from: 7, viewed: true }]);
  const reply = new Promise((resolve) => ws.addEventListener("message", (event) => resolve(JSON.parse(event.data)), { once: true }));
  ws.send(JSON.stringify({ id: 1, method: "Page.startScreencast", params: { format: "jpeg" } }));
  assert.deepEqual(await reply, { id: 1, result: { ok: "Page.startScreencast" } });
  assert.deepEqual(debug.commands, [["Page.startScreencast", { format: "jpeg" }]]);
  const event = new Promise((resolve) => ws.addEventListener("message", (message) => resolve(JSON.parse(message.data)), { once: true }));
  debug.emit("message", {}, "Page.screencastFrame", { data: "jpeg" });
  assert.deepEqual(await event, { method: "Page.screencastFrame", params: { data: "jpeg" } });
  // A viewer's size goes to the window, which sizes the parked page; emulation would leave frames cut at the guest.
  const sized = new Promise((resolve) => ws.addEventListener("message", (message) => resolve(JSON.parse(message.data)), { once: true }));
  ws.send(JSON.stringify({ id: 2, method: "Emulation.setDeviceMetricsOverride", params: { width: 640, height: 480, deviceScaleFactor: 0, mobile: false } }));
  assert.deepEqual(await sized, { id: 2, result: {} });
  assert.deepEqual(f.sent.at(-1), ["browser-panel:viewed", { from: 7, viewed: true, viewport: { width: 640, height: 480 } }]);
  const cleared = new Promise((resolve) => ws.addEventListener("message", (message) => resolve(JSON.parse(message.data)), { once: true }));
  ws.send(JSON.stringify({ id: 3, method: "Emulation.clearDeviceMetricsOverride", params: {} }));
  await cleared;
  assert.deepEqual(f.sent.at(-1), ["browser-panel:viewed", { from: 7, viewed: true, viewport: null }]);
  // Page.reload through the guest's debugger would reload Milagre's window: the guest reloads itself.
  for (const [id, params] of [
    [4, {}],
    [5, { ignoreCache: true }],
  ]) {
    const reloaded = new Promise((resolve) => ws.addEventListener("message", (message) => resolve(JSON.parse(message.data)), { once: true }));
    ws.send(JSON.stringify({ id, method: "Page.reload", params }));
    assert.deepEqual(await reloaded, { id, result: {} });
  }
  assert.deepEqual(f.guests.get(7).reloads, ["reload", "ignoring cache"]);
  assert.deepEqual(
    debug.commands.map(([method]) => method),
    ["Page.startScreencast"],
    "no emulation or reload reaches the guest's debugger",
  );
  ws.close();
  for (let i = 0; i < 50 && debug.attached; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(debug.attached, false, "the debugger is let go once nothing views the page");
  assert.deepEqual(f.sent.at(-1), ["browser-panel:viewed", { from: 7, viewed: false }]);
});
