import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import {
  browserGeometry,
  browserPoint,
  browserKey,
  createBrowserInputQueue,
  createTouchGesture,
  createBrowserBridge,
  createBrowserReceiverHtml,
  buildBrowserReceiverScript,
  BROWSER_RECEIVER_SCRIPT,
} from "./browser-receiver.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test("letterboxing maps the displayed page to its viewport and ignores starts outside it", () => {
  const g = browserGeometry({ width: 800, height: 400 }, { width: 400, height: 400 });
  assert.deepEqual(g, { left: 0, top: 100, width: 400, height: 200, scale: 0.5 });
  assert.equal(browserPoint({ x: 200, y: 50 }, g), null);
  assert.deepEqual(browserPoint({ x: 100, y: 150 }, g), { x: 0.25, y: 0.25 });
  assert.deepEqual(browserPoint({ x: 500, y: 50 }, g, true), { x: 1, y: 0 });
  assert.equal(browserGeometry(null, { width: 400, height: 400 }), null);
  assert.equal(browserGeometry({ width: 800, height: 400 }, { width: 0, height: 400 }), null);
});

test("input keeps one request in flight, collapses moves, sums wheels and never merges presses", async () => {
  const sent = [],
    gates = [];
  const queue = createBrowserInputQueue(
    (event) => {
      sent.push(event);
      const gate = deferred();
      gates.push(gate);
      return gate.promise;
    },
    () => {},
  );
  const down = { kind: "mouse", phase: "down", x: 0, y: 0, button: "left" };
  queue.push(down);
  for (const x of [0.1, 0.2, 0.3]) queue.push({ kind: "mouse", phase: "move", x, y: 0 });
  queue.push({ kind: "mouse", phase: "up", x: 0.3, y: 0, button: "left" });
  queue.push({ kind: "wheel", x: 0.5, y: 0.5, deltaX: 0, deltaY: 100 });
  queue.push({ kind: "wheel", x: 0.6, y: 0.5, deltaX: 5, deltaY: 50 });
  for (let index = 0; index < 4; index++) {
    gates[index]?.resolve();
    await tick();
  }
  assert.deepEqual(sent, [
    down,
    { kind: "mouse", phase: "move", x: 0.3, y: 0 },
    { kind: "mouse", phase: "up", x: 0.3, y: 0, button: "left" },
    { kind: "wheel", x: 0.6, y: 0.5, deltaX: 5, deltaY: 150 },
  ]);
});

test("a backlog past the limit ends the session instead of replaying stale input", async () => {
  let failed = null;
  const queue = createBrowserInputQueue(
    () => new Promise(() => {}),
    (error) => {
      failed = error;
    },
    3,
  );
  for (let index = 0; index < 5; index++) queue.push({ kind: "text", text: String(index) });
  assert.match(failed.message, /too slow/);
});

test("touch taps click, moving scrolls with the finger, and holding still starts a drag", () => {
  const calls = [],
    timers = new Map();
  let serial = 0;
  const gesture = createTouchGesture(
    {
      tap: (point) => calls.push(["tap", point]),
      scroll: (dx, dy) => calls.push(["scroll", dx, dy]),
      pressStart: (point) => calls.push(["pressStart", point]),
      pressMove: (point) => calls.push(["pressMove", point]),
      pressEnd: (point) => calls.push(["pressEnd", point]),
    },
    {
      setTimeout: (fn) => {
        timers.set(++serial, fn);
        return serial;
      },
      clearTimeout: (id) => timers.delete(id),
    },
  );
  const p = { x: 0.5, y: 0.5 };
  gesture.begin(1, { x: 10, y: 10 }, p);
  gesture.move(1, { x: 12, y: 11 }, p);
  gesture.end(1, p);
  assert.deepEqual(calls.splice(0), [["tap", p]]);
  assert.equal(timers.size, 0, "a tap clears its hold timer");
  gesture.begin(1, { x: 10, y: 100 }, p);
  assert.equal(gesture.begin(2, { x: 50, y: 50 }, p), false, "a second finger is ignored");
  gesture.move(1, { x: 10, y: 80 }, p);
  gesture.move(1, { x: 10, y: 60 }, p);
  gesture.end(1, p);
  assert.deepEqual(calls.splice(0), [
    ["scroll", 0, -20],
    ["scroll", 0, -20],
  ]);
  gesture.begin(1, { x: 10, y: 10 }, p);
  [...timers.values()].at(-1)();
  gesture.move(1, { x: 40, y: 10 }, { x: 0.6, y: 0.5 });
  gesture.cancel();
  assert.deepEqual(calls.splice(0), [
    ["pressStart", p],
    ["pressMove", { x: 0.6, y: 0.5 }],
    ["pressEnd", { x: 0.6, y: 0.5 }],
  ]);
});

