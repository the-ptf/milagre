// Browser integration check for diff comments: select, write, edit, delete, send, outdated and persistence.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChangesPanel } from "/src/components/changes/ChangesPanel";
import { ChangesPanelSlot } from "/src/components/changes/ChangesPanelSlot";
import { ChangesToggle, DiffBar } from "/src/components/changes/ChangesChrome";
import { AnimatePresence } from "motion/react";
import { DiffToolbar, DiffView, useDiffPreferences, useDiffPresence } from "/src/components/changes/DiffView";
import { useChanges } from "/src/components/changes/useChanges";
import { useDiffComments } from "/src/components/changes/useDiffComments";
import { formatCommentsMessage } from "/src/lib/diff-comments";
import "/src/styles.css";
const listeners = new Set();
const FILES = {
  "src/a.ts": { status: "modified", added: 1, removed: 1, patch: [
    "@@ -1,6 +1,6 @@", ' import x from "x";', "-const a = 1;", "+const a = 2;", " const b = 3;", " const c = 4;", " const d = 5;", " export {};", ""].join("\\n") },
  "README.md": { status: "modified", added: 1, removed: 1, patch: ["@@ -1,3 +1,3 @@", " # Milagre", "-Old tagline", "+New tagline", " end", ""].join("\\n") },
};
const entries = () => Object.entries(FILES).map(([path, f]) => ({ path, status: f.status, added: f.added, removed: f.removed, binary: false }));
window.sent = [];
window.milagre = {
  git: {
    diffFiles: async () => ({ isRepo: true, base: "main", files: entries() }),
    diffFile: async request => ({ patch: FILES[request.path].patch, binary: false, tooLarge: false }),
  },
  onAgentEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); },
};
window.endTurn = () => listeners.forEach(listener => listener({ chatId: "chat-1", event: { type: "turn-completed" } }));
window.editA = () => { FILES["src/a.ts"].patch = FILES["src/a.ts"].patch.replace("+const a = 2;", "+const a = 3;"); };
function Fixture() {
  const changes = useChanges({ cwd: "/fixture", base: "main", chatId: "chat-1", available: true });
  const comments = useDiffComments("chat-1", changes);
  const prefs = useDiffPreferences();
  const diff = changes.diffOpen;
  const presence = useDiffPresence(diff);
  // Stands in for App's executeSend.
  const send = () => {
    const sent = comments.sendable;
    changes.closeDiff();
    window.sent.push(formatCommentsMessage(sent, { mode: changes.mode, base: "main" }));
    comments.removeMany(sent.map(comment => comment.id));
  };
  return <div className="flex h-screen gap-3 bg-canvas p-0 text-ink">
    <div aria-hidden data-drag-strip className="fixed inset-x-0 top-0 z-50 h-10 [-webkit-app-region:drag]" />
    <ChangesToggle open={changes.open} onToggle={changes.toggle} />
    <main className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden pr-3 pb-3">
      <DiffBar open={diff} onBack={changes.closeDiff} send={{ count: comments.sendable.length, onSend: send }} trailing={<DiffToolbar changes={changes} prefs={prefs} />} />
      <AnimatePresence initial={false} onExitComplete={presence.onExitComplete}>
        {diff && <DiffView key="diff" changes={changes} prefs={prefs} comments={comments} />}
      </AnimatePresence>
      <div data-chat-stub className={"flex-1 pt-12 px-6 text-[14px] " + (presence.occupied ? "hidden" : "")}>Chat goes here</div>
    </main>
    <ChangesPanelSlot open={changes.open}>
      <ChangesPanel lists={changes.lists} mode={changes.mode} onModeChange={changes.setMode} onRefresh={() => void changes.refresh()} onSelectFile={changes.selectFile} activePath={changes.activePath} commentCounts={comments.counts} />
    </ChangesPanelSlot>
  </div>;
}
localStorage.clear();
let root = createRoot(document.getElementById("root"));
root.render(<Fixture />);
window.remount = () => { root.unmount(); root = createRoot(document.getElementById("root")); root.render(<Fixture />); };
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  await app.whenReady();
  const window = new BrowserWindow({ width: 1200, height: 560, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) =>
    window.webContents.executeJavaScript(source).catch(() => {
      throw new Error(`evaluate failed: ${source}`);
    });
  async function waitFor(source) {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${source}`);
  }
  const shotDir = process.env.MILAGRE_SCREENSHOT_DIR;
  if (shotDir) fs.mkdirSync(shotDir, { recursive: true });
  const shot = async (name) => {
    if (shotDir) fs.writeFileSync(path.join(shotDir, `${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  const A = "src/a.ts";
  const file = (p) => `[data-diff-file="${p}"]`;
  const rows = (p) => `${file(p)} [data-diff-row]`;
  const bodies = () =>
    evaluate(
      '[...document.querySelectorAll("[data-diff-comment]")].map(node => [node.querySelector("[data-diff-comment-label]").textContent, node.querySelector("[data-diff-comment-body]").textContent])',
    );
  // Mouse-down on a row's "+", as a click or the start of a drag; the page-level mouse-up ends it.
  const press = (p, row, shift = false) =>
    evaluate(
      `document.querySelectorAll('${rows(p)}')[${row}].querySelector("[data-diff-add]").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, shiftKey: ${shift} }))`,
    );
  const hover = (p, row) => evaluate(`document.querySelectorAll('${rows(p)}')[${row}].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }))`);
  const release = () => evaluate('window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))');
  const type = (text) =>
    evaluate(
      `(() => { const field = document.querySelector("[data-diff-comment-input]"); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, ${JSON.stringify(text)}); field.dispatchEvent(new Event("input", { bubbles: true })); })()`,
    );
  const key = (name, extra = "") =>
    evaluate(`document.querySelector("[data-diff-comment-input]").dispatchEvent(new KeyboardEvent("keydown", { key: "${name}", bubbles: true, ${extra} }))`);
  const save = () => evaluate('document.querySelector("[data-diff-comment-save]").click()');
  const stored = () => evaluate('JSON.parse(localStorage.getItem("milagre:diff-comments:chat-1") ?? "[]")');
  const openDiff = async () => {
    await evaluate('document.querySelector("[data-changes-toggle]").click()');
    await waitFor('!!document.querySelector("[data-diff-tree-file]")');
    await evaluate(`document.querySelector('[data-diff-tree-file="${A}"]').click()`);
    await waitFor(`document.querySelectorAll('${rows(A)}').length === 7`);
    await delay(450);
  };
  try {
    await window.loadURL(process.argv[2]);
    window.webContents.setZoomFactor(1);
    await delay(100);
    await evaluate('document.documentElement.classList.add("dark")');
    await waitFor('!!document.querySelector("[data-changes-toggle]")');
    await openDiff();
    assert.equal(await evaluate('!!document.querySelector("[data-diff-send]")'), false, "No Send button without comments");
    assert.equal(await evaluate(`document.querySelector('${rows(A)}').querySelector("[data-diff-add]") !== null`), true, "Rows carry a + button");

    // A single line: the + opens the editor under that row; Comment waits for text.
    await press(A, 3);
    await release();
    await waitFor('!!document.querySelector("[data-diff-comment-editor]")');
    assert.equal(await evaluate('document.activeElement === document.querySelector("[data-diff-comment-input]")'), true, "The editor takes focus");
    assert.equal(await evaluate('document.querySelector("[data-diff-comment-input]").rows'), 3);
    assert.equal(
      await evaluate(`document.querySelectorAll('${rows(A)}')[3].nextElementSibling.contains(document.querySelector("[data-diff-comment-editor]"))`),
      true,
      "The editor sits under its row",
    );
    assert.equal(await evaluate('document.querySelector("[data-diff-comment-save]").disabled'), true, "Comment is disabled while blank");
    await type("   ");
    assert.equal(await evaluate('document.querySelector("[data-diff-comment-save]").disabled'), true, "Whitespace is still blank");
    await type("Single line note");
    await save();
    await waitFor('document.querySelectorAll("[data-diff-comment]").length === 1');
    assert.deepEqual(await bodies(), [["L3", "Single line note"]]);
    assert.equal(await evaluate('!!document.querySelector("[data-diff-comment-editor]")'), false);

    // Esc cancels without saving.
    await press(A, 0);
    await release();
    await waitFor('!!document.querySelector("[data-diff-comment-editor]")');
    await type("never saved");
    await key("Escape");
    await waitFor('!document.querySelector("[data-diff-comment-editor]")');
    assert.equal((await stored()).length, 1, "Esc leaves no comment behind");
    assert.equal(await evaluate('document.querySelectorAll("[data-selected]").length'), 0, "Esc clears the selection");

    // A drag selects every row passed over; Cmd+Enter saves.
    await press(A, 0);
    await delay(50);
    await hover(A, 1);
    await hover(A, 2);
    await waitFor('document.querySelectorAll("[data-selected]").length === 3');
    assert.equal(await evaluate('!!document.querySelector("[data-diff-comment-editor]")'), false, "The editor waits for the mouse to be released");
    await release();
    await waitFor('!!document.querySelector("[data-diff-comment-editor]")');
    assert.equal(
      await evaluate(`document.querySelectorAll('${rows(A)}')[2].nextElementSibling.contains(document.querySelector("[data-diff-comment-editor]"))`),
      true,
      "The editor sits under the last selected row",
    );
    await type("Range note");
    await delay(300);
    await shot("diff-comments-editor");
    await key("Enter", "metaKey: true");
    await waitFor('document.querySelectorAll("[data-diff-comment]").length === 2');
    assert.deepEqual(await bodies(), [
      ["L1–2", "Range note"],
      ["L3", "Single line note"],
    ]);

    // Shift-click extends the selection and the editor, keeping what was typed.
    await press(A, 4);
    await release();
    await waitFor('!!document.querySelector("[data-diff-comment-editor]")');
    await type("Third");
    await press(A, 6, true);
    await release();
    await waitFor('document.querySelectorAll("[data-selected]").length === 3');
    assert.equal(await evaluate('document.querySelector("[data-diff-comment-input]").value'), "Third", "Extending keeps the text");
    await save();
    await waitFor('document.querySelectorAll("[data-diff-comment]").length === 3');
    assert.deepEqual(
      (await bodies()).map((item) => item[0]),
      ["L1–2", "L3", "L4–6"],
    );

    // Edit swaps the card for a prefilled editor; delete removes.
    await evaluate(`document.querySelectorAll("[data-diff-comment-edit]")[1].click()`);
    await waitFor('!!document.querySelector("[data-diff-comment-editor]")');
    assert.equal(await evaluate('document.querySelector("[data-diff-comment-input]").value'), "Single line note");
    assert.equal(await evaluate('document.querySelectorAll("[data-diff-comment]").length'), 2, "The edited card gives way to the editor");
    await type("Edited note");
    await save();
    await waitFor('document.querySelectorAll("[data-diff-comment]").length === 3');
    assert.deepEqual((await bodies())[1], ["L3", "Edited note"]);
    await press(A, 5);
    await release();
    await waitFor('!!document.querySelector("[data-diff-comment-editor]")');
    await type("To delete");
    await save();
    await waitFor('document.querySelectorAll("[data-diff-comment]").length === 4');
    await evaluate(
      `[...document.querySelectorAll("[data-diff-comment]")].find(node => node.textContent.includes("To delete")).querySelector("[data-diff-comment-delete]").click()`,
    );
    await waitFor('document.querySelectorAll("[data-diff-comment]").length === 3');

    // Split: the + sits in each half and a comment keeps its side.
    await evaluate('document.querySelector("[data-diff-layout=split]").click()');
    await waitFor(`document.querySelectorAll('${file("README.md")} [data-diff-cell]').length > 0`);
    assert.equal(await evaluate('document.querySelectorAll("[data-diff-comment]").length'), 3, "Comments follow into split");
    await evaluate(
      `document.querySelector('${file("README.md")} [data-diff-cell=left] [data-diff-add]').dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))`,
    );
    await release();
    await waitFor('!!document.querySelector("[data-diff-comment-editor]")');
    await type("Split note");
    await save();
    await waitFor('document.querySelectorAll("[data-diff-comment]").length === 4');
    assert.deepEqual((await stored()).map((item) => item.side).slice(-1), ["old"], "A left-half comment is on the old side");
    await evaluate(
      `[...document.querySelectorAll("[data-diff-comment]")].find(node => node.textContent.includes("Split note")).querySelector("[data-diff-comment-delete]").click()`,
    );
    await waitFor('document.querySelectorAll("[data-diff-comment]").length === 3');
    await evaluate('document.querySelector("[data-diff-layout=unified]").click()');
    await waitFor(`document.querySelectorAll('${rows(A)}').length === 7`);

    // The tree counts, and the Send button sits above the drag strip.
    assert.equal(await evaluate(`document.querySelector('[data-diff-tree-file="${A}"] [data-diff-tree-comments]').dataset.diffTreeComments`), "3");
    // Comments belong to the diff they were written on: the same file's committed row counts none.
    assert.deepEqual([...new Set((await stored()).map((item) => item.mode))], ["uncommitted"]);
    assert.equal(
      await evaluate(`document.querySelector('[data-changes-section="On this branch"] [data-diff-tree-file="${A}"] [data-diff-tree-comments]')`),
      null,
    );
    assert.equal(await evaluate('document.querySelector("[data-diff-send]").textContent'), "Send 3 comments");
    await waitFor('!document.querySelector("[data-diff-comment-editor]")');
    await delay(300);
    assert.equal(
      await evaluate(
        `[...document.querySelectorAll("[data-diff-bar] button")].filter(button => { const r = button.getBoundingClientRect(); return !button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }).length`,
      ),
      0,
      "Diff bar buttons, Send included, sit above the drag strip",
    );
    await evaluate('document.querySelector("[data-diff-view]").scrollTo(0, 0)');
    await shot("diff-comments-saved");

    // They belong to the chat and survive a remount.
    await evaluate("window.remount()");
    await waitFor('!!document.querySelector("[data-changes-toggle]")');
    await openDiff();
    await waitFor('document.querySelectorAll("[data-diff-comment]").length === 3');
    assert.equal(await evaluate('document.querySelector("[data-diff-send]").textContent'), "Send 3 comments");

    // The diff changes under the range comment: it is outdated, not counted, and can still be deleted.
    await evaluate("window.editA(); window.endTurn()");
    await waitFor('document.querySelectorAll("[data-diff-comment-outdated]").length === 1');
    assert.equal(await evaluate('document.querySelector("[data-diff-comment][data-outdated] [data-diff-comment-label]").textContent'), "L1–2");
    assert.equal(
      await evaluate('document.querySelector("[data-diff-comment][data-outdated] [data-diff-comment-edit]")'),
      null,
      "An outdated comment can't be edited",
    );
    await waitFor('document.querySelector("[data-diff-send]")?.textContent === "Send 2 comments"');
    await evaluate('document.querySelector("[data-diff-view]").scrollTo(0, 0)');
    await shot("diff-comments-outdated");

    // Send goes out as one message, takes the sent comments with it and returns to the chat.
    await evaluate('document.querySelector("[data-diff-send]").click()');
    await waitFor("window.sent.length === 1");
    assert.equal(
      await evaluate("window.sent[0]"),
      [
        "Review comments on the diff (uncommitted changes):",
        "",
        "1. src/a.ts, line 3 (new):",
        "```typescript",
        " const b = 3;",
        "```",
        "Edited note",
        "",
        "2. src/a.ts, lines 4–6 (new):",
        "```typescript",
        " const c = 4;",
        " const d = 5;",
        " export {};",
        "```",
        "Third",
      ].join("\n"),
    );
    await waitFor('!document.querySelector("[data-diff-view]") && !document.querySelector("[data-chat-stub]").classList.contains("hidden")');
    assert.deepEqual(
      (await stored()).map((item) => item.snippet.length),
      [3],
      "Only the outdated comment stays",
    );

    // It is still there, deletable, and nothing is left to send.
    await evaluate(`document.querySelector('[data-diff-tree-file="${A}"]').click()`);
    await waitFor('document.querySelectorAll("[data-diff-comment-outdated]").length === 1');
    assert.equal(await evaluate('!!document.querySelector("[data-diff-send]")'), false, "Outdated comments don't offer Send");
    await evaluate('document.querySelector("[data-diff-comment-delete]").click()');
    await waitFor('document.querySelectorAll("[data-diff-comment]").length === 0');
    assert.equal(await evaluate('localStorage.getItem("milagre:diff-comments:chat-1")'), null);
    console.log(
      "PASS: single-line, drag and shift-click comments, Esc and blank handling, edit and delete, split side, tree counts, Send above the drag strip, message text, outdated, persistence across a remount",
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
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "diff-comments-fixture",
        resolveId(id) {
          if (id === "/__diff_comments_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__diff_comments_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__diff_comments__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__diff_comments_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__diff_comments__`], { env, stdio: "inherit" });
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
