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
const scopes=[{key:'/alpha',name:'Alpha',kind:'project',projects:[{id:'a',path:'/alpha',name:'Alpha'}]},{key:'milagre-link:ab',name:'Alpha + Beta',kind:'link',projects:[{id:'a',path:'/alpha',name:'Alpha'},{id:'b',path:'/beta',name:'Beta'}]}];
const assigned={};
const snapshot=scopeKey=>({scopeKey,providers:['claude','codex'].map(provider=>({provider,accountId:assigned[scopeKey+provider]??null,effectiveId:assigned[scopeKey+provider]??'default',defaultId:'default',accounts:[{id:'default',provider,label:'Personal',email:'personal@example.test',plan:'pro',state:'ready'},{id:'work',provider,label:'Work',email:'work@example.test',plan:'team',state:'ready'},{id:'out',provider,label:'Signed out',email:'out@example.test',state:'signed-out'},...(assigned[scopeKey+provider]==='removed'?[{id:'removed',provider,label:'Removed account',state:'error',missing:true,message:'This assigned account was removed. Choose another account or use the computer default.'}]:[])]}))});
window.calls=[]; window.assigned=assigned; let changed=()=>{}; window.accountsChanged=()=>changed();
window.milagre={listRecentProjects:async()=>[],listAccountScopes:async()=>scopes,getProjectAccounts:async key=>snapshot(key),assignProjectAccount:async(key,provider,id)=>{window.calls.push({key,provider,id});assigned[key+provider]=id;return snapshot(key)},accountAction:async(action,provider,id)=>{window.calls.push({action,provider,id});},onAccountsChanged:fn=>{changed=fn;return()=>{}},getProjectImage:async()=>'/logo-milagre-image.png',setProjectIcon:async()=>null,setProjectHidden:async()=>{},readFilesToCopy:()=>new Promise(()=>{}),previewFilesToCopy:()=>new Promise(()=>{}),readWorktreeSetup:()=>new Promise(()=>{})};
const section=new URLSearchParams(location.search).get('section')||'project-accounts';
document.documentElement.classList.add('dark');
createRoot(document.getElementById('root')).render(<div style={{display:'flex',height:'100vh',padding:16,gap:16}}><SettingsNav section={section} onSelect={()=>{}} onBack={()=>{}}/><main style={{flex:1}}><SettingsPanel section={section} project={{path:"/alpha",name:"Alpha"}} models={[]} /></main></div>);
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
    const trigger = (provider) => `document.querySelector('[aria-label="${provider} account"]')?.textContent`;
    await waitFor(`${trigger("Claude")}?.includes('personal@example.test') && ${trigger("Claude")}.includes('Default')`);
    await waitFor(`document.querySelector('[aria-label="Project or Link"] img')?.naturalWidth > 0`);
    await shot("project-defaults");
    await evaluate(`document.querySelector('[aria-label="Claude account"]').click()`);
    assert.equal(await evaluate(`document.querySelector('[role="option"][disabled]').textContent.includes('out@example.test')`), true);
    await evaluate(`([...document.querySelectorAll('[role=option]')].find(b=>b.textContent.includes('work@example.test'))).click()`);
    await waitFor(`window.calls.length===1`);
    assert.deepEqual(await evaluate("window.calls[0]"), { key: "/alpha", provider: "claude", id: "work" });
    await shot("project-override");
    await evaluate(`document.querySelector('[aria-label="Project or Link"]').click()`);
    await waitFor(`document.querySelectorAll('[role=listbox] img').length === 3`);
    await shot("scope-picker");
    await evaluate(`([...document.querySelectorAll('[role=option]')].find(b=>b.textContent.includes('Alpha + Beta'))).click()`);
    await waitFor(`document.body.textContent.includes('independent')`);
    assert.equal(await evaluate(`${trigger("Claude")}.includes('Default')`), true);
    await shot("link-defaults");
    await evaluate(`window.assigned['milagre-link:abclaude']='out';window.accountsChanged()`);
    await waitFor(`document.querySelector('[aria-label="Claude account"]').textContent.includes('out@example.test')`);
    await shot("signed-out-assignment");
    await click("Re-authenticate");
    await waitFor(`window.calls.some(c=>c.action==='login' && c.id==='out')`);
    await evaluate(`window.assigned['milagre-link:abclaude']='removed';window.accountsChanged()`);
    await waitFor(`document.body.textContent.includes('The assigned account is unavailable')`);
    assert.equal(await evaluate(`${trigger("Claude")}.includes('Default')`), false);
    assert.equal(await evaluate(`([...document.querySelectorAll('button')].some(b=>b.textContent==='Re-authenticate'))`), false);
    await shot("unavailable-assignment");
    await evaluate(`document.querySelector('[aria-label="Claude account"]').click()`);
    await evaluate(`([...document.querySelectorAll('[role=option]')].find(b=>b.textContent.includes('Use computer default'))).click()`);
    await waitFor(`window.calls.some(c=>c.key==='milagre-link:ab' && c.id===null)`);
    // Project settings shows the same rows, fixed to that Project.
    await win.loadURL(process.argv[2] + "?section=project");
    await waitFor(`document.querySelector('[data-project-accounts-group]') && ${trigger("Codex")}?.includes('Default')`);
    assert.equal(await evaluate(`!!document.querySelector('[aria-label="Project or Link"]')`), false);
    await shot("project-settings");
    await evaluate(`document.querySelector('[aria-label="Codex account"]').click()`);
    await evaluate(`([...document.querySelectorAll('[role=option]')].find(b=>b.textContent.includes('work@example.test'))).click()`);
    await waitFor(`window.calls.some(c=>c.key==='/alpha' && c.provider==='codex' && c.id==='work')`);
    await waitFor(`${trigger("Codex")}.includes('work@example.test')`);
    await shot("project-settings-override");
    console.log(
      "PASS: Project overrides, defaults, disabled sign-ins, re-authentication, unavailable assignments and independent Link scope, and the Accounts group in project settings.",
    );
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
            if (req.url.split("?")[0] !== "/__accounts__") return next();
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
