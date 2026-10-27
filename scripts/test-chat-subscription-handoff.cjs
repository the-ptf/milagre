// Real React commits with production desktop/mobile paging hooks; only the network is scripted.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const fixture = `
import React, { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { useChatMessages } from './apps/desktop/app/src/lib/chat-messages.ts';
import { useChatPage } from './apps/mobile/src/chat-pages.ts';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.milagre = {
  onRuntimeSnapshot(listener) { window.receiveSnapshot = listener; return () => {}; },
  onComputerEvent(listener) { window.receiveComputerEvent = listener; return () => {}; },
};
const messages = Array.from({length:120}, (_,i) => ({id:i+1, session_id:1, role:i%2?'assistant':'user', body:'message '+i}));
const requests = [];
async function read(_scope, _id, options) {
  requests.push(options);
  const end = options.before ? messages.findIndex(m=>m.id===options.before) : messages.length;
  const start = Math.max(0,end-40);
  return {messages:messages.slice(start,end), total:120, hasMore:start>0};
}
window.read = read;
const client = {url:'ws://handoff', chatMessages:read};
function check(value, message) { if (!value) throw new Error(message); }
window.run = async () => {
  for (const platform of ['desktop','mobile']) {
    let current;
    function Reader({enabled}) {
      const page = platform==='desktop' ? useChatMessages('/p',enabled?1:null) : useChatPage(client,'/p',enabled?1:null);
      if(enabled) current=page;
      return enabled ? React.createElement('div',null,page.messages.length) : null;
    }
    function Grid({focused}) {
      return React.createElement(React.Fragment,null,
        React.createElement(Reader,{key:'tile',enabled:!focused}),
        focused && React.createElement(Reader,{key:'focused',enabled:true}));
    }
    const host = document.createElement('div'); document.body.append(host);
    const root=createRoot(host);
    const render = async focused => { await act(async()=>root.render(React.createElement(StrictMode,null,React.createElement(Grid,{focused})))); };
    await render(false);
    await act(async()=>current.loadEarlier());
    await act(async()=>current.loadEarlier());
    check(current.messages.length===120,platform+': initial expanded history');
    const initialReads = requests.filter(r=>!r.before && r.turns===20).length;
    await render(true);
    check(current.messages.length===120,platform+': focusing trimmed expanded history to '+current.messages.length);
    await render(false);
    check(current.messages.length===120,platform+': restoring tile trimmed history');
    check(requests.filter(r=>!r.before && r.turns===20).length===initialReads,platform+': handoff refetched initial history');
    await act(async()=>root.render(null));
    await render(false);
    check(current.messages.length===40,platform+': truly inactive history was not trimmed');
    check(current.hasMore,platform+': trimmed history must be reloadable');
    await act(async()=>current.loadEarlier());
    await act(async()=>current.loadEarlier());
    check(current.messages.length===120,platform+': could not reload full history');
    await act(async()=>root.unmount()); host.remove();
  }
  for (const remote of [false, true]) {
    for (const stalled of [false, true]) {
      const scope = (remote ? 'remote|' : '') + '/reconnect-' + stalled;
      let current, finish, reads=0;
      const rows = [{id:1,session_id:2,role:'user',body:'A short Chat'}, {id:2,session_id:2,role:'assistant',body:'Its reply'}];
      window.read = async () => {
        if (++reads === 1) {
          if (stalled) return new Promise(resolve => { finish=()=>resolve({messages:[],total:0,hasMore:false}); });
          throw new Error('Daemon connection closed');
        }
        return {messages:rows,total:2,hasMore:false};
      };
      function ReconnectingReader() {
        current=useChatMessages(scope,2);
        return React.createElement('div',null,current.messages.map(m=>m.body).join(' '));
      }
      const host=document.createElement('div'); document.body.append(host);
      const root=createRoot(host);
      await act(async()=>root.render(React.createElement(ReconnectingReader)));
      check(current.messages.length===0,'interrupted first read should have no messages');
      const snapshot={projects:[{path:scope,state:{messages:[],messagesInChats:true}}]};
      await act(async()=>{
        if(remote) window.receiveComputerEvent({channel:'runtime:snapshot',payload:snapshot});
        else window.receiveSnapshot(snapshot);
      });
      check(current.messages.length===2,'reconnect must restore a short Chat without another message event');
      check(host.textContent.includes('Its reply'),'recovered short Chat must be rendered');
      if(finish) {
        await act(async()=>finish());
        check(current.messages.length===2,'an old empty page must not overwrite recovery');
      }
      await act(async()=>root.unmount()); host.remove();
    }
  }
  // The phone's refreshed snapshot already drives the production paging hook after reconnect.
  {
    let current, revision=0, reads=0;
    const client={url:'ws://reconnect-mobile',chatMessages:async()=>{
      if(++reads===1) throw new Error('Daemon connection closed');
      return {messages:[{id:1,role:'user',body:'Recovered short Chat'}],total:1,hasMore:false};
    }};
    function Reader() { current=useChatPage(client,'/phone-reconnect',1,revision); return React.createElement('div',null,current.messages.length); }
    const host=document.createElement('div'); document.body.append(host);
    const root=createRoot(host);
    await act(async()=>root.render(React.createElement(Reader)));
    check(current.error,'initial phone read should fail');
    revision++;
    await act(async()=>root.render(React.createElement(Reader)));
    check(current.messages.length===1 && !current.error,'refreshed phone snapshot must restore the short Chat');
    await act(async()=>root.unmount()); host.remove();
  }
  return 'PASS: desktop/mobile subscription handoff, StrictMode, inactive trim, failed/stalled short Chat reconnect, and late response isolation';
};
`;

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-chat-handoff-"));
  try {
    await require("esbuild").build({
      stdin: { contents: fixture, resolveDir: process.cwd(), sourcefile: "handoff-fixture.js", loader: "js" },
      bundle: true,
      outfile: path.join(dir, "fixture.js"),
      define: { "process.env.NODE_ENV": '"development"' },
      plugins: [
        {
          name: "network-boundary",
          setup(build) {
            build.onResolve({ filter: /\/(offline-cache|computer-bridge)\.ts$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
            build.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
              contents: args.path.endsWith("offline-cache.ts")
                ? "export function rememberChat() {}"
                : "export function bridgeForKey() { return {readChatMessages: (...args)=>window.read(...args)} }; export const isRemoteKey = () => false;",
            }));
          },
        },
      ],
    });
    fs.writeFileSync(path.join(dir, "index.html"), '<html><body><script src="fixture.js"></script></body></html>');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [__filename, path.join(dir, "index.html")], { env, stdio: "inherit" });
    process.exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
async function run() {
  const { app, BrowserWindow } = require("electron");
  const profile = path.join(path.dirname(process.argv[2]), "profile");
  fs.mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile);
  await app.whenReady();
  const timeout = setTimeout(() => {
    console.error("FAIL: handoff test timed out");
    app.exit(1);
  }, 30000);
  try {
    const window = new BrowserWindow({ show: false });
    window.webContents.on("console-message", (event) => {
      if (event.level === "error") console.error(event.message);
    });
    await window.loadFile(process.argv[2]);
    console.log(await window.webContents.executeJavaScript("window.run()"));
    clearTimeout(timeout);
    app.exit(0);
  } catch (error) {
    console.error(error);
    clearTimeout(timeout);
    app.exit(1);
  }
}
(process.versions.electron ? run() : main()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
