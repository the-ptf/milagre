// Undo changes in a real ChatComposer with a scripted checkpoint bridge: the hover button, Esc Esc, the composer's list and
// preview, a conflict choice, a stale preview, the restore line's Redo and /undo. The daemon side is covered by
// packages/core/src/checkpoints.test.cjs and checkpoint-runtime.test.cjs.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatComposer } from "/src/components/ChatComposer";
import { MODEL_CATALOG, capabilityFor } from "/src/model";
import "/src/styles.css";
const at = new Date(); at.setHours(8, 0, 0, 0);
const redirect = { id: "task-2", kind: "task", createdAt: at.getTime(), completedAt: at.getTime() + 60000, excluded: 0, permissionMode: "ask",
  messageId: 13, prompt: "After login, send people to the account page instead of the dashboard.", changed: 3 };
const settings = { id: "task-1", kind: "task", createdAt: at.getTime() - 18 * 60000, completedAt: at.getTime() - 17 * 60000, excluded: 0, permissionMode: "ask",
  messageId: 11, prompt: "Add an account settings page and link it from the user menu.", changed: 4 };
const worktree = "/Projects/storefront";
const files = [
  { key: "0:src/auth/login.ts", path: "src/auth/login.ts", worktree, action: "replace", conflict: true },
  { key: "0:src/auth/redirect.ts", path: "src/auth/redirect.ts", worktree, action: "delete", conflict: false },
  { key: "0:src/auth/login.test.ts", path: "src/auth/login.test.ts", worktree, action: "replace", conflict: false },
];
window.calls = { list: 0, preview: [], restore: [], diffs: [] };
window.failStale = true;
window.restored = false;
window.milagre = {
  listEditors: async () => [],
  checkpoints: {
    list: async () => { window.calls.list++; return window.restored ? [{ ...redirect, id: "recovery-1", kind: "recovery", changed: 2, createdAt: at.getTime() + 120000 }, redirect, settings] : [redirect, settings]; },
    preview: async ({ id }) => {
      window.calls.preview.push(id);
      if (id === "recovery-1") return { ...redirect, id, kind: "recovery", token: "recovery-preview", files: files.slice(1).map((file) => ({ ...file, action: file.action === "delete" ? "create" : "replace" })) };
      return { ...(id === settings.id ? settings : redirect), token: "preview-" + window.calls.preview.length, files };
    },
    restore: async (request) => {
      window.calls.restore.push(request);
      if (window.failStale) { window.failStale = false; throw new Error("Files changed. Preview again before restoring"); }
      window.restored = true;
      return { restored: 2, kept: 1, recoveryId: "recovery-1", checkpointId: redirect.id, redo: false };
    },
  },
};
const noop = () => {};
const user = (id, body) => ({ id, session_id: 1, role: "user", context: null, body });
const reply = (id, body) => ({ id, session_id: 1, role: "assistant", context: null, body,
  steps: [{ id: "s" + id, kind: "edit", title: "src/auth/login.ts", status: "done" }] });
