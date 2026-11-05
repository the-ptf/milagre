// Browser comments use the same editable pins as Designs, over a real Electron webview.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");
const fixture = `
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CommentControls, PageCommenting } from '/src/components/agents/BrowserComments';
import { openBrowserTab, chatBrowser } from '/src/lib/browser-panel';
import { showBrowserPage } from '/src/lib/browser-webviews';
import { pageComments } from '/src/lib/page-comments';
import '/src/styles.css';
window.sent = []; window.saved = []; window.failSend = false;
window.milagre = { pageComments: { add: async ({comments}) => { if(window.holdSave) await new Promise(resolve => { window.finishSave = resolve; }); window.saved.push(...comments); return comments.map(c => ({...c,selector:c.element.selector,point:c.element.point,label:c.element.label,createdAt:1})); } } };
const key = '/fixture#1';
openBrowserTab(key, location.origin + '/page');
const tab = chatBrowser(key).tabs[0];
window.comments = () => pageComments(key);
function Fixture() {
  const slot = useRef(null); const [ready, setReady] = useState(false);
  useEffect(() => { const off = showBrowserPage(key, tab.id, slot.current); setReady(true); return off; }, []);
  return <div style={{height:'100vh',display:'flex',flexDirection:'column'}}>
    <header style={{height:48,display:'flex',alignItems:'center',justifyContent:'flex-end',gap:8,padding:8}}>
      <CommentControls chatKey={key} live onSend={async (text) => { if(window.failSend) return false; if(window.holdSend) await new Promise(resolve => { window.finishSend = resolve; }); window.sent.push(text); return true; }} />
    </header>
    <div ref={slot} style={{flex:1,minHeight:0}} />
    {ready && <PageCommenting chatKey={key} tab={tab} live />}
  </div>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
`;
async function checks() {
  const { app, BrowserWindow, webContents } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "milagre-page-comments-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 1000, height: 800, show: false, webPreferences: { webviewTag: true, backgroundThrottling: false } });
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") console.error(details.message);
  });
  const run = (code) =>
    window.webContents.executeJavaScript(code).catch((error) => {
      throw Error(error.message + " in: " + code);
    });
  const wait = async (code) => {
    for (let i = 0; i < 160; i++) {
      if (await run(code)) return;
      await delay(50);
    }
    throw Error("Timed out: " + code);
  };
  const key = (keyCode, modifiers = []) => {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  };
  try {
    await window.loadURL(process.argv[2]);
    await wait(`document.querySelector('webview')`);
    await delay(1000);
    const guest = webContents.fromId(await run(`document.querySelector('webview').getWebContentsId()`));
    await run(`document.querySelector('[data-slot=browser-comment-toggle]').click()`);
    await delay(300);
    guest.sendInputEvent({ type: "mouseMove", x: 130, y: 120 });
    guest.sendInputEvent({ type: "mouseDown", x: 130, y: 120, button: "left", clickCount: 1 });
    guest.sendInputEvent({ type: "mouseUp", x: 130, y: 120, button: "left", clickCount: 1 });
    await wait(`document.activeElement?.tagName === 'TEXTAREA'`);
    await window.webContents.insertText("Keep this draft");
    key("Enter");
    await wait(`!document.querySelector('textarea')`);
    assert.equal(await run("sent.length"), 0, "Enter keeps without sending");
    assert.equal(await run("comments().pending[0].text"), "Keep this draft");
    await run(`document.querySelector('[data-slot=artifact-pin]').click()`);
    await wait(`document.activeElement?.tagName === 'TEXTAREA'`);
    assert.equal(await run(`document.querySelector('textarea').value`), "Keep this draft");
    assert.equal(await run(`getComputedStyle(document.querySelector('textarea')).outlineStyle`), "none", "no field focus outline");
    await run(`document.querySelector('textarea').setSelectionRange(15,15)`);
    key("Enter", ["shift"]);
    window.webContents.sendInputEvent({ type: "char", keyCode: "\r", modifiers: ["shift"] });
    await window.webContents.insertText("More detail");
    await wait(`comments().pending[0].text.includes('\\n')`);
    await run("window.failSend = true");
    key("Enter", ["meta"]);
    await wait(`document.querySelector('[data-slot=browser-send-comments]').textContent.includes('Retry')`);
    assert.equal(await run("comments().pending.length"), 1, "failed sends retain the draft");
    await run("window.failSend = false");
    await run(`document.querySelector('[data-slot=artifact-pin]').click()`);
    await wait(`document.activeElement?.tagName === 'TEXTAREA'`);
    key("Enter", ["meta"]);
    await wait("sent.length === 1 && comments().pending.length === 0");
    assert.match(await run("sent[0]"), /More detail/, "send includes the current open draft");
    await wait(`document.querySelector('[data-slot=artifact-sent-pin]')`);
    await run(`document.querySelector('[data-slot=artifact-sent-pin]').click()`);
    await wait(`document.querySelector('[data-slot=artifact-comment-bubble]') && !document.querySelector('textarea')`);
    assert.equal(await run(`document.querySelector('[data-slot=artifact-comment-bubble]').textContent.includes('More detail')`), true);
    key("Escape");
    await run(`document.querySelector('[data-slot=browser-comment-toggle]').click()`);
    await delay(300);
    guest.sendInputEvent({ type: "mouseMove", x: 150, y: 120 });
    guest.sendInputEvent({ type: "mouseDown", x: 150, y: 120, button: "left", clickCount: 1 });
    guest.sendInputEvent({ type: "mouseUp", x: 150, y: 120, button: "left", clickCount: 1 });
    await wait(`document.activeElement?.tagName === 'TEXTAREA'`);
    await window.webContents.insertText("Snapshot to send");
    const originalId = await run("comments().pending[0].id");
    await run("window.holdSend = true; window.holdSave = true");
    key("Enter", ["meta"]);
    await wait("!!window.finishSend");
    await wait(`!document.querySelector('[data-slot=artifact-comment-bubble]')`);
    assert.equal(await run("comments().open"), null, "sending collapses the bubble before delivery finishes");
    assert.equal(await run("comments().commenting"), false, "sending exits comment placement mode");
    await run(`document.querySelector('[data-slot=artifact-pin]').click()`);
    await wait(`document.activeElement?.tagName === 'TEXTAREA'`);
    await run(`document.querySelector('textarea').setSelectionRange(16,16)`);
    await window.webContents.insertText(" plus later edits");
    await run("window.finishSend()");
    await wait("!!window.finishSave");
    await window.webContents.insertText(" while saving");
    await run("window.holdSend = false; window.holdSave = false; window.finishSave()");
    await wait(`sent.length === 2 && !document.querySelector('textarea')`);
    assert.equal(await run("comments().pending[0]?.text"), "Snapshot to send plus later edits while saving");
    assert.notEqual(await run("comments().pending[0]?.id"), originalId);
    assert.match(await run("sent[1]"), /Snapshot to send/);
    assert.doesNotMatch(await run("sent[1]"), /later edits|while saving/);
    await run(`document.querySelector('[data-slot=artifact-pin]').click()`);
    await wait(`document.activeElement?.tagName === 'TEXTAREA'`);
    assert.equal(await run("document.querySelector('textarea').value"), "Snapshot to send plus later edits while saving");
    key("Enter", ["meta"]);
    await wait("sent.length === 3 && comments().pending.length === 0");
    assert.match(await run("sent[2]"), /later edits while saving/);
    assert.equal(await run("new Set(saved.map(pin => pin.id)).size"), 3, "the edited draft sends as a distinct comment");
    await run(`[...document.querySelectorAll('[data-slot=artifact-sent-pin]')].at(-1).click()`);
    await wait(`!!document.querySelector('[data-slot=artifact-comment-bubble]')`);
    window.setContentSize(340, 800);
    await wait(`(() => {
      const box = document.querySelector('[data-slot=artifact-comment-bubble]')?.getBoundingClientRect();
      return box && box.left >= 0 && box.right <= innerWidth;
    })()`);
    assert.equal(
      await run(`(() => {
      const box = document.querySelector('[data-slot=artifact-comment-bubble]').getBoundingClientRect();
      return box.left >= 8 && box.right <= innerWidth - 8;
    })()`),
      true,
      "narrow Browser panels keep the whole bubble visible",
    );
    if (process.env.MILAGRE_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "browser-shared-comment.png"), (await window.webContents.capturePage()).toPNG());
    }
    console.log(
      "PASS: Browser uses Design bubbles; Enter keeps, Shift+Enter adds a line, Cmd+Enter sends the current draft, retry retains text, and sent pins reopen.",
    );
  } finally {
    window.destroy();
    app.quit();
  }
}
async function main() {
  const { createServer } = await import("vite");
  const server = await createServer({
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
    plugins: [
      {
        name: "page-comments-fixture",
        resolveId: (id) => (id === "/__comment_fixture.tsx" ? id : undefined),
        load: (id) => (id === "/__comment_fixture.tsx" ? fixture : undefined),
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (req, res, next) => {
            if (req.url === "/page") {
              res.setHeader("Content-Type", "text/html");
              res.end(
                '<html><title>Comment target</title><body style="height:2000px;margin:0"><button style="position:absolute;left:80px;top:100px;width:180px;height:60px">Change this button</button></body></html>',
              );
              return;
            }
            if (req.url !== "/__comments__") return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await server.transformIndexHtml(
                req.url,
                '<html><body><div id="root"></div><script type="module" src="/__comment_fixture.tsx"></script></body></html>',
              ),
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
    const child = require("node:child_process").spawn(require("electron"), [__filename, server.resolvedUrls.local[0] + "__comments__"], {
      env,
      stdio: "inherit",
    });
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await server.close();
  }
}
(process.versions.electron ? checks() : main()).catch((error) => {
  console.error(error);
  if (process.versions.electron) require("electron").app.exit(1);
  else process.exitCode = 1;
});
