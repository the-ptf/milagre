// Real title components: running titles sweep for the whole call, pause for approval and stop when the call ends. The
// sweep is a band (SweepText) animating transform only; the titles keep a static tint.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const fixture = `
import React, { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ActivityBlock } from "/src/components/agents/ActivityBlock";
import { EditorLinks } from "/src/components/editor-links";
import "/src/styles.css";
window.milagre = { listEditors: async () => [{ id: "fixture", name: "Editor" }] };
function Fixture() {
  const [step, setStep] = useState({ id: "first", kind: "read", title: "Read \u0060file.ts\u0060", file: "file.ts", status: "running", startedAt: Date.now() });
  const [folded, setFolded] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [mounted, setMounted] = useState(true);
  const [, render] = useState(0);
  window.start = (age = 0, timestamp = true) => { setWaiting(false); setStep(s => ({ ...s, id: s.id + "x", status: "running", startedAt: timestamp ? Date.now() - age : undefined })); };
  window.wait = setWaiting;
  window.folded = setFolded;
  window.mount = setMounted;
  window.rerender = () => render(n => n + 1);
  window.finish = status => setStep(s => ({ ...s, status }));
  const entries = [...(folded ? [{ type: "step", step: { id: "done", kind: "shell", title: "Earlier step", status: "done" } }] : []), { type: "step", step }];
  return <EditorLinks root="/fixture"><div id="titles">{mounted && <ActivityBlock entries={entries} streaming waitingStepIds={waiting ? [step.id] : []} />}</div></EditorLinks>;
}
createRoot(document.getElementById("root")).render(<StrictMode><Fixture /></StrictMode>);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  const fs = require("node:fs");
  app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-step-sweep-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 800, height: 400, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  async function waitFor(source) {
    const end = Date.now() + 6000;
    while (Date.now() < end) {
      if (await evaluate(source)) return;
      await delay(20);
    }
    throw Error(`Timed out: ${source}`);
  }
  // The band and its counter are the only animations a running title has; the titles themselves only carry the tint.
  const motion = "document.getAnimations().filter(a => a.effect?.target?.matches?.('.sweep-band, .sweep-band-counter'))";
  const bands = "document.querySelectorAll('.sweep-band')";
  const titles = "document.querySelectorAll('.step-running:not(.sweep-band *)')";
  const titleMotion = "document.getAnimations().filter(a => a.effect?.target?.classList?.contains('step-running'))";
  const staticTitles = `${titles}.length > 0 && ${titleMotion}.length === 0 && [...${titles}].every(e => getComputedStyle(e).backgroundImage === 'none' && getComputedStyle(e).webkitTextFillColor === getComputedStyle(e).color)`;
  // One band per title: its animations are transform-only, the band slides right and the counter left in lockstep.
  const oneBandEach = `[...${bands}].every(b => getComputedStyle(b).animationName === 'sweep-band' && getComputedStyle(b.firstElementChild).animationName === 'sweep-band-counter' && b.closest('.relative')?.querySelectorAll('.sweep-band').length === 1)`;
  async function capture(name) {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, `step-sweep-${name}.png`), (await window.webContents.capturePage()).toPNG());
  }
  try {
    await window.loadURL(process.argv[2]);
    await waitFor("!!document.querySelector('code[role=link].step-running') && !!document.querySelector('.sweep-band')");
    assert.equal(await evaluate(`${bands}.length`), 1, "one band across the whole title, file link included");
    assert.equal(await evaluate(oneBandEach), true, "the band and its counter run the compositor keyframes");
    assert.equal(await evaluate(`${motion}.length`), 2, "band and counter");
    assert.equal(await evaluate(`${titleMotion}.length`), 0, "the titles themselves do not animate");
    assert.equal(await evaluate(`${motion}.every(a => a.effect.getTiming().iterations === Infinity)`), true);
    assert.equal(
      await evaluate(
        `${motion}.every(a => a.effect.getKeyframes().every(k => Object.keys(k).every(p => ['offset', 'easing', 'composite', 'computedOffset', 'transform'].includes(p))))`,
      ),
      true,
      "only transform animates",
    );
    // The copy is inert and hidden from assistive tech; it lines up with the title and truncates like it.
    assert.equal(
      await evaluate(
        `(() => { const b = document.querySelector('.sweep-band'); const copy = b.querySelector('.sweep-band-copy'); const title = b.parentElement; const t = title.getBoundingClientRect(); const c = copy.getBoundingClientRect(); return b.inert && b.getAttribute('aria-hidden') === 'true' && Math.abs(t.width - c.width) < 0.5 && getComputedStyle(copy).textOverflow === 'ellipsis' && getComputedStyle(copy).whiteSpace === 'nowrap'; })()`,
      ),
      true,
      "copy is inert, hidden and as wide as the title",
    );
    assert.equal(
      await evaluate("getComputedStyle(document.querySelector('.sweep-band-copy code')).backgroundColor"),
      "rgba(0, 0, 0, 0)",
      "the copy's chip carries no fill",
    );
    await capture("sweeping");
    // Pause both halves at the same phase, with a window's peak about 40px into the title, so the shot shows it on the text.
    await evaluate(`${motion}.forEach(a => { a.pause(); a.currentTime = 650; })`);
    await delay(150);
    await capture("band");
    // The copy stays put while the window moves: band + counter cancel out.
    assert.equal(
      await evaluate(
        `(() => { const b = document.querySelector('.sweep-band'); const copy = b.querySelector('.sweep-band-copy'); return Math.abs(copy.getBoundingClientRect().left - b.parentElement.getBoundingClientRect().left) < 1; })()`,
      ),
      true,
      "the copy holds still over the title mid-sweep",
    );
    await evaluate(`${motion}.forEach(a => a.play())`);

    // Long calls keep sweeping, and ordinary renders do not restart the loop.
    await delay(2600);
    assert.equal(await evaluate(`${motion}.length`), 2, "still sweeping after two periods");
    const first = await evaluate(`${motion}[0].currentTime`);
    await evaluate("window.rerender()");
    assert.ok(await evaluate(`${motion}[0].currentTime >= ${first}`), "ordinary renders do not restart");

    // Approval stops the sweep; the answer resumes it. Old hosts without a start time sweep too.
    await evaluate("window.wait(true)");
    await waitFor(`${bands}.length === 0 && ${titles}.length === 0`);
    await evaluate("window.wait(false)");
    await waitFor(`${motion}.length === 2`);
    await evaluate("window.start(0, false)");
    await waitFor(`${motion}.length === 2`);

    // The folded header and its expansion sweep together, code spans included.
    await evaluate("window.folded(true); window.start(3000)");
    await waitFor("!!document.querySelector('[data-slot=activity]')");
    await evaluate("document.querySelector('[data-slot=activity] > button').click()");
    await waitFor(`${titles}.length === 4 && ${bands}.length === 2 && ${motion}.length === 4`);
    assert.equal(await evaluate(oneBandEach), true, "summary and row each carry one band");
    // Parked rows retain their DOM and animation phase, but do no hidden sweep
    // work. The summary stays live and opening the fold resumes the same loops.
    await evaluate(`window.rowSweeps = ${motion}.filter(a => a.effect.target.closest('[data-slot=activity-body]'))`);
    assert.equal(await evaluate("window.rowSweeps.length"), 2, "band and counter in the mounted body");
    await evaluate("document.querySelector('[data-slot=activity] > button').click()");
    await waitFor("window.rowSweeps.every(a => a.playState === 'paused')");
    assert.equal(
      await evaluate(`${motion}.filter(a => !a.effect.target.closest('[data-slot=activity-body]')).every(a => a.playState === 'running')`),
      true,
      "collapsed summary keeps sweeping",
    );
    const parked = await evaluate("window.rowSweeps.map(a => a.currentTime)");
    await delay(350);
    assert.deepEqual(await evaluate("window.rowSweeps.map(a => a.currentTime)"), parked, "hidden sweeps do not advance");
    await evaluate("document.querySelector('[data-slot=activity] > button').click()");
    await waitFor("window.rowSweeps.every(a => a.playState === 'running')");
    assert.equal(await evaluate(`window.rowSweeps.every(a => ${motion}.includes(a))`), true, "expansion reuses the same animations");
    assert.equal(
      await evaluate(`window.rowSweeps.every((a, i) => a.currentTime >= ${JSON.stringify(parked)}[i])`),
      true,
      "expansion resumes instead of restarting the sweep",
    );
    await capture("folded");
    await evaluate("window.folded(false)");

    await window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await evaluate("window.start()");
    await waitFor(staticTitles);
    assert.equal(await evaluate(`[...${bands}].every(b => getComputedStyle(b).display === 'none')`), true, "reduced motion hides the band");
    assert.equal(await evaluate(`${motion}.length`), 0, "reduced motion runs no sweep");
    const staticCode = await evaluate("getComputedStyle(document.querySelector('code')).backgroundColor");
    assert.notEqual(staticCode, "rgba(0, 0, 0, 0)", "static file chips retain their fill");
    await capture("reduced");
    await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [] });
    await evaluate("window.finish('done')");
    await waitFor(`${titles}.length === 0`);
    assert.equal(await evaluate(`${bands}.length`), 0, "a finished call has no band");
    assert.equal(await evaluate(`${motion}.length`), 0, "a finished call stops sweeping");
    await evaluate("window.start(); window.finish('failed')");
    await waitFor(`${titles}.length === 0 && ${bands}.length === 0`);
    console.log(
      "PASS step sweeps: one transform-only band per title, whole-call loop, no restart on render, approval pause, old hosts, parked rows pause and resume, reduced motion and finish",
    );
  } finally {
    window.destroy();
    app.quit();
  }
}

async function main() {
  const { createServer } = await import("vite");
  const { spawn } = require("node:child_process");
  const server = await createServer({
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "step-sweep-fixture",
        resolveId: (id) => (id === "/__step_sweep_fixture.tsx" ? id : undefined),
        load: (id) => (id === "/__step_sweep_fixture.tsx" ? fixture : undefined),
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== "/__step_sweep__") return next();
            server
              .transformIndexHtml(request.url, '<html><body><div id="root"></div><script type="module" src="/__step_sweep_fixture.tsx"></script></body></html>')
              .then((html) => {
                response.setHeader("Content-Type", "text/html");
                return response.end(html);
              })
              .catch((error) => {
                response.statusCode = 500;
                response.end(String(error));
              });
          });
        },
      },
    ],
  });
  try {
    await server.listen();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__step_sweep__`], { env, stdio: "inherit" });
    process.exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await server.close();
  }
}

(process.versions.electron ? browserChecks() : main()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
