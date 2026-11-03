const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");
const fixture = `
import React from "react";
import {createRoot} from "react-dom/client";
import {EditScopeControl} from "/src/components/EditScopeControl";
import "/src/styles.css";
window.saved=[];
window.view={revision:1,roots:["/fixture/work"],policy:{allowed:[{root:"/fixture/work",path:"src"}],protected:[{root:"/fixture/work",path:"secret"}]},busy:false,warnings:[],capability:"Claude file-edit hooks block out-of-scope edits. Commands use observation only.",limits:"External paths and changes reverted between checks may escape detection."};
window.milagre={editScope:{
read:async()=>structuredClone(window.view),
save:async(request)=>{window.saved.push(request);window.view={...window.view,policy:request.policy,revision:window.view.revision+1};return structuredClone(window.view);},
resolve:async(request)=>{window.saved.push(request);window.view={...window.view,pending:undefined,queuedPolicy:window.view.pending.policy};return structuredClone(window.view);}
}};
createRoot(document.getElementById("root")).render(<div style={{padding:16}}><EditScopeControl chatId="/fixture#1" visible={true}/></div>);
`;
async function browser() {
  const { app, BrowserWindow } = require("electron");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-edit-scope-ui-"));
  app.setPath("userData", profile);
  app.setActivationPolicy?.("prohibited");
  await app.whenReady();
  app.dock?.hide();
  const window = new BrowserWindow({ width: 720, height: 800, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") errors.push(details.message);
  });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  const wait = async (source) => {
    for (let n = 0; n < 240; n++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw Error(`Timed out: ${source}`);
  };
  const shot = async (name) => {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    await delay(300);
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  try {
    await window.loadURL(process.argv[2]);
    await wait('document.querySelector("[data-edit-scope] button")?.textContent === "Edit scope active"');
    await evaluate('document.querySelector("[data-edit-scope] button").click()');
    await wait('!!document.querySelector("dialog[open]")');
    assert.match(await evaluate('document.querySelector("dialog").textContent'), /Commands use observation only/);
    await evaluate(
      '(()=>{const field=document.querySelector("textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(field,"src\\ntest");field.dispatchEvent(new Event("input",{bubbles:true}));})()',
    );
    await evaluate('[...document.querySelectorAll("dialog button")].find(b=>b.textContent==="Save scope").click()');
    await wait("window.saved.length === 1");
    assert.deepEqual(await evaluate("window.saved[0].policy"), {
      allowed: [
        { root: "/fixture/work", path: "src" },
        { root: "/fixture/work", path: "test" },
      ],
      protected: [{ root: "/fixture/work", path: "secret" }],
    });
    await shot("active");
    await evaluate(
      'window.view={...window.view,busy:true,pending:{id:"request-1",revision:2,reason:"Need fixtures",policy:{allowed:[{root:"/fixture/work",path:"."}],protected:[]}},warnings:[{kind:"outside",root:"/fixture/work",path:"other",message:"An out-of-scope change was observed.",at:1}]}',
    );
    await wait('document.querySelector("dialog").textContent.includes("Need fixtures")');
    assert.match(await evaluate('document.querySelector("dialog").textContent'), /No protected paths/);
    assert.equal(await evaluate('[...document.querySelectorAll("textarea")].every(f=>f.disabled)'), true);
    await evaluate('[...document.querySelectorAll("dialog button")].find(b=>b.textContent==="Approve for next turn").click()');
    await wait("window.saved.length === 2");
    assert.deepEqual(await evaluate("window.saved[1]"), { chatId: "/fixture#1", id: "request-1", approved: true });
    await shot("warning");
    await window.setContentSize(340, 740);
    await delay(150);
    assert.equal(await evaluate('(()=>{const d=document.querySelector("dialog").getBoundingClientRect();return d.left>=0&&d.right<=innerWidth})()'), true);
    await shot("narrow");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await wait('!document.querySelector("dialog")');
    assert.deepEqual(errors, []);
    console.log("PASS: edit scope paths, capability text, exact expansion approval, busy state and narrow dialog");
  } finally {
    window.destroy();
    await app.quit();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
async function main() {
  const { createServer } = await import("vite");
  const { spawn } = require("node:child_process");
  const server = await createServer({
    root: path.resolve(__dirname, "../apps/desktop/app"),
    configFile: false,
    resolve: { alias: { "@": path.resolve(__dirname, "../apps/desktop/app/src") } },
    optimizeDeps: { entries: [] },
    server: { host: "0.0.0.0", port: 0 },
    plugins: [
      {
        name: "edit-scope-fixture",
        resolveId(id) {
          if (id === "/__scope.tsx") return id;
        },
        load(id) {
          if (id === "/__scope.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__scope__") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(request.url, '<html><body><div id="root"></div><script type="module" src="/__scope.tsx"></script></body></html>'),
            );
          });
        },
      },
    ],
  });
  try {
    await server.listen();
    const env = { ...process.env, MILAGRE_BACKGROUND: "1" };
    delete env.ELECTRON_RUN_AS_NODE;
    const address = server.httpServer.address();
    const child = spawn(require("electron"), [__filename, `http://127.0.0.1:${address.port}/__scope__`], { env, stdio: "inherit" });
    process.exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await server.close();
  }
}
(process.versions.electron ? browser() : main()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