test("keys reach the page as keys; shortcuts become editing commands; composition stays text", () => {
  assert.deepEqual(browserKey({ key: "Enter", code: "Enter" }), { key: "Enter", code: "Enter", keyCode: 13, text: "\r" });
  assert.deepEqual(browserKey({ key: "Backspace", code: "Backspace" }), { key: "Backspace", code: "Backspace", keyCode: 8 });
  assert.deepEqual(browserKey({ key: "ArrowLeft", code: "ArrowLeft", shiftKey: true }), { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37, modifiers: 8 });
  assert.deepEqual(browserKey({ key: "a", code: "KeyA", metaKey: true }), { key: "a", code: "KeyA", keyCode: 65, modifiers: 4, commands: ["selectAll"] });
  assert.deepEqual(browserKey({ key: "z", code: "KeyZ", metaKey: true, shiftKey: true }).commands, ["redo"]);
  assert.deepEqual(browserKey({ key: "b", code: "KeyB" }), { key: "b", code: "KeyB", keyCode: 66, text: "b" });
  assert.deepEqual(browserKey({ key: "é", code: "" }), { key: "é", code: "", keyCode: 0, text: "é" });
  assert.equal(browserKey({ key: "a", code: "KeyA", isComposing: true }), null);
  assert.equal(browserKey({ key: "Unidentified", code: "" }), null);
  assert.equal(browserKey({ key: "Shift", code: "ShiftLeft" }), null);
});

test("the bridge admits only its own viewer and typed commands, and transforms frames", async () => {
  const calls = [],
    replies = [];
  const bridge = createBrowserBridge(
    async (method, args) => {
      calls.push([method, args]);
      return method === "open" ? { viewerId: "mine" } : method === "frame" ? { data: "jpeg" } : null;
    },
    (reply) => replies.push(reply),
    async (method, result) => (method === "frame" ? { uri: "file:///frame.jpg" } : result),
  );
  await bridge.receive({ channel: "milagre-browser", id: 1, method: "open", args: { chatId: "c", targetId: "t" } });
  await bridge.receive({ channel: "milagre-browser", id: 2, method: "frame", args: { viewerId: "mine", after: 0 } });
  await bridge.receive({ channel: "milagre-browser", id: 3, method: "status", args: { viewerId: "someone-else" } });
  await bridge.receive({ channel: "milagre-browser", id: 4, method: "list", args: {} });
  await bridge.receive({ channel: "milagre-browser", id: 5, method: "open", args: {} });
  await bridge.receive({ channel: "milagre-simulator", id: 6, method: "open", args: {} });
  assert.deepEqual(
    replies.map((reply) => reply.result ?? reply.error),
    [
      { viewerId: "mine" },
      { uri: "file:///frame.jpg" },
      "This browser viewer is closed.",
      "Unknown browser command.",
      "Close the current viewer before opening another.",
    ],
  );
  bridge.dispose();
  await tick();
  assert.deepEqual(calls.at(-1), ["close", { viewerId: "mine" }]);
});

