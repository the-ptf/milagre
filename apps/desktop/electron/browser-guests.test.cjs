const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { BROWSER_PARTITION, hardenBrowserGuests, isPageUrl, swipeTracker } = require("./browser-guests.cjs");

function fakeContents(id = 1) {
  const contents = new EventEmitter();
  contents.id = id;
  contents.sent = [];
  contents.send = (channel, payload) => contents.sent.push([channel, payload]);
  contents.setWindowOpenHandler = (handler) => {
    contents.openHandler = handler;
  };
  return contents;
}

function fakeSession() {
  return {
    setPermissionRequestHandler(handler) {
      this.request = handler;
    },
    setPermissionCheckHandler(handler) {
      this.check = handler;
    },
  };
}

function setup() {
  const host = fakeContents(1);
  const session = fakeSession();
  const opened = [];
  hardenBrowserGuests(host, { session, openExternal: (url) => opened.push(url), platform: "darwin" });
  return { host, session, opened };
}

function attach(host, params, preferences = {}) {
  let prevented = false;
  const webPreferences = {
    ...preferences,
    preload: "/evil/preload.js",
    nodeIntegration: true,
    contextIsolation: false,
    sandbox: false,
    webSecurity: false,
    webviewTag: true,
  };
  host.emit("will-attach-webview", { preventDefault: () => (prevented = true) }, webPreferences, {
    partition: BROWSER_PARTITION,
    src: "http://localhost:5173/",
    ...params,
  });
  return { prevented, webPreferences };
}

function prevented(contents, event, ...args) {
  let stopped = false;
  contents.emit(event, { preventDefault: () => (stopped = true), ...args[1] }, args[0]);
  return stopped;
}

test("pages are web pages and the blank one", () => {
  assert.equal(isPageUrl("http://localhost:5173/x"), true);
  assert.equal(isPageUrl("https://example.com"), true);
  assert.equal(isPageUrl("about:blank"), true);
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "milagre-media://x", "chrome://settings", "nope"])
    assert.equal(isPageUrl(url), false, url);
});

test("a webview attaches only in the browser session, on a web page, without a preload or Node", () => {
  const { host } = setup();
  const allowed = attach(host, {});
  assert.equal(allowed.prevented, false);
  assert.equal(allowed.webPreferences.preload, undefined);
  assert.equal(allowed.webPreferences.nodeIntegration, false);
  assert.equal(allowed.webPreferences.contextIsolation, true);
  assert.equal(allowed.webPreferences.sandbox, true);
  assert.equal(allowed.webPreferences.webSecurity, true);
  assert.equal(allowed.webPreferences.webviewTag, false);
  assert.equal(attach(host, { partition: "persist:other" }).prevented, true);
  assert.equal(attach(host, { partition: "" }).prevented, true);
  assert.equal(attach(host, { src: "file:///etc/passwd" }).prevented, true);
  // A webpreferences attribute naming another session is overruled.
  assert.equal(attach(host, {}, { partition: "persist:other" }).webPreferences.partition, BROWSER_PARTITION);
});

test("a page may not ask for devices, location or notifications", () => {
  const { session } = setup();
  const answer = (permission) => {
    let granted;
    session.request(null, permission, (value) => (granted = value));
    return granted;
  };
  for (const permission of ["media", "geolocation", "notifications", "midi", "hid", "usb", "serial", "openExternal"])
    assert.equal(answer(permission), false, permission);
  assert.equal(answer("clipboard-sanitized-write"), true);
  assert.equal(session.check(null, "media"), false);
});

test("a new window from a page becomes a tab beside it; mail leaves the app; nothing else opens", () => {
  const { host, opened } = setup();
  const guest = fakeContents(7);
  host.emit("did-attach-webview", {}, guest);
  assert.deepEqual(guest.openHandler({ url: "https://example.com/a" }), { action: "deny" });
  assert.deepEqual(guest.openHandler({ url: "mailto:a@example.com" }), { action: "deny" });
  assert.deepEqual(guest.openHandler({ url: "file:///etc/passwd" }), { action: "deny" });
  assert.deepEqual(host.sent, [["browser-panel:open-tab", { from: 7, url: "https://example.com/a" }]]);
  assert.deepEqual(opened, ["mailto:a@example.com"]);
});

