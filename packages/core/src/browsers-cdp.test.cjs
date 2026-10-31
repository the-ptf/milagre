const test = require("node:test");
const assert = require("node:assert/strict");
const { createBrowserAdapter, parseProcesses, productName } = require("./browsers-cdp.cjs");

const PAGE = "A".repeat(32);
const GUID = "0b5c2e5e-1111-4222-8333-944444444444";
const PS = [
  "  10     1 /usr/local/bin/claude --print",
  "  12    11 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=0 --user-data-dir=/tmp/secret token=hidden",
  "  13    12 /Applications/Google Chrome.app/Contents/Frameworks/Helper --type=renderer --remote-debugging-port=0",
  "  14     1 /opt/chromium --remote-debugging-port=9333",
  "  15     1 /opt/chromium --remote-debugging-pipe",
].join("\n");
const LSOF = "p12\ncGoogle Chrome\nn127.0.0.1:53111\np14\ncchromium\nn*:9333\n";

function json(value) {
  return { ok: true, body: new Response(JSON.stringify(value)).body };
}
function adapter(overrides = {}) {
  const urls = [];
  const execFile = async (command) => ({ stdout: command === "ps" ? PS : LSOF });
  const fetch = async (url) => {
    urls.push(url);
    if (url.endsWith("/json/version"))
      return json({ Browser: "HeadlessChrome/141.0.7390.54", webSocketDebuggerUrl: `ws://127.0.0.1:53111/devtools/browser/${GUID}` });
    return json([
      { type: "page", id: PAGE, title: "Login &amp; Sign&#39;s", url: "https://example.com/login", webSocketDebuggerUrl: "ws://evil.example/devtools/page/x" },
      { type: "service_worker", id: "B".repeat(32), url: "https://example.com/sw.js" },
      { type: "page", id: "C".repeat(32), url: "devtools://devtools/bundled/inspector.html" },
      { type: "page", id: "not-hex", url: "https://example.com/" },
    ]);
  };
  return { urls, adapter: createBrowserAdapter({ execFile, fetch, ...overrides }) };
}

class FakeSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static last = null;
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.last = this;
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    });
  }
  send(data) {
    const message = JSON.parse(data);
    this.sent.push(message);
    const result =
      message.method === "Page.getNavigationHistory"
        ? {
            currentIndex: 1,
            entries: [
              { id: 7, url: "https://example.com/", title: "Home" },
              { id: 8, url: "https://example.com/login", title: "Login" },
            ],
          }
        : {};
    queueMicrotask(() => this.emit({ id: message.id, result }));
  }
  emit(message) {
    const event = new Event("message");
    event.data = JSON.stringify(message);
    this.dispatchEvent(event);
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const methods = (socket) => socket.sent.map((message) => message.method);

test("discovery keeps only browser processes with a loopback endpoint owned by that process", async () => {
  const { adapter: a, urls } = adapter();
  const world = await a.discover();
  assert.deepEqual(world.browsers, [
    {
      id: GUID,
      pid: 12,
      host: "127.0.0.1",
      port: 53111,
      product: "Headless Chrome 141",
      pages: [{ id: PAGE, title: "Login & Sign's", url: "https://example.com/login" }],
    },
  ]);
  assert.ok(
    urls.every((url) => url.startsWith("http://127.0.0.1:53111/")),
    "a wildcard listener and pipe-only browsers are not probed",
  );
  assert.equal(JSON.stringify(world).includes("secret"), false, "arguments are not kept");
  assert.deepEqual(
    world.processes.find((row) => row.pid === 12),
    { pid: 12, ppid: 11 },
  );
});

test("process parsing skips helpers and names products", () => {
  assert.deepEqual(parseProcesses(PS).candidates, [
    { pid: 12, port: 0 },
    { pid: 14, port: 9333 },
  ]);
  assert.equal(productName("Chrome/141.0.1"), "Chrome 141");
  assert.equal(productName("Edg/140.0"), "Edge 140");
  assert.equal(productName(undefined), "Browser");
});

test("a browser that fails its probe is omitted rather than failing discovery", async () => {
  const { adapter: a } = adapter({
    fetch: async () => {
      throw new Error("refused");
    },
  });
  assert.deepEqual((await a.discover()).browsers, []);
});

test("a capture streams frames, maps normalized input to CSS pixels and never closes the page", async () => {
  const { adapter: a } = adapter({ WebSocket: FakeSocket });
  const channel = await a.connect({ host: "127.0.0.1", port: 53111 }, PAGE);
  const socket = FakeSocket.last;
  assert.equal(socket.url, `ws://127.0.0.1:53111/devtools/page/${PAGE}`);
  assert.deepEqual(methods(socket), ["Page.enable", "Page.getNavigationHistory", "Page.startScreencast"]);
  assert.deepEqual(channel.status(), {
    ready: false,
    width: 0,
    height: 0,
    title: "Login",
    url: "https://example.com/login",
    canGoBack: true,
    canGoForward: false,
  });
  assert.throws(() => channel.send({ kind: "text", text: "x" }), /not ready/);
  let woke = 0;
  channel.onFrame(() => woke++);
  socket.emit({ method: "Page.screencastFrame", params: { sessionId: 3, data: "jpeg", metadata: { deviceWidth: 800, deviceHeight: 600 } } });
  await settle();
  assert.deepEqual(channel.frame(), { sequence: 1, data: "jpeg", viewport: { width: 800, height: 600 } });
  assert.equal(woke, 1);
  assert.deepEqual(socket.sent.at(-1), { id: socket.sent.at(-1).id, method: "Page.screencastFrameAck", params: { sessionId: 3 } });
  socket.sent.length = 0;
  channel.send({ kind: "mouse", phase: "down", x: 0.5, y: 0.25, button: "left", clickCount: 1 });
  channel.send({ kind: "mouse", phase: "move", x: 0.75, y: 0.25, button: "none", clickCount: 0 });
  channel.send({ kind: "mouse", phase: "up", x: 0.75, y: 0.25, button: "left", clickCount: 1 });
  channel.send({ kind: "wheel", x: 0.5, y: 0.5, deltaX: 0, deltaY: 120 });
  channel.send({ kind: "key", phase: "down", key: "Enter", code: "Enter", keyCode: 13, text: "\r" });
  channel.send({ kind: "key", phase: "down", key: "a", code: "KeyA", keyCode: 65, modifiers: 4, commands: ["selectAll"] });
  channel.send({ kind: "text", text: "héllo" });
  channel.send({ kind: "navigate", action: "back" });
  channel.send({ kind: "navigate", action: "forward" });
  channel.send({ kind: "navigate", action: "reload" });
  channel.send({ kind: "viewport", width: 640, height: 480 });
  const params = socket.sent.map(({ method, params }) => [method, params]);
  assert.deepEqual(
    params,
    [
      ["Input.dispatchMouseEvent", { type: "mousePressed", x: 400, y: 150, button: "left", buttons: 1, clickCount: 1, modifiers: 0 }],
      ["Input.dispatchMouseEvent", { type: "mouseMoved", x: 600, y: 150, button: "left", buttons: 1, clickCount: 0, modifiers: 0 }],
      ["Input.dispatchMouseEvent", { type: "mouseReleased", x: 600, y: 150, button: "left", buttons: 0, clickCount: 1, modifiers: 0 }],
      ["Input.dispatchMouseEvent", { type: "mouseWheel", x: 400, y: 300, button: "none", deltaX: 0, deltaY: 120, modifiers: 0 }],
      ["Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 0, text: "\r", unmodifiedText: "\r" }],
      ["Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 4, commands: ["selectAll"] }],
      ["Input.insertText", { text: "héllo" }],
      ["Page.navigateToHistoryEntry", { entryId: 7 }],
      ["Page.reload", {}],
      ["Emulation.setDeviceMetricsOverride", { width: 640, height: 480, deviceScaleFactor: 0, mobile: false }],
    ],
    "forward is a no-op at the newest entry",
  );
  await channel.close();
  assert.deepEqual(methods(socket).slice(-2), ["Emulation.clearDeviceMetricsOverride", "Page.stopScreencast"], "the page gets its own size back");
  assert.equal(
    methods(socket).some((method) => /closeTarget|Browser\.close/.test(method ?? "")),
    false,
  );
  assert.equal(socket.readyState, FakeSocket.CLOSED);
});

test("a closed page or dropped connection fails the capture with a clear error", async () => {
  const { adapter: a } = adapter({ WebSocket: FakeSocket });
  const channel = await a.connect({ host: "127.0.0.1", port: 53111 }, PAGE);
  FakeSocket.last.emit({
    method: "Page.screencastFrame",
    params: { sessionId: 1, data: "x".repeat(2 * 1024 * 1024), metadata: { deviceWidth: 800, deviceHeight: 600 } },
  });
  assert.equal(channel.frame(), null, "oversized frames are dropped");
  FakeSocket.last.emit({ method: "Inspector.detached", params: { reason: "target_closed" } });
  assert.match(channel.status().error, /page closed/);
  const again = await a.connect({ host: "127.0.0.1", port: 53111 }, PAGE);
  FakeSocket.last.close();
  assert.match(again.status().error, /connection closed/);
});

test("connect accepts only loopback hosts and DevTools page identifiers", async () => {
  const { adapter: a } = adapter({ WebSocket: FakeSocket });
  for (const [browser, page] of [
    [{ host: "example.com", port: 9222 }, PAGE],
    [{ host: "127.0.0.1", port: 0 }, PAGE],
    [{ host: "127.0.0.1", port: 9222 }, "../browser"],
  ]) {
    await assert.rejects(a.connect(browser, page), /Invalid browser page/);
  }
});