test("HTML embeds the bundled script once, escapes configuration and loads nothing remote", () => {
  const html = createBrowserReceiverHtml({ chatId: "</script><script>bad()</script>", targetId: "t" });
  assert.equal((html.match(/<script>/g) || []).length, 1);
  assert.ok(!/src="http/.test(html));
  assert.equal(
    BROWSER_RECEIVER_SCRIPT,
    buildBrowserReceiverScript(),
    "Run node packages/shared/scripts/generate-browser-receiver.mjs after editing the receiver",
  );
  for (const chatId of ["one", "two", "</script>"])
    assert.equal(createBrowserReceiverHtml({ chatId, targetId: "t" }).match(/<script>([\s\S]+)<\/script>/)[1], BROWSER_RECEIVER_SCRIPT);
  for (const label of ["Back", "Forward", "Reload", "Keyboard", "Retry"]) assert.match(html, new RegExp(`aria-label="${label}"`));
});

/** Runs the exact bundled script with only DOM boundaries replaced. */
function harness(call, transport = "mobile") {
  const listeners = {},
    elements = {},
    timers = new Map(),
    intervals = new Map(),
    posted = [],
    resized = [];
  let serial = 0;
  const element = (id) => {
    const handlers = {};
    return {
      id,
      style: {},
      hidden: false,
      disabled: false,
      textContent: "",
      clientWidth: 400,
      clientHeight: 400,
      value: "",
      dataset: { config: JSON.stringify({ chatId: "chat", targetId: "target" }) },
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      setPointerCapture() {},
      focus() {
        document.activeElement = this;
      },
      blur() {
        document.activeElement = null;
      },
      removeAttribute(name) {
        delete this[name];
      },
      async decode() {},
      addEventListener(name, fn) {
        (handlers[name] ||= new Set()).add(fn);
      },
      emit(name, event) {
        for (const handler of handlers[name] || []) handler(event);
      },
    };
  };
  for (const id of ["config", "stage", "frame", "comment-pin", "message", "live", "keys", "back", "forward", "reload", "keyboard", "control", "retry"])
    elements[id] = element(id);
  const document = {
    documentElement: { style: { setProperty() {} } },
    hidden: false,
    activeElement: null,
    getElementById: (id) => elements[id],
    addEventListener: (name, fn) => {
      listeners[name] = fn;
    },
  };
  const window = {
    addEventListener: (name, fn) => {
      listeners["window:" + name] = fn;
    },
    ReactNativeWebView: {
      postMessage: (json) => {
        const message = JSON.parse(json);
        posted.push(message);
        void bridge.receive(message);
      },
    },
  };
  if (transport === "desktop") {
    delete window.ReactNativeWebView;
    window.parent = {
      postMessage(message) {
        message = JSON.parse(JSON.stringify(message));
        posted.push(message);
        void bridge.receive(message);
      },
    };
  }
  const bridge = createBrowserBridge(call, (reply) => {
    const data = JSON.parse(JSON.stringify(reply));
    if (transport === "desktop") listeners["window:message"]({ source: window.parent, data });
    else window.browserReply(data);
  });
  runInNewContext(BROWSER_RECEIVER_SCRIPT, {
    window,
    document,
    ResizeObserver: class {
      constructor(fn) {
        resized.push(fn);
      }
      observe() {}
    },
    setTimeout: (fn, delay) => {
      const id = ++serial;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn) => {
      const id = ++serial;
      intervals.set(id, fn);
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
  });
  return {
    window,
    elements,
    document,
    listeners,
    bridge,
    intervals,
    posted,
    resize: () => resized.forEach((fn) => fn()),
    timeout(delay) {
      for (const [id, value] of timers)
        if (value.delay === delay) {
          timers.delete(id);
          value.fn();
        }
    },
    async flush() {
      for (let i = 0; i < 6; i++) await tick();
    },
  };
}
const STATUS = {
  generation: 2,
  controlling: true,
  ready: true,
  title: "Login",
  url: "https://example.com/",
  canGoBack: true,
  canGoForward: false,
  supportsViewport: true,
};
function host(calls, { status = STATUS, frames = 1 } = {}) {
  let served = 0;
  return async (method, args) => {
    calls.push([method, args]);
    if (method === "open") return { viewerId: "viewer", target: {} };
    if (method === "input") return { accepted: true };
    if (method === "status" || method === "control") return status;
    if (method === "frame") {
      if (served >= frames) return new Promise(() => {});
      served++;
      return { sequence: served, data: "jpeg", viewport: { width: 800, height: 800 }, generation: status.generation };
    }
    return null;
  };
}
const pointer = (pointerType, clientX = 100, clientY = 100, extra = {}) => ({
  pointerId: 1,
  pointerType,
  clientX,
  clientY,
  button: 0,
  detail: 1,
  preventDefault() {},
  ...extra,
});
const sent = (calls) => calls.filter(([method]) => method === "input").map(([, args]) => args.event);
// Input from the user; the viewer's size has its own test.
const inputs = (calls) => sent(calls).filter((event) => event.kind !== "viewport");

test("the receiver shows frames, reports the page and maps a mouse click to page coordinates", async () => {
  const calls = [],
    h = harness(host(calls));
  await h.flush();
  assert.equal(h.elements.frame.src, "data:image/jpeg;base64,jpeg");
  assert.equal(h.elements.message.hidden, true);
  assert.equal(h.elements.live.textContent, "You control this page");
  assert.deepEqual(
    h.posted.find((message) => message.event === "page"),
    { channel: "milagre-browser", event: "page", title: "Login", url: "https://example.com/" },
  );
  assert.equal(h.elements.back.disabled, false);
  assert.equal(h.elements.forward.disabled, true);
  h.elements.stage.emit("pointerdown", pointer("mouse"));
  h.elements.stage.emit("pointerup", pointer("mouse"));
  await h.flush();
  assert.deepEqual(inputs(calls), [
    { kind: "mouse", phase: "down", x: 0.25, y: 0.25, button: "left", clickCount: 1 },
    { kind: "mouse", phase: "up", x: 0.25, y: 0.25, button: "left", clickCount: 1 },
  ]);
  assert.equal(h.document.activeElement, h.elements.keys, "clicking the page directs typing to it");
  assert.ok(calls.filter(([method]) => method === "input").every(([, args]) => args.generation === 2));
  h.bridge.dispose();
});

test("the page lays out at the stage's size while this viewer controls it, and follows it when it resizes", async () => {
  const calls = [],
    h = harness(host(calls));
  await h.flush();
  const viewports = () => sent(calls).filter((event) => event.kind === "viewport");
  assert.deepEqual(viewports(), [{ kind: "viewport", width: 400, height: 400 }], "sent once control and a frame arrive");
  h.elements.stage.clientWidth = 640.4;
  h.elements.stage.clientHeight = 300;
  h.resize();
  h.resize();
  await h.flush();
  assert.equal(viewports().length, 1, "a resize waits until the stage settles");
  h.timeout(150);
  h.timeout(150);
  await h.flush();
  assert.deepEqual(viewports().at(-1), { kind: "viewport", width: 640, height: 300 });
  assert.equal(viewports().length, 2, "an unchanged size is not sent again");
  h.bridge.dispose();
});

test("a view-only viewer leaves the page's size alone", async () => {
  const calls = [],
    h = harness(host(calls, { status: { ...STATUS, controlling: false } }));
  await h.flush();
  h.resize();
  h.timeout(150);
  await h.flush();
  assert.equal(sent(calls).length, 0);
  h.bridge.dispose();
});

for (const transport of ["desktop", "mobile"]) {
  for (const takeOver of [false, true]) {
    test(`${transport} retains input on an older host after ${takeOver ? "takeover" : "initial control"}, resize and reconnect`, async () => {
      const calls = [];
      const status = { ...STATUS, controlling: !takeOver };
      delete status.supportsViewport; // Pre-resize hosts never advertise the capability.
      let served = false;
      const h = harness(async (method, args) => {
        calls.push([method, args]);
        if (method === "open") {
          served = false;
          return { viewerId: "viewer", target: {} };
        }
        if (method === "control" && args.takeOver) status.controlling = true;
        if (method === "status" || method === "control") return status;
        if (method === "frame") {
          if (served) return new Promise(() => {});
          served = true;
          return { sequence: 1, data: "jpeg", viewport: { width: 800, height: 400 }, generation: status.generation };
        }
        if (method === "input") {
          if (args.event.kind === "viewport") throw new Error("Invalid browser input event.");
          return { accepted: true };
        }
        return null;
      }, transport);
      await h.flush();
      if (takeOver) {
        assert.equal(sent(calls).length, 0);
        h.elements.control.emit("click");
        await h.flush();
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        assert.equal(h.elements.retry.hidden, true, h.elements.message.textContent);
        assert.equal(h.elements.frame.style.top, "100px", "the legacy viewport remains letterboxed");
        h.elements.stage.emit("pointerdown", pointer(transport === "mobile" ? "touch" : "mouse", 100, 150));
        h.elements.stage.emit("pointerup", pointer(transport === "mobile" ? "touch" : "mouse", 100, 150));
        h.elements.keys.emit("beforeinput", { inputType: "insertText", data: "hello", preventDefault() {} });
        h.elements.reload.emit("click");
        await h.flush();
        assert.deepEqual(sent(calls).slice(-4), [
          { kind: "mouse", phase: "down", x: 0.25, y: 0.25, button: "left", clickCount: 1 },
          { kind: "mouse", phase: "up", x: 0.25, y: 0.25, button: "left", clickCount: 1 },
          { kind: "text", text: "hello" },
          { kind: "navigate", action: "reload" },
        ]);
        h.elements.stage.clientWidth = 600;
        h.resize();
        h.timeout(150);
        for (const poll of h.intervals.values()) poll();
        await h.flush();
        assert.equal(
          sent(calls).some((event) => event.kind === "viewport"),
          false,
        );
        assert.equal(h.elements.retry.hidden, true);
        if (attempt === 0) {
          assert.equal(
            calls.some(([method]) => method === "close"),
            false,
            "unsupported resizing never closes the viewer",
          );
          h.document.hidden = true;
          h.listeners.visibilitychange();
          await h.flush();
          h.document.hidden = false;
          h.elements.stage.clientWidth = 400;
          h.elements.retry.emit("click");
          await h.flush();
        }
      }
      h.bridge.dispose();
    });
  }
}

test("typing sends keys, inserted text and line breaks; Escape closes only when not typing into the page", async () => {
  const calls = [],
    h = harness(host(calls));
  await h.flush();
  const key = (key, code, extra = {}) => ({ key, code, preventDefault() {}, ...extra });
  h.elements.keys.emit("keydown", key("h", "KeyH"));
  h.elements.keys.emit("keyup", key("h", "KeyH"));
  h.elements.keys.emit("beforeinput", { inputType: "insertText", data: "olá", preventDefault() {} });
  h.elements.keys.emit("beforeinput", { inputType: "insertParagraph", data: null, preventDefault() {} });
  h.elements.keys.emit("compositionstart", {});
  h.elements.keys.value = "に";
  h.elements.keys.emit("input", {});
  h.elements.keys.emit("compositionend", { data: "日本" });
  h.elements.keys.emit("keydown", key("Escape", "Escape"));
  await h.flush();
  assert.deepEqual(
    inputs(calls).map((event) => (event.kind === "text" ? event.text : `${event.phase}:${event.key}`)),
    ["down:h", "up:h", "olá", "down:Enter", "up:Enter", "日本", "down:Escape"],
  );
  assert.equal(
    h.posted.some((message) => message.event === "close"),
    false,
  );
  h.listeners["window:keydown"]({ key: "Escape", target: h.elements.stage });
  assert.ok(h.posted.some((message) => message.event === "close"));
  h.bridge.dispose();
});

test("view-only viewers send no input until they take control", async () => {
  const calls = [],
    h = harness(host(calls, { status: { ...STATUS, controlling: false } }));
  await h.flush();
  assert.equal(h.elements.control.hidden, false);
  assert.equal(h.elements.reload.disabled, true);
  assert.equal(h.elements.live.textContent, "View only. Take control to interact.");
  h.elements.stage.emit("pointerdown", pointer("mouse"));
  h.elements.reload.emit("click");
  await h.flush();
  assert.equal(inputs(calls).length, 0);
  h.elements.control.emit("click");
  await h.flush();
  assert.deepEqual(
    calls.filter(([method]) => method === "control").map(([, args]) => args.takeOver),
    [false, true],
  );
  h.bridge.dispose();
});

test("touch scrolls the page and a held press is released when focus leaves", async () => {
  const calls = [],
    h = harness(host(calls));
  await h.flush();
  h.elements.stage.emit("pointerdown", pointer("touch", 100, 300));
  h.elements.stage.emit("pointermove", pointer("touch", 100, 250));
  h.elements.stage.emit("pointerup", pointer("touch", 100, 250));
  await h.flush();
  assert.deepEqual(inputs(calls), [{ kind: "wheel", x: 0.25, y: 0.75, deltaX: 0, deltaY: 100 }], "a 50px swipe at half scale scrolls 100 page pixels");
  calls.length = 0;
  h.elements.stage.emit("pointerdown", pointer("mouse"));
  h.listeners["window:blur"]();
  await h.flush();
  assert.deepEqual(
    inputs(calls).map((event) => event.phase),
    ["down", "up"],
  );
  h.bridge.dispose();
});

test("a failed page shows its reason in the stage with Retry, and hiding closes the viewer", async () => {
  const calls = [],
    base = host(calls);
  const h = harness(async (method, args) => {
    if (method === "frame") {
      calls.push([method, args]);
      throw new Error("This page closed. Choose another page.");
    }
    return base(method, args);
  });
  await h.flush();
  assert.equal(h.elements.message.textContent, "This page closed. Choose another page.");
  assert.equal(h.elements.message.hidden, false);
  assert.equal(h.elements.retry.hidden, false);
  assert.ok(calls.some(([method]) => method === "close"));
  assert.equal(h.intervals.size, 0);
  const g = harness(host([]));
  await g.flush();
  g.document.hidden = true;
  g.listeners.visibilitychange();
  await g.flush();
  assert.equal(g.intervals.size, 0);
  assert.equal(g.elements.retry.hidden, false);
});

test("a timed out open is cancelled and its late viewer is closed", async () => {
  const gate = deferred(),
    calls = [],
    base = host(calls);
  let attempts = 0;
  const h = harness(async (method, args) => (method === "open" && ++attempts === 1 ? gate.promise : base(method, args)));
  await h.flush();
  h.timeout(25000);
  await h.flush();
  assert.equal(h.elements.retry.hidden, false);
  gate.resolve({ viewerId: "orphan" });
  await h.flush();
  assert.ok(calls.some(([method, args]) => method === "close" && args.viewerId === "orphan"));
  h.bridge.dispose();
});

test("a comment pin follows the displayed frame and disappears when cancelled", async () => {
  const h = harness(host([]));
  await h.flush();
  h.window.browserCommentPoint({ x: 0.25, y: 0.75 });
  assert.equal(h.elements["comment-pin"].hidden, false);
  assert.equal(h.elements["comment-pin"].style.left, "100px");
  assert.equal(h.elements["comment-pin"].style.top, "300px");
  h.window.browserCommentPoint(null);
  assert.equal(h.elements["comment-pin"].hidden, true);
  h.window.browserCommentPoint({ x: -1, y: 1 });
  assert.equal(h.elements["comment-pin"].hidden, true);
  h.bridge.dispose();
});
