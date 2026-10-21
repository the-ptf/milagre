const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AiConsentDialog, PrivacySettings } from '/src/components/AiConsent';
import { bridgeFor } from '/src/lib/computer-bridge';
import '/src/styles.css';
window.__sent = 0;
window.__routineCalls = [];
window.milagre = Object.freeze({ sendMessage: async () => ++window.__sent, on: () => Object.freeze({ sendMessage: async () => ++window.__sent }),
 saveRoutinesEnabled: async (...args) => window.__routineCalls.push(args), runRoutineNow: async (...args) => window.__routineCalls.push(args) });
function Fixture() {
 const [error, setError] = useState('');
 const [settings, setSettings] = useState(false);
 async function send(id) { setError(''); try { await bridgeFor(id).sendMessage({}); } catch (e) { setError(e.message); } }
 async function routine(enable) { setError(''); try { if (enable) await bridgeFor(null).saveRoutinesEnabled(true); else await bridgeFor(null).runRoutineNow('r1'); } catch (e) { setError(e.message); } }
 return <main style={{ padding: 32, maxWidth: 660, margin: 'auto' }}>
  <button onClick={() => void send(null)}>Send local</button>
  <button onClick={() => void send('remote')}>Send remote</button>
  <button onClick={() => setSettings(!settings)}>Settings</button>
  <button onClick={() => void routine(true)}>Enable Routines</button>
  <button onClick={() => void routine(false)}>Run now</button>
  <p role="alert">{error}</p>
  {settings && <><h1>Privacy & AI</h1><PrivacySettings /></>}
  <AiConsentDialog />
 </main>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
`;
async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-ai-consent-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 900, height: 820, show: false });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  const errors = [];
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") errors.push(details.message);
  });
  const waitFor = async (source) => {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw Error("Timed out: " + source);
  };
  const click = (label) => evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent === '${label}').click()`);
  const screenshot = async (name) => {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    await delay(250);
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`!!document.querySelector('button')`);
    assert.equal(await evaluate(`document.querySelector('dialog')`), null, "idle consent leaves no dialog in the page");
    await click("Send local");
    await waitFor(`!!document.querySelector('dialog[open]')`);
    assert.equal(await evaluate("window.__sent"), 0);
    assert.match(await evaluate(`document.querySelector('dialog').textContent`), /Anthropic.*OpenAI.*Google/);
    assert.equal(await evaluate(`document.activeElement.textContent`), "Not now");
    await screenshot("consent");
    await click("Not now");
    await waitFor(`document.querySelector('[role="alert"]').textContent.includes('not sent')`);
    assert.equal(await evaluate("window.__sent"), 0);
    await click("Send remote");
    await waitFor(`!!document.querySelector('dialog[open]')`);
    await click("Allow sharing");
    await waitFor("window.__sent === 1");
    await click("Send local");
    await waitFor("window.__sent === 2");
    await window.reload();
    await waitFor(`!!document.querySelector('button')`);
    await click("Send local");
    await waitFor("window.__sent === 1");
    assert.equal(await evaluate(`!!document.querySelector('dialog[open]')`), false);
    await click("Settings");
    await waitFor(`document.querySelector('[role="status"]')?.textContent.includes('allowed')`);
    const links = await evaluate(`[...document.querySelectorAll('main > div a')].map(a => a.href)`);
    assert.ok(links.includes("https://milagre.cloud/privacy"));
    assert.ok(links.includes("https://milagre.cloud/support"));
    await screenshot("privacy-settings");
    await click("Reset AI sharing permission");
    await waitFor(`document.querySelector('[role="status"]')?.textContent.includes('will ask')`);
    await click("Send local");
    await waitFor(`!!document.querySelector('dialog[open]')`);
    await evaluate(`document.querySelector('dialog').dispatchEvent(new Event('cancel', { cancelable: true }))`);
    await waitFor(`!document.querySelector('dialog[open]')`);
    assert.equal(await evaluate("window.__sent"), 1);
    // This Mac's Routines follow the decision: Reset stopped them.
    assert.deepEqual(await evaluate("JSON.stringify(window.__routineCalls)"), JSON.stringify([[false, null]]));
    await evaluate("window.__routineCalls = []");
    await click("Enable Routines");
    await waitFor(`!!document.querySelector('dialog[open]')`);
    assert.equal(await evaluate("window.__routineCalls.length"), 0);
    assert.match(await evaluate(`document.querySelector('dialog').textContent`), /automatic Runs.*disconnected/);
    await click("Not now");
    await waitFor(`!document.querySelector('dialog[open]')`);
    assert.equal(await evaluate("window.__routineCalls.length"), 0);
    await click("Enable Routines");
    await waitFor(`!!document.querySelector('dialog[open]')`);
    await click("Allow sharing");
    // The decision lets this Mac run Routines, and the call itself carries the consent version.
    await waitFor("window.__routineCalls.length === 2");
    const version = require("@milagre/shared/ai-consent").AI_CONSENT_VERSION;
    assert.deepEqual(
      await evaluate("JSON.stringify(window.__routineCalls)"),
      JSON.stringify([
        [true, version],
        [true, version],
      ]),
    );
    await click("Settings");
    await click("Settings");
    await waitFor(`document.querySelector('[role="status"]')?.textContent.includes('allowed')`);
    await click("Reset AI sharing permission");
    await waitFor(`document.querySelector('[role="status"]')?.textContent.includes('will ask')`);
    await evaluate("window.__routineCalls = []");
    await click("Run now");
    await waitFor(`!!document.querySelector('dialog[open]')`);
    assert.equal(await evaluate("window.__routineCalls.length"), 0);
    await click("Not now");
    await waitFor(`!document.querySelector('dialog[open]')`);
    assert.deepEqual(errors, []);
    console.log("PASS: AI consent gates frozen local/remote bridges, cancels, persists after reload, and resets in Settings");
    app.exit(0);
  } catch (error) {
    console.error(error, errors);
    app.exit(1);
  }
}
async function main() {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: path.resolve(__dirname, "../apps/desktop/vite.config.ts"),
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-ai-consent"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "ai-consent-fixture",
        resolveId(id) {
          if (id === "/__ai-consent.tsx") return id;
        },
        load(id) {
          if (id === "/__ai-consent.tsx") return fixture;
        },
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== "/__ai-consent") return next();
            response.setHeader("Content-Type", "text/html");
            void server
              .transformIndexHtml(request.url, '<html><body><div id="root"></div><script type="module" src="/__ai-consent.tsx"></script></body></html>')
              .then((html) => response.end(html), next);
          });
        },
      },
    ],
  });
  try {
    await server.listen();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require("node:child_process").spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__ai-consent`], {
      env,
      stdio: "inherit",
    });
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
  if (process.versions.electron) require("electron").app.exit(1);
  else process.exitCode = 1;
});
