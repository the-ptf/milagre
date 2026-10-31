const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { test } = require("node:test");
const { openRenderer } = require("./renderer-ready.cjs");

const never = () => new Promise(() => {});
const url = "http://127.0.0.1:1234/fixture";
const selector = "!!document.querySelector('[data-ready]')";
const snapshot = { readyState: "complete", rootChildren: 0, body: "Loading" };

function fixture(t) {
  const contents = new EventEmitter();
  Object.assign(contents, {
    getURL: () => url,
    isDestroyed: () => false,
    executeJavaScript: async () => ({ ready: true }),
    debugger: {
      isAttached: () => false,
      attach() {},
      detach() {},
      sendCommand: async () => ({ data: Buffer.from("png").toString("base64") }),
    },
  });
  const window = { webContents: contents, loadURL: async () => {} };
  t.mock.method(console, "error", () => {});
  const oldDir = process.env.MILAGRE_SCREENSHOT_DIR;
  delete process.env.MILAGRE_SCREENSHOT_DIR;
  t.after(() => {
    if (oldDir === undefined) delete process.env.MILAGRE_SCREENSHOT_DIR;
    else process.env.MILAGRE_SCREENSHOT_DIR = oldDir;
    assert.equal(contents.eventNames().length, 0, "all readiness listeners detached");
  });
  return { window, contents };
}

test("a delayed mount uses the startup budget and detaches listeners on success", async (t) => {
  const { window, contents } = fixture(t);
  const started = performance.now();
  let calls = 0;
  contents.executeJavaScript = async () => ({ ready: ++calls >= 3, snapshot });
  await openRenderer(window, url, selector, { timeoutMs: 500 });
  assert.equal(calls, 3);
  assert.ok(performance.now() - started >= 40);
  assert.equal(console.error.mock.callCount(), 0);
});

test("a renderer that never mounts reports URL, selector, cached document and bounded console/load errors", async (t) => {
  const { window, contents } = fixture(t);
  window.loadURL = async () => {
    for (let i = 0; i < 30; i++) contents.emit("console-message", { level: 3, message: `${i}:${"x".repeat(1000)}` });
    contents.emit("did-fail-load", {}, -2, "FAILED", "http://failed/module", false);
    contents.emit("preload-error", {}, "/preload", new Error("preload failed"));
  };
  contents.executeJavaScript = async (source) => (source.includes("const ready") ? { ready: false, snapshot } : snapshot);
  const started = performance.now();
  await assert.rejects(openRenderer(window, url, selector, { timeoutMs: 65 }), (error) => {
    assert.equal(error.code, "ERR_RENDERER_READINESS");
    const diagnostic = JSON.parse(error.message.slice(error.message.indexOf("{")));
    assert.equal(diagnostic.url, url);
    assert.equal(diagnostic.selector, selector);
    assert.deepEqual(diagnostic.snapshot, snapshot);
    assert.equal(diagnostic.errors.length, 20);
    assert.ok(diagnostic.errors.every((value) => value.length <= 500));
    assert.ok(diagnostic.errors.some((value) => value.includes("http://failed/module")));
    assert.ok(diagnostic.errors.some((value) => value.includes("preload failed")));
    assert.ok(diagnostic.polls > 0);
    return true;
  });
  assert.ok(performance.now() - started < 400);
});

for (const phase of ["navigation", "evaluation", "diagnostics and screenshot"]) {
  test(`a stalled ${phase} cannot defeat the deadline`, async (t) => {
    const { window, contents } = fixture(t);
    let evaluations = 0;
    if (phase === "navigation") window.loadURL = never;
    contents.executeJavaScript = (source) => {
      evaluations++;
      if (phase === "evaluation" || (phase === "diagnostics and screenshot" && !source.includes("const ready"))) return never();
      return Promise.resolve(source.includes("const ready") ? { ready: false, snapshot } : snapshot);
    };
    const capture = t.mock.method(contents.debugger, "sendCommand", never);
    if (phase === "diagnostics and screenshot") process.env.MILAGRE_SCREENSHOT_DIR = os.tmpdir();
    const started = performance.now();
    await assert.rejects(openRenderer(window, url, selector, { timeoutMs: 50 }), { code: "ERR_RENDERER_READINESS" });
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 40 && elapsed < 2500, `bounded startup and diagnostic allowance: ${elapsed}ms`);
    const stoppedAt = evaluations;
    await delay(40);
    assert.equal(evaluations, stoppedAt, "no abandoned polling loop");
    assert.equal(capture.mock.callCount(), phase === "diagnostics and screenshot" ? 1 : 0);
  });
}

