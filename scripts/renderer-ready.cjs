const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { setTimeout: delay } = require("node:timers/promises");

const diagnosticMs = 1000;
const bounded = (value) => String(value).slice(0, 500);
const snapshotSource = `({ readyState: document.readyState, rootChildren: document.getElementById('root')?.childElementCount, body: document.body?.innerText.slice(0, 2000) ?? '' })`;

async function within(operation, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Renderer deadline exceeded")), Math.max(0, milliseconds));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// A cold Vite transform on a fresh Linux runner gets its own startup deadline. Later interaction waits stay short.
// Navigation + readiness: 30 s; asynchronous failure diagnostics: at most 1 s more (subject to event-loop scheduling).
async function openRenderer(window, url, readySource, { timeoutMs = 30_000 } = {}) {
  const contents = window.webContents;
  const started = performance.now();
  const deadline = started + timeoutMs;
  const errors = [];
  let polls = 0;
  let snapshot = "unavailable: no renderer response";
  let lastEvaluationError;
  let terminated = false;
  const record = (message) => {
    errors.push(bounded(message));
    if (errors.length > 20) errors.shift();
  };
  const listeners = {
    "console-message": (event) => {
      if (event.level === "error" || event.level === 3) record(`console: ${event.message}`);
    },
    "did-fail-load": (_event, code, description, failedURL, isMainFrame) => record(`load: ${code} ${description} ${failedURL} mainFrame=${isMainFrame}`),
    "render-process-gone": (_event, details) => {
      terminated = true;
      record(`renderer gone: ${JSON.stringify(details)}`);
    },
    "preload-error": (_event, preloadPath, error) => record(`preload: ${preloadPath} ${error.message}`),
  };
  for (const [event, listener] of Object.entries(listeners)) contents.on(event, listener);
  try {
    await within(() => window.loadURL(url), deadline - performance.now());
    while (performance.now() < deadline) {
      if (terminated || contents.isDestroyed()) throw new Error("Renderer terminated before readiness");
      let result;
      polls++;
      try {
        result = await within(
          () => contents.executeJavaScript(`(() => { const ready = !!(${readySource}); return { ready, snapshot: ready ? null : ${snapshotSource} }; })()`),
          deadline - performance.now(),
        );
      } catch (error) {
        lastEvaluationError = bounded(error.message);
        // Vite may reload while re-optimizing dependencies; do not hide syntax errors or fixture exceptions.
        if (!/execution context was destroyed|frame was disposed|context (?:was )?released/i.test(error.message)) throw error;
      }
      if (performance.now() >= deadline) break;
      if (terminated || contents.isDestroyed()) throw new Error("Renderer terminated before readiness");
      if (result?.ready) {
        const elapsed = Math.round(performance.now() - started);
        if (elapsed > 5000) console.log(`Slow renderer (${path.basename(process.argv[1])}): ${elapsed}ms, ${polls} polls`);
        return;
      }
      if (result?.snapshot) snapshot = result.snapshot;
      await delay(Math.max(0, Math.min(25, deadline - performance.now())));
    }
    throw new Error("Renderer deadline exceeded");
  } catch (cause) {
    const diagnostic = {
      script: path.basename(process.argv[1]),
      selector: readySource,
      elapsedMs: Math.round(performance.now() - started),
      polls,
      url: contents.isDestroyed() ? "unavailable: destroyed" : contents.getURL(),
      snapshot,
      errors,
      lastEvaluationError,
    };
    console.error("Initial renderer failure:", JSON.stringify(diagnostic));
    // Both probes share one budget; a hung renderer must not trap the caller's failure path either.
    const diagnosticDeadline = performance.now() + diagnosticMs;
    const screenshotAbort = new AbortController();
    let attachedForScreenshot = false;
    const probes = [
      Promise.resolve()
        .then(() => contents.executeJavaScript(snapshotSource))
        .then(
          (value) => {
            diagnostic.snapshot = value;
            return value;
          },
          (error) => {
            diagnostic.snapshotError = bounded(error.message);
          },
        ),
    ];
    const screenshotDir = process.env.MILAGRE_SCREENSHOT_DIR;
    if (screenshotDir) {
      diagnostic.screenshot = "unavailable: capture pending";
      probes.push(
        Promise.resolve()
          .then(async () => {
            // CDP encodes on Chromium's side; no synchronous nativeImage.toPNG or filesystem I/O on our exit path.
            if (!contents.debugger.isAttached()) {
              contents.debugger.attach("1.3");
              attachedForScreenshot = true;
            }
            const { data } = await contents.debugger.sendCommand("Page.captureScreenshot", { format: "png" });
            screenshotAbort.signal.throwIfAborted();
            const filename = path.join(screenshotDir, `${path.basename(process.argv[1], ".cjs")}-renderer-not-ready.png`);
            await fs.promises.mkdir(screenshotDir, { recursive: true });
            await fs.promises.writeFile(filename, data, { encoding: "base64", signal: screenshotAbort.signal });
            return filename;
          })
          .then(
            (filename) => {
              diagnostic.screenshot = filename;
              return filename;
            },
            (error) => {
              diagnostic.screenshot = bounded(error.message);
            },
          ),
      );
    }
    await within(() => Promise.all(probes), diagnosticMs).catch((error) => {
      diagnostic.probeError = bounded(error.message);
    });
    screenshotAbort.abort();
    if (attachedForScreenshot && !contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
    const error = new Error(`Initial renderer readiness failed: ${JSON.stringify(diagnostic)}`, { cause });
    error.code = "ERR_RENDERER_READINESS";
    error.failureDeadline = diagnosticDeadline;
    throw error;
  } finally {
    for (const [event, listener] of Object.entries(listeners)) contents.removeListener(event, listener);
  }
}

module.exports = { openRenderer };
