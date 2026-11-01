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
import { StepOutput } from "/src/components/agents/StepOutput";
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
  const [copyOutput, setCopyOutput] = useState(null);
  window.setCopyOutput = setCopyOutput;
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [notes, setNotes] = useState([]);
  const [extra, setExtra] = useState([]);
  const [stream, setStream] = useState("");
  const [prompt13, setPrompt13] = useState(redirect.prompt);
  window.setPrompt13 = setPrompt13;
  window.setExtra = setExtra;
  window.setStream = setStream;
  window.setSending = setSending;
  window.setDraft = setDraft;
  window.addUndoLine = () => setNotes([{ id: 15, session_id: 1, role: "assistant", body: "Undid 2 files",
    context: { kind: "checkpoint-restore", checkpointId: redirect.id, recoveryId: "recovery-1", restored: 2, kept: 1, redo: false } }]);
  const model = MODEL_CATALOG[0];
  const messages = [
    user(11, settings.prompt),
    reply(12, "Added the /account page with profile and password sections, and linked it from the user menu. Typecheck and tests pass."),
    user(13, prompt13),
    reply(14, "Login now redirects to /account. The target lives in src/auth/redirect.ts, and the login test covers both the account page and the old dashboard link."),
    ...notes,
    ...extra,
  ];
  if (copyOutput !== null) return <div id="copy-output"><StepOutput step={{ id: "long-output", kind: "shell", status: "done", title: "Output", detail: copyOutput }} /></div>;
  return <div style={{ height: "100%", padding: 12 }}>
    <ChatComposer messages={messages} agentChatId="/Projects/storefront#1" messageScope="/Projects/storefront"
      imageDraft={{ images: [], files: [], removeFile: noop, attachFiles: noop, loading: false, error: "", onPaste: noop, clear: noop, remove: noop }}
      projectPath="/Projects/storefront" draft={draft} onDraftChange={setDraft} onSend={() => { window.sent = draft; }} isSending={sending} streamingText={stream} sendBlocked={false}
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
  const { app, BrowserWindow, clipboard, ClipboardItem } = require("electron");
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
  // How keyboard focus draws an element. Forced through DevTools: this hidden window never holds the real focus.
  const focusRing = async (selector) => {
    const devtools = window.webContents.debugger;
    if (!devtools.isAttached()) devtools.attach("1.3");
    await devtools.sendCommand("DOM.enable");
    await devtools.sendCommand("CSS.enable");
    const { root } = await devtools.sendCommand("DOM.getDocument");
    const { nodeId } = await devtools.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector });
    await devtools.sendCommand("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["focus-visible"] });
    const style = await evaluate(
      `(({ outlineStyle, borderTopLeftRadius }) => ({ outline: outlineStyle, radius: borderTopLeftRadius }))(getComputedStyle(document.querySelector(${JSON.stringify(selector)})))`,
    );
    await devtools.sendCommand("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
    return style;
  };
  // Materialize every format before the tests replace the system clipboard. An empty clipboard (CI's Linux) reads as an
  // item with no types, which ClipboardItem refuses.
  const previousClipboard = await Promise.all(
    (await clipboard.read())
      .filter((item) => item.types.length)
      .map(async (item) => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async (type) => [type, await item.getType(type)]))))),
  );
  let exitCode = 0;
  try {
    await window.loadURL(process.argv[2]);
    window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    await wait("document.hasFocus()");
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

    // Copy uses raw message text, the final Markdown answer, and the entire recommendation.
    const raw = "  Reuse @mentions as typed.\n\n- **Keep Markdown**  ";
    const answer = "1. **Keep this list**\n2. [Keep the link](https://example.com)\n\n```ts\nconst answer = 42;\n```";
    const { pageCommentsMessage } = await import("../packages/shared/src/page-comments.mjs");
    const pageFeedback = pageCommentsMessage(
      [
        {
          id: "aabbccdd",
          url: "https://example.com",
          title: "Example",
          text: "Move this button",
          element: { label: "Submit", selector: "button", box: { x: 0, y: 0, width: 80, height: 30 }, viewport: { width: 1000, height: 720 } },
        },
      ],
      { screenshots: false },
    );
    const recommendation = "Some context.\n\nWhich should I do first?\n1. Alpha (recommended)\n2. Beta";
    await evaluate(
      `window.setExtra(${JSON.stringify([
        { id: 21, session_id: 1, role: "user", body: raw },
        {
          id: 22,
          session_id: 1,
          role: "assistant",
          body: "Tool commentary.\n" + answer,
          steps: [{ id: "copy-tool", kind: "command", title: "DO NOT COPY TOOL", status: "done", offset: "Tool commentary.\n".length }],
        },
        { id: 23, session_id: 1, role: "assistant", body: recommendation },
        { id: 24, session_id: 1, role: "user", body: "Linked raw text", context: { kind: "delegation", from: "other#1", fromLabel: "Other Chat" } },
        {
          id: 25,
          session_id: 1,
          role: "user",
          body: "[Image #1]",
          images: [{ id: "pixel", name: "pixel.svg", dataUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/%3E" }],
        },
        { id: 26, session_id: 1, role: "user", body: "An internal answer", answered: [{ question: "Which?", answers: ["Alpha"] }] },
        { id: 27, session_id: 1, role: "assistant", body: "", steps: [{ id: "only-tool", kind: "command", title: "No answer", status: "done" }] },
        {
          id: 28,
          session_id: 1,
          role: "user",
          body: "Internal PR action",
          context: { kind: "pr-action", action: "checks-failed", pr: 42, url: "https://github.com/example/project/pull/42" },
        },
        {
          id: 29,
          session_id: 1,
          role: "user",
          body: "Internal Linear context",
          context: { kind: "linear-issue", key: "TEST-1", title: "An issue", url: "", state: { name: "Todo", type: "unstarted", color: "#95a2b3" } },
        },
        { id: 33, session_id: 1, role: "user", body: pageFeedback },
        { id: 30, session_id: 1, role: "user", body: 'I chose the design "Home" (home, version 1). Continue from this one.' },
        {
          id: 31,
          session_id: 1,
          role: "user",
          body: "Advisor text",
          context: { kind: "advisor-result", provider: "codex", title: "Review", outcome: "completed" },
        },
        {
          id: 32,
          session_id: 1,
          role: "assistant",
          body: "Linked assistant answer",
          // A Negotiation round keeps its text (a plain report is one line, with no reply footer).
          context: { kind: "delegation-report", from: "other#1", fromLabel: "Other Chat", status: "done", negotiation: { id: "n1", round: 1 } },
        },
      ])})`,
    );
    const button = (id, label = "Copy message") => `document.querySelector('#message-${id} [aria-label="${label}"]')`;
    await wait(`${button(21)} && ${button(22)} && ${button(23)} && ${button(24)}`);
    for (const id of [25, 26, 27, 28, 29, 30, 31, 33]) assert.equal(await evaluate(`${button(id)} === null`), true, `no Copy on special/empty message ${id}`);
    assert.equal(
      await evaluate(`document.querySelectorAll('#message-32 [aria-label="Copy message"]').length`),
      1,
      "linked assistant gets only the reply footer",
    );
    const metrics = () =>
      evaluate(`(() => {
      const viewport = document.querySelector('[aria-label=Conversation]');
      return { height: viewport.scrollHeight, scroll: viewport.scrollTop,
        rows: [...viewport.querySelectorAll('article')].map(node => ({ id: node.id, height: node.getBoundingClientRect().height })) };
    })()`);
    // Finish finite entry/layout animations before comparing hover geometry.
    await evaluate(
      `Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`,
    );
    const before = await metrics();
    const debuggerApi = window.webContents.debugger;
    if (!debuggerApi.isAttached()) debuggerApi.attach("1.3");
    await debuggerApi.sendCommand("DOM.enable");
    await debuggerApi.sendCommand("CSS.enable");
    const { root } = await debuggerApi.sendCommand("DOM.getDocument");
    const { nodeId } = await debuggerApi.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector: "#message-22" });
    await debuggerApi.sendCommand("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] });
    await wait(`getComputedStyle(${button(22)}.parentElement.parentElement).opacity === '1'`);
    assert.deepEqual(await metrics(), before, "hover preserves transcript height and scroll position");
    await debuggerApi.sendCommand("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
    // Trusted pointer clicks also prove containment does not clip the side controls.
    const pointerClick = async (selector) => {
      await evaluate(`${selector}.scrollIntoView({ block: 'center' })`);
      await wait(`document.querySelector('[data-measuring]') === null`);
      await evaluate(
        `Promise.all(document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`,
      );
      const point = await evaluate(`(() => { const r = ${selector}.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      assert.equal(
        await evaluate(`(() => { const p = ${JSON.stringify(point)}; return ${selector}.contains(document.elementFromPoint(p.x, p.y)); })()`),
        true,
        "Copy is painted and hit-testable",
      );
      window.webContents.sendInputEvent({ type: "mouseMove", ...point });
      await wait(`getComputedStyle(${selector}.parentElement.parentElement).opacity === '1'`);
      window.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
      window.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
    };
    for (const [id, text] of [
      [21, raw],
      [22, answer],
      [23, recommendation],
      [24, "Linked raw text"],
    ]) {
      await pointerClick(button(id));
      await wait(`${button(id, "Copied")} !== null`);
      assert.equal(await clipboard.readText(), text, `raw clipboard text for message ${id}`);
    }
    await wait(`${button(21)} !== null`);
    await evaluate(`${button(21)}.focus()`);
    await wait(`getComputedStyle(${button(21)}.parentElement.parentElement).opacity === '1'`);
    assert.equal(await evaluate(`${button(21)} === document.activeElement`), true, "keyboard focus reveals Copy");
    await evaluate(`document.activeElement.blur(); document.body.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))`);
    // Pending writes do not claim success before the clipboard accepts the text.
    await evaluate(`window.realClipboardWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = () => new Promise(resolve => { window.resolveWrite = resolve; });
      ${button(21)}.click()`);
    await wait('typeof window.resolveWrite === "function"');
    assert.equal(await evaluate(`${button(21, "Copied")} === null`), true);
    await evaluate("window.resolveWrite()");
    await wait(`${button(21, "Copied")} !== null`);
    await wait(`${button(21)} !== null`);
    await evaluate("void (navigator.clipboard.writeText = window.realClipboardWrite)");
    // Rejected writes do not claim success, and the button remains usable for a later retry.
    await evaluate(`window.realClipboardWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = () => Promise.reject(new Error('Denied'));
      ${button(21)}.click()`);
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    assert.equal(await evaluate(`${button(21, "Copied")} === null`), true);
    await evaluate(`navigator.clipboard.writeText = window.realClipboardWrite; ${button(21)}.click()`);
    await wait(`${button(21, "Copied")} !== null`);
    assert.equal(await clipboard.readText(), raw);
    // Code blocks share the success timer and still copy only their code.
    await evaluate(`document.querySelector('#message-22 [aria-label="Copy code"]').click()`);
    await wait(`document.querySelector('#message-22 .markdown-code [aria-label="Copied"]') !== null`);
    assert.equal(await clipboard.readText(), "const answer = 42;");
    await evaluate(`window.setStream('A reply still streaming'); window.setSending(true)`);
    await wait(`document.querySelector('[data-streaming] [data-message-copy-footer]') !== null`);
    assert.equal(await evaluate(`document.querySelector('[data-streaming] [aria-label="Copy message"]') === null`), true);
    await evaluate(`window.setStream(''); window.setSending(false); window.setExtra([]); window.setPrompt13('Long wrapping user prompt '.repeat(30))`);
    window.setSize(560, 720);
    await wait(`document.querySelector('#message-13')?.textContent.includes('Long wrapping')`);
    await pointerClick(button(13));
    await wait(`${button(13, "Copied")} !== null`);
    assert.equal(await clipboard.readText(), "Long wrapping user prompt ".repeat(30));
    assert.equal(
      await evaluate(`(() => {
      const undo = document.querySelector('[data-undo-message="13"]'); const r = undo.getBoundingClientRect();
      return undo.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    })()`),
      true,
      "Undo remains hit-testable beside Copy at narrow width",
    );
    window.setSize(1000, 720);
    await evaluate(`window.setPrompt13("After login, send people to the account page instead of the dashboard.")`);

    // A clipped tool-output preview must copy all retained lines, not only its visible 40.
    const longOutput = Array.from({ length: 65 }, (_, i) => "Output line " + (i + 1)).join("\n");
    await evaluate(`window.setCopyOutput(${JSON.stringify(longOutput)})`);
    await wait('document.querySelector("#copy-output")?.textContent.includes("last 40 of 65 lines")');
    assert.equal(await evaluate('document.querySelector("#copy-output pre").textContent.includes("Output line 1\\n")'), false);
    await evaluate(`document.querySelector('#copy-output [aria-label="Copy code"]').click()`);
    await wait(`document.querySelector('#copy-output [aria-label="Copied"]') !== null`);
    assert.equal(await clipboard.readText(), longOutput, "clipped output copies all retained lines");
    await evaluate("window.setCopyOutput(null)");
    await wait(`document.querySelector('#message-21') === null`);

    // Esc Esc in the empty, idle composer lists the tasks, newest first, and outlines the one highlighted.
    await escape();
    await delay(60);
    await escape();
    await wait('document.querySelector("[data-undo-panel]")?.dataset.undoPanel === "list" && document.querySelectorAll("[data-checkpoint-id]").length === 2');
    assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-checkpoint-id]")].map((row) => row.dataset.checkpointId)'), ["task-2", "task-1"]);
    // The panel takes the focus for its keys; the highlighted row shows where they go, so the panel draws no focus ring.
    assert.deepEqual(await focusRing("[data-undo-panel]"), { outline: "none", radius: "14px" });
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
    await wait('document.querySelector("[data-prompt-editor]")?.value === "/undo"');
    await evaluate(
      'document.querySelector("[data-prompt-editor]").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))',
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
      "PASS: raw user/reply/recommendation/linked Copy, success/failure/retry, keyboard visibility, stable hover geometry, code Copy, streaming exclusion; undo button and Esc Esc hint, Esc Esc list, keyboard choice, preview in the composer, conflict choice, stale refusal, restore line Redo, /undo, blocked while running",
    );
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    if (previousClipboard.length) await clipboard.write(previousClipboard);
    else clipboard.clear();
    window.destroy();
    app.exit(exitCode);
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
