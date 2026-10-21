const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ProviderUpdateNotice } from '/src/components/ProviderUpdateNotice';
import '/src/styles.css';
window.release = '0.163.0'; window.installed = false; window.calls = []; window.fail = true;
window.milagre = {
 getProviderUpdates: async () => window.installed ? [] : [{provider:'codex',installedVersion:'0.160.0',version:window.release}],
 updateCli: async (...args) => { window.calls.push(args); await new Promise(resolve => window.finish = resolve); if(window.fail) return {ok:false,error:'Permission denied. Try again.'}; window.installed=true; return {ok:true}; }
};
window.settings = 0;
document.documentElement.classList.add('dark');
const root=createRoot(document.getElementById('root'));
window.mount=()=>root.render(<div style={{display:'flex',padding:40,justifyContent:'flex-end'}}><ProviderUpdateNotice key={window.release} onSettings={()=>window.settings++} /></div>);
window.mount();
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-provider-updates-")));
  await app.whenReady();
  const win = new BrowserWindow({ width: 794, height: 400, show: false, webPreferences: { backgroundThrottling: false } });
  const run = (s) => win.webContents.executeJavaScript(s);
  const wait = async (s) => {
    for (let n = 0; n < 160; n++) {
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
    await wait("document.body.textContent.includes('Codex v0.163.0')");
    await shot("available");
    await click("Settings");
    assert.equal(await run("window.settings"), 1);
    await click("Update");
    await wait("document.body.textContent.includes('Updating…')");
    assert.equal(await run("document.querySelector('[aria-label=\"Dismiss Codex update\"]').disabled"), true);
    assert.deepEqual(await run("window.calls"), [["codex", "0.163.0"]]);
    await run("window.finish()");
    await wait("document.body.textContent.includes('Permission denied')");
    await shot("failed");
    await click("Retry");
    await run("window.fail=false;window.finish()");
    await wait("!document.querySelector('[data-provider-update]')");
    await run("window.release='0.164.0';window.installed=false;window.mount()");
    await wait("document.body.textContent.includes('Codex v0.164.0')");
    await run("document.querySelector('[aria-label=\"Dismiss Codex update\"]').click()");
    await wait("!document.querySelector('[data-provider-update]')");
    console.log("Provider update cards: settings, install target, pending, failure, retry, success and dismissal passed.");
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
          server.middlewares.use(async (req, res, next) => {
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
