const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsPanel, SettingsNav } from '/src/components/Settings';
import '/src/styles.css';
let snapshot = { providers: ['claude', 'codex', 'antigravity'].map(provider => ({ provider, selectedId: 'default', accounts: [
  { id: 'default', provider, label: 'Connected CLI account', email: 'personal@example.test', plan: 'pro', state: 'ready' },
  { id: 'work', provider, label: 'Work', email: 'work@example.test', plan: 'team', state: 'ready' },
  { id: 'business', provider, label: 'Business', email: 'business@example.test', plan: provider === 'claude' ? 'self_serve_business_polite' : 'business', state: 'ready' },
] })) };
window.calls = [];
window.cli = { state: 'missing' };
window.progressListener = null;
window.milagre = {
 getCliStatus: async () => ({ antigravity: window.cli }),
 onCliProgress: (callback) => { window.progressListener = callback; return () => {}; },
 updateCli: async (provider) => {
   window.calls.push({action:'install', provider});
   await new Promise(resolve => { window.finishInstall = resolve; });
   window.cli = { state: 'ready' };
   return { ok: true, version: '1.3.0' };
 },
 listAccounts: async () => ({ providers: snapshot.providers.map(group => ({ ...structuredClone(group), installed: group.provider !== 'antigravity' || window.cli.state !== 'missing' })) }),
 listRecentProjects: async () => [],
 onAccountsChanged: () => () => {},
 accountAction: async (action, provider, value) => {
   window.calls.push({action, provider, value});
   const group = snapshot.providers.find(p => p.provider === provider);
   if (action === 'select') group.selectedId = value;
   if (action === 'add') group.accounts.push({id:'new', provider, label:value, state:'signing-in', message:'Finish signing in in the browser on your computer.'});
   if (action === 'cancel') group.accounts.find(a => a.id === value).state = 'signed-out';
   if (action === 'login') group.accounts.find(a => a.id === value).state = 'signing-in';
   if (action === 'remove') { group.accounts = group.accounts.filter(a => a.id !== value); if(group.selectedId === value) group.selectedId = 'default'; }
   return structuredClone(snapshot);
 }
};
document.documentElement.classList.add('dark');
createRoot(document.getElementById('root')).render(<div style={{display:'flex',height:'100vh',padding:16,gap:16}}><SettingsNav section="accounts" onSelect={()=>{}} onBack={()=>{}} /><main style={{flex:1}}><SettingsPanel section="accounts" models={[]} /></main></div>);
`;
async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-accounts-ui-")));
  await app.whenReady();
  const win = new BrowserWindow({ width: 1120, height: 850, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) => win.webContents.executeJavaScript(source);
  const waitFor = async (source) => {
    for (let i = 0; i < 160; i++) {
      if (await evaluate(source)) return;
      await delay(50);
    }
    throw new Error("Timed out: " + source);
  };
  const click = (label) => evaluate(`([...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(label)})).click()`);
  const shot = async (name) => {
    const dir = process.env.MILAGRE_SCREENSHOT_DIR;
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      await delay(250);
      fs.writeFileSync(path.join(dir, name + ".png"), (await win.webContents.capturePage()).toPNG());
    }
  };
  try {
    await win.loadURL(process.argv[2]);
    await waitFor(`document.body.textContent.includes('personal@example.test')`);
    await shot("accounts");
    // Antigravity installs from the Antigravity group, with the download's progress.
    await waitFor(
      `!!document.querySelector('[data-antigravity-row]') && document.querySelector('[data-antigravity-row]').textContent.includes('Not installed')`,
    );
    const antigravitySection = `document.querySelector('[data-antigravity-row]').closest('section')`;
    assert.equal(await evaluate(`${antigravitySection}.textContent.includes('Add account')`), false);
    assert.equal(await evaluate(`${antigravitySection}.querySelector('[role=radio]') !== null`), false);
    assert.equal(
      await evaluate(`(() => {
      const row = document.querySelector('[data-antigravity-row]');
      return Math.round(row.closest('section').getBoundingClientRect().bottom - row.getBoundingClientRect().bottom);
    })()`),
      12,
      "The install row keeps its bottom inset without account controls",
    );
    await evaluate(`${antigravitySection}.scrollIntoView({block:'center'})`);
    await shot("antigravity-install");
    await click("Install");
    await waitFor(`window.calls.some(c=>c.action==='install' && c.provider==='antigravity')`);
    await evaluate(`window.progressListener({provider:'antigravity',phase:'download',received:46137344,total:111456962})`);
    await waitFor(`document.querySelector('[data-antigravity-row]').textContent.includes('Downloading 44 of 106 MB')`);
    assert.equal(await evaluate(`document.querySelector('[data-antigravity-row] [role=progressbar]').getAttribute('aria-valuenow')`), "41");
    await shot("antigravity-downloading");
    await evaluate(`window.finishInstall()`);
    await waitFor(`document.querySelector('[data-antigravity-row]').textContent.includes('Installed.')`);
    await waitFor(`${antigravitySection}.querySelector('[role=radio]') !== null`);
    assert.equal(await evaluate(`${antigravitySection}.textContent.includes('Add account')`), true);
    await evaluate(`${antigravitySection}.scrollIntoView({block:'center'})`);
    await shot("antigravity-installed");
    assert.equal(await evaluate(`!!document.querySelector('[role=radio][aria-label="work@example.test"]')`), true, "Account row is directly selectable");
    await evaluate(`document.querySelector('[role=radio][aria-label="work@example.test"]').click()`);
    await waitFor(`window.calls.some(c=>c.action==='select' && c.provider==='claude' && c.value==='work')`);
    assert.equal(await evaluate(`document.querySelectorAll('[aria-label="Team account"]').length`), 3);
    assert.equal(await evaluate(`document.querySelectorAll('[aria-label="Business account"]').length`), 3);
    assert.equal(await evaluate(`document.querySelectorAll('[aria-label="Personal account"]').length`), 3);
    assert.equal(await evaluate(`document.body.textContent.includes('self_serve_business_polite')`), false);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('[role=radio][aria-label="work@example.test"]')).cursor`), "pointer");
    await shot("selected-account");
    await click("Re-authenticate");
    await waitFor(`window.calls.some(c=>c.action==='login' && c.value==='work')`);
    assert.equal(await evaluate(`window.calls.filter(c=>c.action==='select').length`), 1);
    await click("Cancel");
    await click("Remove");
    await waitFor(`document.querySelectorAll('[role=radio][aria-label="work@example.test"]').length===2`);
    await click("Add account");
    await evaluate(
      `(()=>{const input=document.querySelector('input[placeholder="Personal or work"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Second account');input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await shot("add-account");
    await click("Continue to sign in");
    await waitFor(`document.body.textContent.includes('Finish signing in')`);
    await shot("signing-in");
    await click("Cancel");
    await waitFor(`document.body.textContent.includes('Not signed in')`);
    assert.deepEqual(await evaluate("window.calls.map(c=>c.action)"), ["install", "select", "login", "cancel", "remove", "add", "cancel"]);
    console.log("PASS: Account rows switch directly; re-authenticate, remove, add and cancel work without selecting incidentally.");
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
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
        name: "accounts-fixture",
        resolveId: (id) => (id === "/__accounts.tsx" ? id : null),
        load: (id) => (id === "/__accounts.tsx" ? fixture : null),
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (req, res, next) => {
            if (req.url !== "/__accounts__") return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await server.transformIndexHtml(req.url, '<html><body><div id="root"></div><script type="module" src="/__accounts.tsx"></script></body></html>'),
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
    const child = spawn(require("electron"), [__filename, server.resolvedUrls.local[0] + "__accounts__", "-ApplePersistenceIgnoreState", "YES"], {
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
