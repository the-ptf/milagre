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
window.records=[]; window.created=[]; window.copied='';
window.clients=[['claude-code','Claude Code CLI'],['codex','Codex CLI'],['gemini','Gemini CLI'],['antigravity','Antigravity'],['opencode','OpenCode CLI'],['kiro','Kiro CLI'],['claude-desktop','Claude Desktop']].map(([id,label])=>({id,label,enabled:false,state:'off',configPath:'/fixture/'+id}));
Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copied=text; } } });
const localMcp = {
 enableClient: async(id,config)=>{const connection={...config,id:'managed-'+id,clientId:id,revision:1,createdAt:'2026-10-13T00:00:00Z'};window.created.push(config);window.clients=window.clients.map(c=>c.id===id?{...c,connection,enabled:true,state:'configured'}:c);return window.clients.find(c=>c.id===id);},
 disableClient: async id=>{window.clients=window.clients.map(c=>c.id===id?{...c,enabled:false,state:'off',connection:undefined}:c);return window.clients.find(c=>c.id===id);},
 status: async()=>({url:'http://127.0.0.1:1234/mcp', connections:window.records, clients:window.clients, projects:[{id:'/test/project',path:'/test/project',name:'Project'}],groups:[{id:'designs',enabled:true}]}),
 create: async config => { const connection={...config,id:'c'+window.records.length,revision:1,createdAt:'2026-10-13T00:00:00Z'}; window.created.push(config);window.records=[...window.records,connection];return {connection,url:'http://127.0.0.1:1234/mcp',token:'fixture-secret'}; },
 update: async (id,config)=>{window.records=window.records.map(c=>c.id===id?{...c,...config,revision:c.revision+1}:c);return window.records.find(c=>c.id===id);},
 rotate: async id=>({connection:window.records.find(c=>c.id===id),url:'http://127.0.0.1:1234/mcp',token:'replacement-secret'}),
 revoke: async id=>{window.records=window.records.map(c=>c.id===id?{...c,revokedAt:'2026-10-13T00:00:00Z'}:c);},
};
document.documentElement.classList.add('dark');
window.milagre={localMcp,listAccounts:async()=>({providers:[]}),listRecentProjects:async()=>[],onAccountsChanged:()=>()=>{}};
createRoot(document.getElementById('root')).render(<div style={{display:'flex',height:'100vh',padding:16,gap:16}}><SettingsNav section="local-mcp" onSelect={()=>{}} onBack={()=>{}} /><main className="bg-page rounded-2xl" style={{flex:1}}><SettingsPanel section="local-mcp" models={[]} /></main></div>);
`;
async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-local-mcp-ui-")));
  await app.whenReady();
  const win = new BrowserWindow({ width: 1120, height: 980, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) => win.webContents.executeJavaScript(source);
  const waitFor = async (source) => {
    for (let i = 0; i < 160; i++) {
      if (await evaluate(source)) return;
      await delay(50);
    }
    throw Error("Timed out: " + source);
  };
  const click = async (text) => {
    await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)}).click()`);
    await delay(75);
  };
  const fill = async (label, value) => {
    await evaluate(
      `(()=>{const input=document.querySelector('[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await delay(75);
  };
  try {
    await win.loadURL(process.argv[2]);
    // Radix selects arrow-key destinations on focus. A hidden window changes activeElement
    // without dispatching focus events, so keyboard verification needs an actual focused window.
    win.show();
    if (process.platform === "darwin") app.focus({ steal: true });
    win.focus();
    await waitFor(`document.hasFocus()`);
    await waitFor(`document.querySelectorAll('[data-local-mcp] [role=checkbox]').length===8`);
    // Milagre holds Published pages above its MCP, and no Designs switch.
    assert.equal(await evaluate(`document.querySelector('[data-slot=published-pages-setting]').textContent.includes('Published pages')`), true);
    assert.equal(await evaluate(`!!document.querySelector('[role=checkbox][aria-label="Designs"]')`), false);
    assert.equal(await evaluate(`document.querySelector('h1').textContent`), "Milagre");
    assert.equal(await evaluate(`!!document.querySelector('form')`), false);
    assert.equal(await evaluate(`!!document.querySelector('#custom-mcp-settings')`), false);
    assert.equal(await evaluate(`document.body.textContent.includes('Create MCP config')`), false);
    const shot = async (name) => {
      if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
      await waitFor(`!document.querySelector('[aria-busy=true]')`);
      await delay(350); // capture settled transitions, including a theme change
      fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), (await win.webContents.capturePage()).toPNG());
    };
    await evaluate(`document.querySelector('[data-local-client="claude-code"] [role=checkbox]').click()`);
    await waitFor(`!!document.querySelector('form')`);
    await evaluate(`document.querySelector('[role=radio][data-state=checked]').focus()`);
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" });
    await waitFor(`document.querySelector('[role=radio][aria-label="All Projects"]').getAttribute('aria-checked')==='true'`);
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right" });
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" });
    await waitFor(`document.querySelector('[role=radio][aria-label="Designs only"]').getAttribute('aria-checked')==='true'`);
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right" });
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Left" });
    await waitFor(`document.querySelector('[role=radio][aria-label="All Projects"]').getAttribute('aria-checked')==='true'`);
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Left" });
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Left" });
    await waitFor(`document.querySelector('[role=radio][aria-label="Projects"]').getAttribute('aria-checked')==='true'`);
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Left" });
    await evaluate(`document.querySelector('form [role=checkbox][aria-label="Project"]').focus()`);
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
    await waitFor(`document.querySelector('form [role=checkbox][aria-label="Project"]').getAttribute('aria-checked')==='true'`);
    await click("Enable Claude Code CLI");
    await waitFor(`document.querySelector('[data-local-client="claude-code"] [role=checkbox]').getAttribute('aria-checked')==='true'`);
    assert.deepEqual(await evaluate("window.created[0].grants.projects.projectPaths"), ["/test/project"]);
    await evaluate(`document.querySelector('[data-local-client="gemini"] [role=checkbox]').click()`);
    await waitFor(`!!document.querySelector('form')`);
    await evaluate(`document.querySelector('[role=radio][aria-label="All Projects"]').click()`);
    await click("Enable Gemini CLI");
    await waitFor(`document.querySelector('[data-local-client="gemini"] [role=checkbox]').getAttribute('aria-checked')==='true'`);
    assert.equal(await evaluate("window.created[1].grants.projects.projectPaths"), "*");
    assert.equal(await evaluate(`document.querySelector('[data-local-client="gemini"]').textContent.includes('All Projects')`), true);
    await evaluate(`document.querySelector('[data-local-client="codex"] [role=checkbox]').click()`);
    await waitFor(`!!document.querySelector('form')`);
    await evaluate(`document.querySelector('[role=radio][aria-label="Designs only"]').click()`);
    await fill("Chat reference", "/test/project#2");
    await fill("Design IDs", "one, two");
    await evaluate(`document.querySelector('form').scrollIntoView({block:'center'})`);
    await shot("local-mcp-client-access");
    await click("Enable Codex CLI");
    await waitFor(`document.querySelector('[data-local-client="codex"] [role=checkbox]').getAttribute('aria-checked')==='true'`);
    assert.deepEqual(await evaluate("window.created[2].grants"), { designs: { chatId: "/test/project#2", designIds: ["one", "two"], capabilities: ["read"] } });
    await evaluate(`document.querySelector('h1').scrollIntoView()`);
    await shot("local-mcp-clients-dark");
    await evaluate(`document.documentElement.classList.remove('dark')`);
    await delay(100);
    await shot("local-mcp-clients-light");
    await evaluate(`document.documentElement.classList.add('dark')`);
    await evaluate(`document.querySelector('[data-local-client="codex"] [role=checkbox]').click()`);
    await waitFor(`document.querySelector('[data-local-client="codex"] [role=checkbox]').getAttribute('aria-checked')==='false'`);
    await evaluate(`document.querySelector('[role=checkbox][aria-label="Custom MCP"]').click()`);
    await waitFor(`!!document.querySelector('#custom-mcp-settings form')`);
    await evaluate(`document.querySelector('#custom-mcp-settings [role=radio][aria-label="All Projects"]').click()`);
    assert.equal(await evaluate(`document.querySelector('#custom-mcp-settings button[type=submit]').disabled`), true);
    await fill("Connection name", "Design editor");
    assert.equal(await evaluate(`document.querySelector('#custom-mcp-settings button[type=submit]').disabled`), false);
    await evaluate(`document.querySelector('[role=radio][aria-label="Designs only"]').click()`);
    await fill("Chat reference", "/test/project#2");
    await fill("Design IDs", "one, two");
    await evaluate(`document.querySelector('form [role=checkbox][aria-label="Allow design edits"]').click()`);
    await evaluate(`document.querySelector('form').scrollIntoView({block:'center'})`);
    await shot("local-mcp-scope");
    await click("Create configuration");
    await waitFor(`!!document.querySelector('[data-local-credential]')`);
    assert.equal(await evaluate(`document.body.textContent.includes('fixture-secret')`), false);
    await click("Copy MCP config");
    assert.equal(await evaluate(`JSON.parse(window.copied).mcpServers.milagre.headers.Authorization`), "Bearer fixture-secret");
    await evaluate(`document.querySelector('[role=checkbox][aria-label="Custom MCP"]').click()`);
    await waitFor(`!document.querySelector('#custom-mcp-settings')`);
    assert.equal(await evaluate(`!!window.records[0].revokedAt`), false);
    await evaluate(`document.querySelector('[role=checkbox][aria-label="Custom MCP"]').click()`);
    await waitFor(`!!document.querySelector('#custom-mcp-settings')`);
    assert.equal(await evaluate(`!!document.querySelector('[data-local-credential]')`), false);
    await evaluate(`document.querySelector('details').open=true`);
    await click("Restrict to read");
    await waitFor(`window.records[0].grants.designs.capabilities.length===1`);
    await click("Replace credential");
    await waitFor(`!!document.querySelector('[data-local-credential]')`);
    await click("Copy MCP config");
    assert.equal(await evaluate(`JSON.parse(window.copied).mcpServers.milagre.headers.Authorization`), "Bearer replacement-secret");
    await click("Done");
    await click("Revoke");
    await waitFor(`document.body.textContent.includes('(Revoked)')`);
    assert.equal(await evaluate(`document.querySelector('[data-local-connection]').querySelectorAll('button').length`), 0);
    console.log("PASS: custom MCP stays hidden until selected, closing clears its credential, and shadcn scope controls support keyboard and saved grants.");
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
        name: "local-mcp-fixture",
        resolveId: (id) => (id === "/__local_mcp.tsx" ? id : null),
        load: (id) => (id === "/__local_mcp.tsx" ? fixture : null),
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (req, res, next) => {
            if (req.url !== "/__local_mcp__") return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await server.transformIndexHtml(req.url, '<html><body><div id="root"></div><script type="module" src="/__local_mcp.tsx"></script></body></html>'),
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
    const child = spawn(require("electron"), [__filename, server.resolvedUrls.local[0] + "__local_mcp__", "-ApplePersistenceIgnoreState", "YES"], {
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
