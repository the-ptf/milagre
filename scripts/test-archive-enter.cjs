const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");
const shots = process.env.MILAGRE_SCREENSHOT_DIR && path.resolve(process.env.MILAGRE_SCREENSHOT_DIR);
const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { ChatRow } from "/src/components/sidebar/ChatRow";
import "/src/styles.css";
window.calls = [];
window.checks = 0;
// The worktree check resolves only when the check says so, to cover Enter while it is pending.
let release;
window.releaseCheck = () => release?.();
const plan = { milagreOwned: true, shared: false, status: { uncommitted: 0, unpushed: 0, branch: "fix", head: "abc", removable: true } };
const actions = {
  onArchiveCheck: () => (window.checks++, new Promise(resolve => { release = () => resolve(plan); })),
  onArchive: (id, mode) => { window.calls.push("archive:" + mode); return new Promise(resolve => { window.finishArchive = resolve; }); },
  onMarkUnread: (id, unread) => window.calls.push("unread:" + unread),
  onRename: () => {},
};
document.documentElement.classList.add("dark");
document.body.style.cssText = "margin:0;background:#202123";
createRoot(document.getElementById("root")).render(
  <aside data-sidebar-collapsed="false" style={{ width: 300, paddingTop: 8 }}>
    <ChatRow item={{ id: "1", label: "the chat names aren't great", mark: "idle" }} active collapsed={false} actions={actions} onPick={() => {}} />
  </aside>,
);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  await app.whenReady();
  const win = new BrowserWindow({ width: 520, height: 420, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) => win.webContents.executeJavaScript(source);
  async function waitFor(source) {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(source)) return;
      await delay(20);
    }
    throw Error(`Timed out: ${source}`);
  }
  // Real input events, so focus moves the way a mouse click and a key press move it.
  async function click(selector) {
    const { x, y } = await evaluate(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
    );
    win.webContents.sendInputEvent({ type: "mouseMove", x, y });
    win.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    win.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    await delay(60);
  }
  async function press(keyCode) {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode });
    if (keyCode === "Enter") win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode });
    await delay(60);
  }
  const shot = async (name) => {
    if (!shots) return;
    // Let the menu finish its pop-in and paint before reading the frame.
    await evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
    await delay(250);
    await require("node:fs/promises").mkdir(shots, { recursive: true });
    await require("node:fs/promises").writeFile(path.join(shots, name), (await win.webContents.capturePage()).toPNG());
  };
  const archiveRow = '[data-chat-menu] [role="menuitem"]:last-of-type';
  const openMenu = async () => {
    await click('[aria-label="Chat actions"]');
    await waitFor('document.querySelector("[data-chat-menu]")');
  };
  try {
    await win.loadURL(process.argv[2]);
    await waitFor('document.querySelector("[aria-label=\\"Chat actions\\"]")');
    win.focus();

    // The worktree is checked as the menu opens; until then Archive is disabled and there is no checking row.
    await openMenu();
    assert.equal(await evaluate("window.checks"), 1, "Opening the menu starts the check");
    assert.equal(await evaluate(`document.querySelector('${archiveRow}').textContent`), "Archive");
    assert.ok(await evaluate(`document.querySelector('${archiveRow}').disabled`), "Archive waits for the check");
    await shot("pending.png");
    await click(archiveRow);
    await press("Enter");
    assert.deepEqual(await evaluate("window.calls"), [], "Nothing archives before the check is back");
    assert.equal(await evaluate('!!document.querySelector("[data-archive-choice]")'), false, "A click before the check doesn't arm");

    // Once checked, Archive goes straight to its choice, and Enter confirms it wherever focus is.
    await evaluate("window.releaseCheck()");
    await waitFor(`!document.querySelector('${archiveRow}').disabled`);
    await click(archiveRow);
    assert.equal(
      await evaluate('document.querySelector("[data-archive-choice]")?.textContent'),
      "Archive and remove worktree",
      "No checking step after the click",
    );
    assert.equal(await evaluate('document.body.textContent.includes("Checking worktree")'), false);
    await shot("armed.png");
    await evaluate("document.activeElement.blur()");
    await press("Enter");
    assert.deepEqual(await evaluate("window.calls"), ["archive:remove"], "Enter confirms the archive");
    await waitFor('!document.querySelector("[data-chat-menu]")');

    assert.ok(await evaluate('document.querySelector("[role=status]")?.textContent.includes("Archiving")'), "Pending archive is visible after the menu closes");
    assert.ok(
      await evaluate(`(() => {
        const row = document.querySelector("[data-row]").getBoundingClientRect();
        const box = document.querySelector("[role=status]").getBoundingClientRect();
        return document.querySelector("[data-row]").disabled && box.top <= row.top && box.bottom >= row.bottom && box.width >= row.width;
      })()`),
      "The progress covers the whole row, which takes no clicks",
    );
    await shot("archiving.png");
    await click('[aria-label="Chat actions"]');
    assert.equal(await evaluate('!!document.querySelector("[data-chat-menu]")'), false, "Pending archive cannot be repeated");
    await evaluate("window.finishArchive()");
    await waitFor('!document.querySelector("[role=status]")');

    // A row reached with the arrow keys keeps Enter for itself.
    await evaluate("window.calls = []");
    await openMenu();
    await evaluate("window.releaseCheck()");
    await waitFor(`!document.querySelector('${archiveRow}').disabled`);
    await click(archiveRow);
    await waitFor('document.querySelector("[data-archive-choice]")');
    await press("Up");
    assert.equal(await evaluate("document.activeElement.textContent"), "Mark as unread");
    await press("Enter");
    assert.deepEqual(await evaluate("window.calls"), ["unread:true"], "Enter on another row runs that row only");

    console.log("PASS: check runs on open, Archive waits for it with no checking row, Enter confirms wherever focus is, arrowed rows keep Enter");
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
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "archive-enter-fixture",
        resolveId(id) {
          if (id === "/__archive_enter_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__archive_enter_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__archive_enter__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__archive_enter_fixture.tsx"></script></body></html>',
            );
            response.setHeader("Content-Type", "text/html");
            response.end(html);
          });
        },
      },
    ],
  });
  try {
    await server.listen();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__archive_enter__`], { env, stdio: "inherit" });
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
