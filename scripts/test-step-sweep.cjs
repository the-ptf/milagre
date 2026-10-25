// Real title components: finite animation, original host deadlines, remounts and recycled title slots.
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
  const motion = "document.getAnimations().filter(a => a.effect?.target?.classList.contains('step-running'))";
  const staticTitles = `document.querySelectorAll('.step-running').length > 0 && ${motion}.length === 0 && [...document.querySelectorAll('.step-running')].every(e => getComputedStyle(e).backgroundImage === 'none' && getComputedStyle(e).webkitTextFillColor === getComputedStyle(e).color)`;
  async function capture(name) {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, `step-sweep-${name}.png`), (await window.webContents.capturePage()).toPNG());
  }
  try {
    await window.loadURL(process.argv[2]);
    await waitFor("!!document.querySelector('code[role=link].step-sweep')");
    assert.equal(await evaluate(`${motion}.length`), 2, "plain label and FileLink both sweep");
    assert.equal(await evaluate(`${motion}.every(a => a.effect.getTiming().iterations === 2)`), true);
    await waitFor(staticTitles);
    const staticCode = await evaluate(
      "({ fill:getComputedStyle(document.querySelector('code')).backgroundColor, field:getComputedStyle(document.documentElement).getPropertyValue('--field') })",
    );
    assert.notEqual(staticCode.fill, "rgba(0, 0, 0, 0)", "settled file chips retain their fill");
    await capture("settled-file");

    await evaluate("window.start();");
    await waitFor(`${motion}.length === 2`);
    await delay(600);
    const first = await evaluate(`${motion}[0].currentTime`);
    await evaluate("window.rerender()");
    assert.ok(await evaluate(`${motion}[0].currentTime >= ${first}`), "ordinary renders do not restart");
    await evaluate("window.start()");
    await waitFor(`${motion}.length === 2 && ${motion}[0].currentTime < 300`);
    await evaluate("window.wait(true)");
    await waitFor("!document.querySelector('.step-sweep')");
    await delay(2450);
    await evaluate("window.wait(false)");
    await waitFor(staticTitles);

    // A partial remount resumes the remaining budget; a reload/remount after expiry never replays.
    await evaluate("window.start(1700)");
    await waitFor(`${motion}.length === 2`);
    assert.ok(await evaluate(`${motion}[0].effect.getTiming().delay <= -1700`));
    await waitFor(staticTitles);
    await evaluate("window.mount(false)");
    await waitFor("!document.querySelector('.step-running')");
    await evaluate("window.mount(true)");
    await waitFor(staticTitles);

    // Park the DOM without unmounting React, as the transcript pool does.
    await evaluate("window.start(); window.parked = document.getElementById('titles'); window.parked.remove()");
    await delay(2500);
    await evaluate("document.getElementById('root').append(window.parked)");
    await waitFor(staticTitles);

    // The folded header and its first expansion agree on one deadline, including code spans.
    await evaluate("window.folded(true); window.start(3000)");
    await waitFor("!!document.querySelector('[data-slot=activity]')");
    await evaluate("document.querySelector('[data-slot=activity] > button').click()");
    await waitFor("document.querySelectorAll('.step-running').length === 4");
    await waitFor(staticTitles);
    await evaluate("window.start()");
    await waitFor(`${motion}.length === 4`);
    await waitFor(staticTitles);
    await capture("settled-folded");

    await window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await evaluate("window.start()");
    await waitFor(staticTitles);
    assert.equal(await evaluate("[...document.querySelectorAll('code.step-running')].every(e=>getComputedStyle(e).animationName === 'none')"), true);
    await capture("reduced");
    await window.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [] });
    await evaluate("window.start(0, false)");
    await waitFor(staticTitles);
    await evaluate("window.finish('done')");
    await waitFor("!document.querySelector('.step-running')");
    await evaluate("window.start(); window.finish('failed')");
    await waitFor("!document.querySelector('.step-running')");
    console.log("PASS step sweeps: two cycles, static chips, identity, waiting, remount, parked DOM, folded rows, old hosts and reduced motion");
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