test("a page navigates on the web only", () => {
  const { host, opened } = setup();
  const guest = fakeContents(7);
  host.emit("did-attach-webview", {}, guest);
  assert.equal(prevented(guest, "will-navigate", "https://example.com/next"), false);
  assert.equal(prevented(guest, "will-navigate", "file:///etc/passwd"), true);
  assert.equal(prevented(guest, "will-redirect", "vscode://file/x"), true);
  assert.equal(prevented(guest, "will-navigate", "mailto:a@example.com"), true);
  assert.deepEqual(opened, ["mailto:a@example.com"]);
  let stopped = false;
  guest.emit("will-frame-navigate", { isMainFrame: false, url: "file:///etc/passwd", preventDefault: () => (stopped = true) });
  assert.equal(stopped, true);
  stopped = false;
  guest.emit("will-frame-navigate", { isMainFrame: false, url: "https://youtube.com/embed/x", preventDefault: () => (stopped = true) });
  assert.equal(stopped, false);
});

test("the app's shortcuts and the browser keys pressed in a page reach the renderer", () => {
  const { host } = setup();
  const guest = fakeContents(7);
  host.emit("did-attach-webview", {}, guest);
  const press = (input) => {
    let stopped = false;
    guest.emit(
      "before-input-event",
      { preventDefault: () => (stopped = true) },
      { type: "keyDown", meta: true, control: false, shift: false, alt: false, ...input },
    );
    return stopped;
  };
  assert.equal(press({ key: "b", shift: true }), true);
  assert.equal(press({ key: "," }), true);
  assert.equal(press({ key: "l" }), true);
  assert.equal(press({ key: "r" }), true);
  assert.equal(press({ key: "w" }), true);
  // Typing, copy and paste stay the page's.
  assert.equal(press({ key: "c" }), false);
  assert.equal(press({ key: "a", meta: false }), false);
  assert.deepEqual(host.sent, [
    ["app:shortcut", { key: "b", code: undefined, meta: true, control: false, alt: false, shift: true }],
    ["app:shortcut", { key: ",", code: undefined, meta: true, control: false, alt: false, shift: false }],
    ["browser-panel:key", { from: 7, key: "l" }],
    ["browser-panel:key", { from: 7, key: "r" }],
    ["browser-panel:key", { from: 7, key: "w" }],
  ]);
});

/** What a run of wheel events ([dx, dy, time, pageScrolls]) navigates to. */
function swipes(wheels) {
  const step = swipeTracker(120, 250);
  return wheels.map(([dx, dy, time, pageScrolls = false]) => step({ dx, dy, time, pageScrolls })).filter(Boolean);
}

/** A trackpad gesture: ten wheel events 16ms apart. */
const swipe = (dx, start = 0, pageScrolls = false) => Array.from({ length: 10 }, (_, i) => [dx, 1, start + i * 16, pageScrolls]);

test("a sideways trackpad swipe the page doesn't take goes back or forward, once per gesture", () => {
  assert.deepEqual(swipes(swipe(-30)), ["back"]);
  assert.deepEqual(swipes(swipe(30)), ["forward"]);
  // Too short, mostly vertical, or scrolling something on the page: no navigation.
  assert.deepEqual(swipes(swipe(-5)), []);
  assert.deepEqual(swipes(swipe(-30).map(([dx, , time]) => [dx, 40, time])), []);
  assert.deepEqual(swipes(swipe(-30, 0, true)), []);
  // A pause ends the gesture; the next one swipes again.
  assert.deepEqual(swipes([...swipe(-30), ...swipe(-30, 1000)]), ["back", "back"]);
});

test("each page document gets the swipe script in a world of its own", () => {
  const { host } = setup();
  const guest = fakeContents(2);
  const runs = [];
  guest.executeJavaScriptInIsolatedWorld = async (world, scripts) => runs.push([world, scripts[0].code]);
  host.emit("did-attach-webview", {}, guest);
  guest.emit("dom-ready");
  assert.equal(runs.length, 1);
  assert.notEqual(runs[0][0], 0);
  assert.match(runs[0][1], /history\.back\(\)/);
});

test("a remote Chat's page attaches in its own session only once that session goes through its computer", () => {
  const host = fakeContents(1);
  const routed = new Set(["persist:milagre-browser-chat-0123456789abcdef01234567"]);
  hardenBrowserGuests(host, { session: fakeSession(), openExternal: () => {}, platform: "darwin", remoteReady: (partition) => routed.has(partition) });
  const own = attach(host, { partition: "persist:milagre-browser-chat-0123456789abcdef01234567" });
  assert.equal(own.prevented, false);
  assert.equal(own.webPreferences.partition, "persist:milagre-browser-chat-0123456789abcdef01234567");
  assert.equal(own.webPreferences.sandbox, true);
  // Not routed yet: it would reach this Mac's network instead of its computer's.
  assert.equal(attach(host, { partition: "persist:milagre-browser-chat-ffffffffffffffffffffffff" }).prevented, true);
  assert.equal(attach(host, {}).prevented, false, "the shared session still attaches");
});