test("a late successful evaluation cannot turn an expired deadline into success", async (t) => {
  const { window, contents } = fixture(t);
  let polls = 0;
  contents.executeJavaScript = async (source) => {
    if (!source.includes("const ready")) return snapshot;
    polls++;
    await delay(100);
    return { ready: true };
  };
  await assert.rejects(openRenderer(window, url, selector, { timeoutMs: 30 }), { code: "ERR_RENDERER_READINESS" });
  await delay(120);
  assert.equal(polls, 1);
});

test("navigation context transitions retry, but syntax errors fail promptly with their original cause", async (t) => {
  const { window, contents } = fixture(t);
  let polls = 0;
  contents.executeJavaScript = async () => {
    if (++polls === 1) throw new Error("Execution context was destroyed");
    return { ready: true };
  };
  await openRenderer(window, url, selector, { timeoutMs: 500 });
  const cause = new SyntaxError("Unexpected token");
  contents.executeJavaScript = async () => {
    throw cause;
  };
  const started = performance.now();
  await assert.rejects(openRenderer(window, url, selector, { timeoutMs: 500 }), (error) => {
    assert.equal(error.cause, cause);
    assert.match(error.message, /Unexpected token/);
    return true;
  });
  assert.ok(performance.now() - started < 300);
});

test("navigation rejection and renderer termination remain failures", async (t) => {
  const { window, contents } = fixture(t);
  const cause = new Error("ERR_CONNECTION_REFUSED");
  window.loadURL = async () => {
    throw cause;
  };
  await assert.rejects(openRenderer(window, url, selector), (error) => error.code === "ERR_RENDERER_READINESS" && error.cause === cause);
  window.loadURL = async () => {
    contents.emit("render-process-gone", {}, { reason: "crashed" });
  };
  await assert.rejects(openRenderer(window, url, selector), /renderer gone.*crashed/);
});

test("screenshots are opt-in and named per check", async (t) => {
  const { window, contents } = fixture(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "renderer-ready-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.MILAGRE_SCREENSHOT_DIR = dir;
  contents.executeJavaScript = async () => {
    throw new Error("fixture error");
  };
  await assert.rejects(openRenderer(window, url, selector), /fixture error/);
  assert.deepEqual(fs.readdirSync(dir), [`${path.basename(process.argv[1], ".cjs")}-renderer-not-ready.png`]);
});

test("a renderer crash during a pending evaluation cannot return a stale success", async (t) => {
  const { window, contents } = fixture(t);
  contents.executeJavaScript = async () => {
    contents.emit("render-process-gone", {}, { reason: "crashed" });
    return { ready: true };
  };
  await assert.rejects(openRenderer(window, url, selector), /Renderer terminated before readiness|renderer gone/);
});

test("a late screenshot result never writes a file after its diagnostic deadline", async (t) => {
  const { window, contents } = fixture(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "renderer-ready-late-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.MILAGRE_SCREENSHOT_DIR = dir;
  contents.executeJavaScript = async () => {
    throw new Error("fixture error");
  };
  let finishCapture;
  contents.debugger.sendCommand = () =>
    new Promise((resolve) => {
      finishCapture = resolve;
    });
  await assert.rejects(openRenderer(window, url, selector), { code: "ERR_RENDERER_READINESS" });
  finishCapture({ data: Buffer.from("png").toString("base64") });
  await delay(30);
  assert.deepEqual(fs.readdirSync(dir), []);
});
