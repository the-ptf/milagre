const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { UpdateShell } from '/src/components/UpdateNotice';
import { DotBackground } from '/src/components/DotBackground';
import '/src/styles.css';
window.release = 'unavailable'; window.available = false; window.reads = 0; window.installed = false; window.calls = []; window.fail = true;
window.progress = new Set();
window.milagre = {
 getUpdateState: async () => ({ status: 'idle', version: null, progress: 0 }),
 onUpdateState: () => () => {},
 onCliProgress: (callback) => { window.progress.add(callback); return () => window.progress.delete(callback); },
 getProviderUpdates: async () => { window.reads++; return !window.available ? null : window.installed ? [] : [{provider:'codex',installedVersion:'0.160.0',version:window.release,channel:'homebrew-cask',command:'brew upgrade --cask codex'}]; },
 updateCli: async (...args) => { window.calls.push(args); await new Promise(resolve => window.finish = resolve); if(window.fail) return {ok:false,error:'Error: codex: Download failed',log:'curl: (28) Operation timed out'}; window.installed=true; return {ok:true}; }
};
window.emitProgress = (progress) => window.progress.forEach((callback) => callback({ provider: 'codex', ...progress }));
document.documentElement.classList.add('dark');
const root=createRoot(document.getElementById('root'));
window.mount=()=>root.render(<div data-update-fixture><DotBackground><UpdateShell key={window.release}><div /></UpdateShell></DotBackground></div>);
window.mount();
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-provider-updates-")));
  await app.whenReady();
  const win = new BrowserWindow({ width: 794, height: 400, show: false, webPreferences: { backgroundThrottling: false } });
  const run = (s) => win.webContents.executeJavaScript(s);
  const wait = async (s) => {
    for (let n = 0; n < 240; n++) {
      if (await run(s)) return;
      await delay(50);
    }
    throw Error("Timed out: " + s);
  };
  const click = (label) => run(`([...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(label)})).click()`);
  const shot = async (name) => {
    if (process.env.MILAGRE_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), (await win.webContents.capturePage()).toPNG());
    }
  };
  let passed = false;
  try {
    await win.loadURL(process.argv[2]);
    await wait("window.reads > 0");
    await delay(100);
    assert.equal(await run("!!document.querySelector('[data-update-fixture]')"), true, "An unavailable optional endpoint must not unmount the app");
    assert.equal(await run("!!document.querySelector('[data-update-notice]')"), false);
    await run("window.available=true;window.release='0.163.0';window.mount()");
    await wait("document.querySelector('[data-face=pill]')?.textContent === 'Codex 0.163.0'");
    assert.equal(
      await run("getComputedStyle(document.querySelector('[data-face=card]')).visibility"),
      "hidden",
      "A CLI update shows as a pill, not an open card",
    );
    await shot("pill");
    await run("document.querySelector('[data-face=pill]').click()");
    await wait("document.body.textContent.includes('You have 0.160.0, installed with Homebrew.')");
    await shot("available");
    await click("Update");
    assert.deepEqual(await run("window.calls"), [["codex", "0.163.0"]]);
    await run("window.emitProgress({ phase: 'download', received: 16_000_000, total: 40_000_000 })");
    await wait("document.body.textContent.includes('40%') && document.body.textContent.includes('Downloading · 16.0 of 40.0 MB')");
    assert.equal(await run("!!document.querySelector('[aria-label=\"Dismiss update\"]')"), false, "An install in progress can't be dismissed");
    await shot("downloading");
    await run("window.emitProgress({ phase: 'install' })");
    await wait("document.body.textContent.includes('Installing…')");
    await run("window.finish()");
    await wait("document.body.textContent.includes('Error: codex: Download failed') && document.body.textContent.includes('Operation timed out')");
    assert.equal(await run("[...document.querySelectorAll('button')].some(b => b.textContent.includes('Copy command'))"), true);
    await shot("failed");
    await click("Try again");
    await run("window.fail=false;window.finish()");
    await wait("document.querySelector('[data-face=card] h2')?.textContent === 'Codex 0.163.0 installed'");
    await shot("installed");
    await wait("getComputedStyle(document.querySelector('[data-face=card]')).visibility === 'hidden'");
    await wait("!document.querySelector('[data-update-notice]')");
    await run("window.release='0.164.0';window.installed=false;window.mount()");
    await wait("document.querySelector('[data-face=pill]')?.textContent === 'Codex 0.164.0'");
    await run("document.querySelector('[data-face=pill]').click()");
    await wait("!!document.querySelector('[aria-label=\"Dismiss update\"]')");
    await run("document.querySelector('[aria-label=\"Dismiss update\"]').click()");
    await wait("!document.querySelector('[data-update-notice]')");
    console.log("Provider update pill: pill first, card, download percent, installing, failure log, retry, installed and dismissal passed.");
    passed = true;
  } catch (error) {
    console.error(error);
  } finally {
    win.destroy();
    app.exit(passed ? 0 : 1);
  }
}
async function main() {
  const { createServer } = await import("vite");
  const { spawn } = require("node:child_process");
  const server = await createServer({
    configFile: path.resolve(__dirname, "../apps/desktop/vite.config.ts"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "provider-updates-fixture",
        resolveId: (id) => (id === "/__provider-updates.tsx" ? id : null),
        load: (id) => (id === "/__provider-updates.tsx" ? fixture : null),
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (req, res, next) => {
            if (req.url !== "/__provider-updates__") return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await server.transformIndexHtml(
                req.url,
                '<html><body><div id="root"></div><script type="module" src="/__provider-updates.tsx"></script></body></html>',
              ),
            );
          });
        },
      },
    ],
  });
  try {
    await server.listen();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [__filename, server.resolvedUrls.local[0] + "__provider-updates__", "-ApplePersistenceIgnoreState", "YES"], {
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
  process.exitCode = 1;
});