function Fixture() {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [notes, setNotes] = useState([]);
  window.setSending = setSending;
  window.setDraft = setDraft;
  window.addUndoLine = () => setNotes([{ id: 15, session_id: 1, role: "assistant", body: "Undid 2 files",
    context: { kind: "checkpoint-restore", checkpointId: redirect.id, recoveryId: "recovery-1", restored: 2, kept: 1, redo: false } }]);
  const model = MODEL_CATALOG[0];
  const messages = [
    user(11, settings.prompt),
    reply(12, "Added the /account page with profile and password sections, and linked it from the user menu. Typecheck and tests pass."),
    user(13, redirect.prompt),
    reply(14, "Login now redirects to /account. The target lives in src/auth/redirect.ts, and the login test covers both the account page and the old dashboard link."),
    ...notes,
  ];
  return <div style={{ height: "100%", padding: 12 }}>
    <ChatComposer messages={messages} agentChatId="/Projects/storefront#1" messageScope="/Projects/storefront"
      imageDraft={{ images: [], files: [], removeFile: noop, attachFiles: noop, loading: false, error: "", onPaste: noop, clear: noop, remove: noop }}
      projectPath="/Projects/storefront" draft={draft} onDraftChange={setDraft} onSend={() => { window.sent = draft; }} isSending={sending} sendBlocked={false}
      onOpenDiff={(file, root) => window.calls.diffs.push([file, root])}
      models={MODEL_CATALOG} cliStatus={null} onModelPickerOpen={noop} selectedModel={model} onModelChange={noop}
      capability={capabilityFor(model, null)} onEffortChange={noop} ultracode={false} onUltracodeChange={noop}
      fastMode={false} onFastModeChange={noop} permissionMode="ask" onPermissionModeChange={noop}
      onRecommendationSelect={noop} worktrees={[]} onWorktreeChange={noop}
      isolation="local" onIsolationChange={noop} branches={[]} baseBranch="main" onBaseBranchChange={noop} newChatError={null} />
  </div>;
}
if (new URLSearchParams(location.search).get("theme") === "dark") document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")).render(<Fixture />);
`;
async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  const profile = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "checkpoint-electron-"));
  app.setPath("userData", profile);
  await app.whenReady();
  const window = new BrowserWindow({ width: 1000, height: 720, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message);
  });
  const evaluate = (source) =>
    window.webContents.executeJavaScript(source).catch((error) => {
      throw new Error(source + ": " + error.message);
    });
  const wait = async (source) => {
    for (let n = 0; n < 200; n++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error("Timed out: " + source);
  };
  const shot = async (name) => {
    await delay(260);
    if (process.env.MILAGRE_SCREENSHOT_DIR)
      fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "checkpoints-" + name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  const escape = (target = "document.body") =>
    evaluate(`${target}.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))`);
  const key = (name) =>
    evaluate(`document.querySelector("[data-undo-panel]").dispatchEvent(new KeyboardEvent("keydown", { key: "${name}", bubbles: true, cancelable: true }))`);
  const ringed = () => evaluate('[...document.querySelectorAll("article")].filter((node) => node.querySelector(".outline-accent")).map((node) => node.id)');
  try {
    await window.loadURL(process.argv[2]);
    // Each task that changed files gets an undo button under the message that started it.
    await wait('!!document.querySelector("[data-undo-message=\\"13\\"]") && !!document.querySelector("[data-undo-message=\\"11\\"]")');
    await evaluate(`
      const style = document.createElement("style");
      style.textContent = "#message-13 [class*=group-hover] { opacity: 1 !important }";
      document.head.append(style);
      document.querySelector("[data-undo-message=\\"13\\"]").closest("span").dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
    `);
    await wait('document.querySelector("[role=tooltip]")?.textContent.includes("Undo changes")');
    assert.match(await evaluate('document.querySelector("[role=tooltip]").textContent'), /Esc.*Esc/);
    await shot("hover");
    await evaluate(
      'document.querySelector("[data-undo-message=\\"13\\"]").closest("span").dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }))',
    );

    // Esc Esc in the empty, idle composer lists the tasks, newest first, and outlines the one highlighted.
    await escape();
    await delay(60);
    await escape();
    await wait('document.querySelector("[data-undo-panel]")?.dataset.undoPanel === "list" && document.querySelectorAll("[data-checkpoint-id]").length === 2');
    assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-checkpoint-id]")].map((row) => row.dataset.checkpointId)'), ["task-2", "task-1"]);
    await wait('document.querySelector("#message-13 .outline-accent") !== null');
    await shot("list");
    await key("ArrowDown");
    await wait('document.querySelector("#message-11 .outline-accent") !== null');
    assert.deepEqual(await ringed(), ["message-11"]);
    await key("ArrowUp");
    await key("Enter");

    // The preview: one row per file with what undoing does; the conflict blocks the button until it has an answer.
    await wait('document.querySelectorAll("[data-checkpoint-file]").length === 3');
    assert.equal(await evaluate('document.querySelector("[data-undo-panel]").dataset.undoPanel'), "preview");
    assert.equal(await evaluate('document.querySelector("[data-promptbar]").closest(".hidden") !== null'), true, "the preview takes the prompt's place");
    assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-checkpoint-file]")].map((row) => row.textContent)'), [
      "login.tssrc/authEdited after this taskKeep currentUndo",
      "redirect.tssrc/authDelete",
      "login.test.tssrc/authRevert",
    ]);
    assert.equal(await evaluate('document.querySelector("[data-checkpoint-restore]").disabled'), true);
    assert.equal(await evaluate('document.querySelector("[data-checkpoint-restore]").textContent'), "Undo 3 files");
    await shot("preview");
    await evaluate('document.querySelector("[aria-label=\\"Show the diff of src/auth/redirect.ts\\"]").click()');
    assert.deepEqual(await evaluate("window.calls.diffs"), [["src/auth/redirect.ts", "/Projects/storefront"]]);

    await evaluate('document.querySelector("[data-checkpoint-choice=keep]").click()');
    await wait('!document.querySelector("[data-checkpoint-restore]").disabled');
    assert.equal(await evaluate('document.querySelector("[data-checkpoint-restore]").textContent'), "Undo 2 files");
    await shot("resolved");

    // Files changed after the preview: nothing is written, the preview comes back fresh and asks again.
    await evaluate('document.querySelector("[data-checkpoint-restore]").click()');
    await wait('document.querySelector("[data-undo-panel] [role=status]")?.textContent === "Files changed. Review again."');
    assert.deepEqual(await evaluate("window.calls.restore[0]"), {
      chatId: "/Projects/storefront#1",
      token: "preview-1",
      decisions: { "0:src/auth/login.ts": "keep", "0:src/auth/redirect.ts": "restore", "0:src/auth/login.test.ts": "restore" },
      approved: true,
    });
    assert.equal(await evaluate('document.querySelector("[data-checkpoint-restore]").disabled'), true);
    await shot("stale");
    await evaluate('document.querySelector("[data-checkpoint-choice=keep]").click()');
    await wait('!document.querySelector("[data-checkpoint-restore]").disabled');
    await evaluate('document.querySelector("[data-checkpoint-restore]").click()');
    await wait('!document.querySelector("[data-undo-panel]") && window.calls.restore.length === 2');
    assert.equal(await evaluate("window.calls.restore[1].token"), "preview-2");
    assert.equal(await evaluate('document.querySelector("[data-promptbar]").closest(".hidden")'), null);

    // The daemon writes "Undid 2 files" in the Chat; its Redo previews the recovery checkpoint.
    await evaluate("window.addUndoLine()");
    await wait('document.querySelector("[data-checkpoint-restore-divider]")?.textContent === "Undid 2 files·Redo"');
    await shot("undone");
    await evaluate('document.querySelector("[data-checkpoint-redo]").click()');
    await wait('document.querySelectorAll("[data-checkpoint-file]").length === 2');
    assert.equal(await evaluate("window.calls.preview.at(-1)"), "recovery-1");
    assert.match(await evaluate('document.querySelector("[data-undo-panel] header").textContent'), /^Redo changes from/);
    assert.equal(await evaluate('document.querySelector("[data-checkpoint-restore]").textContent'), "Redo 2 files");
    await shot("redo");
    await evaluate('document.querySelector("[data-undo-panel] [aria-label=Close]").click()');
    await wait('!document.querySelector("[data-undo-panel]")');

    // /undo opens the same list instead of reaching the agent.
    await evaluate('window.setDraft("/undo")');
    await wait('document.querySelector("textarea[aria-label=Prompt]")?.value === "/undo"');
    await evaluate(
      'document.querySelector("textarea[aria-label=Prompt]").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))',
    );
    await wait('document.querySelector("[data-undo-panel]")?.dataset.undoPanel === "list"');
    assert.equal(await evaluate("window.sent"), undefined);
    await key("Escape");
    await wait('!document.querySelector("[data-undo-panel]")');

    // While a turn runs, Esc Esc stays with Stop and the undo buttons wait.
    await evaluate("window.setSending(true)");
    await wait('document.querySelector("[data-undo-message=\\"13\\"]").disabled');
    await escape();
    await delay(60);
    await escape();
    await delay(200);
    assert.equal(await evaluate('!!document.querySelector("[data-undo-panel]")'), false);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: undo button and Esc Esc hint, Esc Esc list, keyboard choice, preview in the composer, conflict choice, stale refusal, restore line Redo, /undo, blocked while running",
    );
    window.destroy();
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
        name: "checkpoint-fixture",
        resolveId: (id) => (id === "/__checkpoint_fixture.tsx" ? id : undefined),
        load: (id) => (id === "/__checkpoint_fixture.tsx" ? fixture : undefined),
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (!req.url?.startsWith("/__checkpoints__")) return next();
            res.setHeader("Content-Type", "text/html");
            void server
              .transformIndexHtml(
                req.url,
                '<html><body><div id="root" style="height:100vh"></div><script type="module" src="/__checkpoint_fixture.tsx"></script></body></html>',
              )
              .then((html) => res.end(html))
              // oxlint-disable-next-line promise/no-callback-in-promise -- Connect requires its next callback for middleware errors.
              .catch(next);
          });
        },
      },
    ],
  });
  try {
    await server.listen();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const url = server.resolvedUrls.local[0] + "__checkpoints__" + (process.env.CHECKPOINT_THEME ? `?theme=${process.env.CHECKPOINT_THEME}` : "");
    const child = spawn(require("electron"), [path.resolve(__filename), url], { env, stdio: "inherit" });
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
