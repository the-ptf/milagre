// Browser integration check using the app's existing Electron/Vite dependencies.
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
import "/src/styles.css";
// This component fixture owns its decoration geometry; native windows are covered by test-window-chrome.
const titlebar = new EventTarget();
titlebar.visible = false;
titlebar.getTitlebarAreaRect = () => new DOMRect(titlebar.visible ? 80 : 0, 0, innerWidth - (titlebar.visible ? 80 : 0), 44);
Object.defineProperty(navigator, "windowControlsOverlay", { value: titlebar });
window.setWindowDecoration = controls => {
  window.milagreWindowChrome = { controls };
  titlebar.visible = controls === "leading";
  titlebar.dispatchEvent(new Event("geometrychange"));
};
window.setWindowDecoration("external");
const listeners = new Set();
const FILES = {
  "packages/app/src/components/Calendar/CalendarEmptyState.tsx": { status: "modified", added: 2, removed: 2, patch: [
    "diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,7 +1,7 @@",
    ' import React from "react";', '-import { Text } from "./Text";', '+import { Text } from "../ui/Text";', " ",
    " export function CalendarEmptyState() {", '-  const message = "No events today";', '+  const message = "No events scheduled";',
    "   return <Text>{message}</Text>;", " }", ""].join("\\n") },
  "packages/app/src/components/Calendar/Calendar.tsx": { status: "modified", added: 1, removed: 0, patch: [
    "@@ -10,3 +10,4 @@", " const days = 7;", "+const gap = 4;", " export default days;", " ", ""].join("\\n") },
  "packages/app/src/index.ts": { status: "added", added: 2, removed: 0, patch: [
    "@@ -0,0 +1,2 @@", '+export * from "./components/Calendar/Calendar";', '+export const version = "1.0";', ""].join("\\n") },
  "README.md": { status: "modified", added: 2, removed: 1, patch: [
    "@@ -1,4 +1,5 @@", " # Milagre", "-Old tagline", "+New tagline", "+A second line that runs long " + "and keeps going ".repeat(40), " ", " end", ""].join("\\n") },
  "assets/data/big.json": { status: "added", added: 3500, removed: 0, patch: "@@ -0,0 +1,2 @@\\n+{\\n+}\\n" },
  "assets/logo.png": { status: "modified", added: 0, removed: 0, binary: true, patch: "" },
};
const entries = Object.entries(FILES).map(([path, f]) => ({ path, status: f.status, added: f.added, removed: f.removed, binary: Boolean(f.binary) }));
window.listCalls = [];
window.historyCalls = [];
window.historyHeld = false;
window.historyError = null;
window.statsLimit = null;
window.branchDeleted = false;
window.noSharedHistory = false;
window.historyWaiters = [];
window.releaseHistory = () => { window.historyHeld = false; window.historyWaiters.splice(0).forEach(resolve => resolve()); };
window.externalCommit = false;
window.externalEdit = false;
window.fileCalls = [];
window.commitFileCalls = [];
window.commitPatchCalls = [];
window.commitPatchFailure = false;
window.commitPatchHeld = false;
window.commitPatchWaiters = [];
window.releaseCommitPatch = () => { window.commitPatchHeld = false; window.commitPatchWaiters.splice(0).forEach(resolve => resolve()); };
window.commitRoot = false;
window.commitTruncated = false;
window.milagre = {
  git: {
    history: async request => {
      window.historyCalls.push(request);
      if (window.historyHeld) await new Promise(resolve => window.historyWaiters.push(resolve));
      if (window.historyError) throw new Error(window.historyError);
      const commit = { sha: "a".repeat(40), author: "Maria", email: "maria@example.com", date: "2026-10-28T10:00:00Z", message: "Current feature commit\\n\\nDetailed explanation", files: 2, added: 7, removed: 3 };
      if (window.statsLimit) Object.assign(commit, { files: null, added: null, removed: null, statsUnavailable: window.statsLimit });
      return { head: "c".repeat(40), total: 2, automatic: { name: "main", ref: "refs/heads/main", reason: "the recorded base" }, projectDefault: { name: "main", ref: "refs/heads/main" }, suggested: "refs/heads/parent",
        comparisonRef: request.base === "refs/heads/parent" ? "refs/heads/parent" : "refs/heads/main",
        message: window.noSharedHistory && request.base === "refs/heads/parent" ? "This branch shares no history with parent." : undefined,
        isRepo: true, branch: "feature/current", base: request.base === "refs/heads/parent" ? "parent" : "main", branchesVersion: "v1", baseMissing: window.branchDeleted && request.base === "refs/heads/parent", ...(request.branchesVersion === "v1" ? {} : { branches: [{ ref: "refs/heads/main", name: "main" }, { ref: "refs/heads/parent", name: "parent" }, { ref: "refs/heads/feature/current", name: "feature/current" }, { ref: "refs/remotes/origin/main", name: "origin/main" }].filter(branch => !window.branchDeleted || branch.ref !== "refs/heads/parent") }), hasMore: request.limit === 30,
        commits: !request.limit ? [] : request.limit >= 60 ? [commit, { ...commit, sha: "b".repeat(40), message: "Earlier feature commit", files: 2, added: 7, removed: 3, statsUnavailable: undefined }] : [commit] };
    },
    diffFiles: async request => {
      if (request.commit) { window.commitFileCalls.push(request); return { isRepo: true, commit: request.commit, commitParent: window.commitRoot ? null : "b".repeat(40), truncated: window.commitTruncated, base: request.commit, files: window.commitTruncated ? Array.from({length:1000}, (_, index) => ({...entries.find(entry => entry.path === "README.md"), path: index ? "file-"+index+".txt" : "README.md"})) : entries.filter(entry => entry.path === "README.md") }; }
      window.listCalls.push(request.mode);
      if (request.mode === "committed") window.lastBase = request.base;
      if (request.mode === "committed") return { isRepo: true, base: request.base === "refs/heads/parent" ? "parent" : "main", files: entries.filter(entry => entry.path === (request.base === "refs/heads/parent" ? "README.md" : "packages/app/src/index.ts")) };
      return { isRepo: true, base: null, files: window.externalCommit ? [] : entries };
    },
    diffFile: async request => {
      if (request.commit) {
        window.commitPatchCalls.push(request);
        if (window.commitPatchHeld) await new Promise(resolve => window.commitPatchWaiters.push(resolve));
        if (window.commitPatchFailure) throw new Error("Commit patch read failed");
      }
      window.fileCalls.push(request.mode + ":" + request.path);
      const file = FILES[request.path];
      return { patch: window.externalEdit ? file.patch.replace("No events scheduled", "External edit") : file.patch, binary: Boolean(file.binary), tooLarge: false };
    },
  },
  onAgentEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); },
};
window.endTurn = () => listeners.forEach(listener => listener({ chatId: "chat-1", event: { type: "turn-completed" } }));
function Fixture() {
  const [panelLists, setPanelLists] = useState(true);
  window.setPanelLists = setPanelLists;
  window.fixturePanelLists = panelLists;
  const changes = useChanges({ cwd: "/fixture", base: "main", chatId: "chat-1", available: true, panelLists });
  window.refreshChanges = changes.refresh;
  const comments = useDiffComments("chat-1", changes);
  const prefs = useDiffPreferences();
  const diff = changes.diffOpen;
  const presence = useDiffPresence(diff);
  return <div className="flex h-screen gap-3 bg-canvas p-0 text-ink">
    <div aria-hidden data-drag-strip className="fixed inset-x-0 top-0 z-50 h-10 [-webkit-app-region:drag]" />
    <ChangesToggle open={changes.open} onToggle={changes.toggle} />
    <main className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden pr-3 pb-3">
      <DiffBar open={diff} onBack={changes.closeDiff} trailing={<DiffToolbar changes={changes} prefs={prefs} />} />
      <AnimatePresence initial={false} onExitComplete={presence.onExitComplete}>
        {diff && <DiffView key="diff" changes={changes} prefs={prefs} comments={comments} />}
      </AnimatePresence>
      <div data-chat-stub className={"flex-1 pt-12 px-6 text-[14px] " + (presence.occupied ? "hidden" : "")}>Chat goes here</div>
    </main>
    <ChangesPanelSlot open={changes.open}>
      <ChangesPanel comparison={changes.comparison} lists={changes.lists} mode={changes.mode} onModeChange={changes.setMode} onRefresh={() => void changes.refresh()} onSelectFile={changes.selectFile} activePath={changes.activePath} />
    </ChangesPanelSlot>
  </div>;
}
// The profile outlives runs; start from default layout and wrap.
localStorage.clear();
createRoot(document.getElementById("root")).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  await app.whenReady();
  const window = new BrowserWindow({ width: 1200, height: 460, show: false, webPreferences: { backgroundThrottling: false } });
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
  const shot = async (name) => {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, `diff-view-${name}.png`), (await window.webContents.capturePage()).toPNG());
  };
  const file = (p) => `[data-diff-file="${p}"]`;
  const CAL = "packages/app/src/components/Calendar/CalendarEmptyState.tsx";
  try {
    await window.loadURL(process.argv[2]);
    // Electron remembers zoom per origin; pin it so the panel and the diff both fit.
    window.webContents.setZoomFactor(1);
    await delay(100);
    await waitFor('!!document.querySelector("[data-changes-toggle]")');
    assert.equal(await evaluate('!!document.querySelector("[data-changes-panel]")'), false, "Panel starts closed");
    await evaluate('document.querySelector("[data-changes-toggle]").click()');
    await waitFor('!!document.querySelector("[data-diff-tree-file]")');

    // The Changes tab counts both sections, a file in both once; each section is its own tree, with its summed counts.
    assert.equal(await evaluate('document.querySelector("[data-changes-tab=changes]").textContent'), "Changes6");
    const folders = await evaluate(
      `[...document.querySelectorAll("[data-changes-section='Not committed'] [data-diff-tree-folder]")].map(node => node.dataset.diffTreeFolder)`,
    );
    assert.deepEqual(folders, ["assets", "assets/data", "packages/app/src", "packages/app/src/components/Calendar"], "Single-child folders merge into one row");
    assert.equal(
      await evaluate("document.querySelector(\"[data-diff-tree-folder='packages/app/src/components/Calendar']\").textContent"),
      "components/Calendar+3−2",
    );
    assert.equal(await evaluate("document.querySelector(\"[data-diff-tree-folder='packages/app/src']\").textContent"), "packages/app/src+5−2");
    assert.match(await evaluate(`document.querySelector("[data-changes-section='Not committed'] h3").textContent`), /^Not committed6.*\+3507−3$/);
    assert.equal(await evaluate("document.querySelector(\"[data-diff-tree-file='packages/app/src/index.ts'] [data-status]\").dataset.status"), "A");
    assert.equal(await evaluate('document.querySelectorAll("[data-diff-view]").length'), 0, "Diff view waits for a file click");
    await delay(200);
    await shot("panel");

    // Clicking a file opens the diff and scrolls to it.
    await evaluate('document.documentElement.classList.add("dark")');
    await evaluate(`document.querySelector('[data-diff-tree-file="README.md"]').click()`);
    await waitFor('!!document.querySelector("[data-diff-view]")');
    assert.ok(await evaluate('!!document.querySelector("[data-diff-back]")'), "The diff shows a Back button");
    // <main> starts at the window's left edge, as with the sidebar collapsed. Both decorations leave room for its toggle.
    const backLeft = 'Math.round(document.querySelector("[data-diff-back]").getBoundingClientRect().left)';
    assert.equal(await evaluate(backLeft), 52, "External decorations reserve only the sidebar toggle and its gap");
    await evaluate('window.setWindowDecoration("leading")');
    await waitFor(`${backLeft} === 120`);
    assert.equal(await evaluate(backLeft), 120, "Back clears the integrated leading controls and sidebar toggle");
    await evaluate('window.setWindowDecoration("external")');
    await waitFor(`${backLeft} === 52`);
    // Electron routes a click in the drag strip to whatever paints on top; every bar button must beat the strip.
    await delay(400);
    assert.equal(
      await evaluate(
        `[...document.querySelectorAll("[data-diff-bar] button")].filter(button => { const r = button.getBoundingClientRect(); return !button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }).length`,
      ),
      0,
      "Diff bar buttons sit above the drag strip",
    );
    // Chromium builds the window's drag region from every element with an app-region, in tree order: drag adds its box,
    // no-drag subtracts it. Only the bar's buttons opt out; the empty stretch between Back and the toolbar still drags the window.
    const draggableAt = (x, y) =>
      evaluate(`(() => {
      let draggable = false;
      for (const node of document.querySelectorAll("*")) {
        const style = getComputedStyle(node);
        const region = style.getPropertyValue("app-region") || style.getPropertyValue("-webkit-app-region");
        if (region !== "drag" && region !== "no-drag") continue;
        const r = node.getBoundingClientRect();
        if (${x} >= r.left && ${x} < r.right && ${y} >= r.top && ${y} < r.bottom) draggable = region === "drag";
      }
      return draggable;
    })()`);
    const barGap = await evaluate(
      '(() => { const back = document.querySelector("[data-diff-back]").getBoundingClientRect(); const tools = document.querySelector("[data-diff-toolbar]").getBoundingClientRect(); return { x: (back.right + tools.left) / 2, y: (back.top + back.bottom) / 2 }; })()',
    );
    assert.ok(barGap.x > 300, "The gap between Back and the toolbar is wide enough to grab");
    assert.equal(await draggableAt(barGap.x, barGap.y), true, "The empty middle of the diff bar drags the window");
    assert.equal(await draggableAt(barGap.x, 6), true, "Above the bar still drags the window");
    const backCentre = await evaluate(
      '(() => { const r = document.querySelector("[data-diff-back]").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()',
    );
    assert.equal(await draggableAt(backCentre.x, backCentre.y), false, "Back is a button, not a drag handle");
    const toolCentre = await evaluate(
      '(() => { const r = document.querySelector("[data-diff-layout=split]").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()',
    );
    assert.equal(await draggableAt(toolCentre.x, toolCentre.y), false, "Toolbar buttons are not drag handles");
    assert.equal(await evaluate('document.querySelector("[data-chat-stub]").classList.contains("hidden")'), true);
    await waitFor(`!!document.querySelector('${file("README.md")} [data-diff-row]')`);
    await delay(150);
    assert.ok(
      await evaluate(
        `Math.abs(document.querySelector('${file("README.md")}').getBoundingClientRect().top - document.querySelector("[data-diff-view]").getBoundingClientRect().top) < 60`,
      ),
      "The clicked file scrolls to the top",
    );
    await evaluate(`document.querySelector('[data-diff-view]').scrollTo(0, 0)`);

    // Unified: two gutters, hunk header, tints, syntax and word highlight.
    await waitFor(`!!document.querySelector('${file(CAL)} [data-diff-row]')`);
    assert.equal(await evaluate(`document.querySelector('${file(CAL)} [data-diff-hunk]').textContent`), "@@ -1,7 +1,7 @@");
    assert.deepEqual(
      await evaluate(
        `[...document.querySelectorAll('${file(CAL)} [data-diff-row]')].map(row => [row.dataset.diffRow, row.children[0].textContent, row.children[1].textContent])`,
      ),
      [
        ["context", "1", "1"],
        ["remove", "2", ""],
        ["add", "", "2"],
        ["context", "3", "3"],
        ["context", "4", "4"],
        ["remove", "5", ""],
        ["add", "", "5"],
        ["context", "6", "6"],
        ["context", "7", "7"],
      ],
    );
    await waitFor(`!!document.querySelector('${file(CAL)} .code-token')`);
    assert.ok(await evaluate(`!!document.querySelector('${file(CAL)} [data-diff-row=add] [class*="diff-add-word"]')`), "Changed words get a darker tint");
    assert.notEqual(await evaluate(`getComputedStyle(document.querySelector('${file(CAL)} [data-diff-row=add]')).backgroundColor`), "rgba(0, 0, 0, 0)");
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('${file(CAL)} header').parentElement).position`), "sticky");

    // Binary and large files.
    assert.ok(await evaluate(`document.querySelector('${file("assets/logo.png")}').textContent.includes("Binary file")`));
    assert.ok(await evaluate('!!document.querySelector("[data-diff-show]")'), "A large diff offers Show diff");
    assert.ok(await evaluate(`document.querySelector('${file("assets/data/big.json")}').textContent.includes("This diff is large")`));
    assert.equal(await evaluate('window.fileCalls.some(call => call.includes("big.json"))'), false, "Large files are not fetched on scroll");
    await shot("unified");

    // Split pairs rows and pads the shorter side.
    await evaluate('document.querySelector("[data-diff-layout=split]").click()');
    await waitFor(`document.querySelectorAll('${file("README.md")} [data-diff-cell]').length > 0`);
    assert.equal(
      await evaluate(`document.querySelectorAll('${file("README.md")} [data-diff-filler]').length`),
      1,
      "One removal against two additions leaves one filler",
    );
    assert.equal(await evaluate(`document.querySelectorAll('${file(CAL)} [data-diff-cell=left]').length`), 7);
    assert.equal(await evaluate(`document.querySelectorAll('${file(CAL)} [data-diff-cell=right]').length`), 7);
    assert.equal(await evaluate('localStorage.getItem("milagre:diff-layout")'), "split");
    await evaluate(`document.querySelector('${file(CAL)}').scrollIntoView()`);
    await delay(150);
    await shot("split");
    // Split never scrolls sideways: both halves stay on screen however long a line is.
    assert.equal(
      await evaluate(`[...document.querySelectorAll("[data-diff-body]")].filter(body => body.scrollWidth > body.clientWidth + 1).length`),
      0,
      "Split fits its card",
    );
    assert.equal(await evaluate('document.querySelector("[data-diff-wrap]").disabled'), true, "Wrap is fixed on in split");
    // Scrolled: the bottom fades and the file header stays pinned.
    await evaluate('document.querySelector("[data-diff-view]").scrollTo(0, 120)');
    await waitFor('document.querySelector("[data-diff-view]").hasAttribute("data-fade-top")');
    await delay(300);
    await shot("scrolled");
    await evaluate('document.documentElement.classList.remove("dark")');
    await delay(200);
    await shot("scrolled-light");
    await evaluate('document.documentElement.classList.add("dark")');
    await evaluate('document.querySelector("[data-diff-layout=unified]").click()');

    // Show diff loads the large file.
    await evaluate('document.querySelector("[data-diff-show]").click()');
    await waitFor('!document.querySelector("[data-diff-show]")');
    await waitFor(`!!document.querySelector('${file("assets/data/big.json")} [data-diff-row]')`);
    assert.ok(await evaluate('window.fileCalls.some(call => call.includes("big.json"))'));

    // Collapse hides the body.
    await evaluate(`document.querySelector('${file("README.md")} [data-diff-collapse]').click()`);
    await waitFor(`!document.querySelector('${file("README.md")} [data-diff-body]')`);

    // The turn ending re-reads the list.
    const before = await evaluate("window.listCalls.length");
    await evaluate("window.endTurn()");
    await waitFor(`window.listCalls.length >= ${before + 1}`);

    // Content can change while the file's added/removed totals stay identical.
    await evaluate("window.externalEdit = true");
    await waitFor(`document.querySelector('${file(CAL)}').textContent.includes("External edit")`);

    // An external commit has no agent event: periodic reads must clear the tree by themselves.
    await evaluate("window.externalCommit = true");
    await waitFor(`!document.querySelector("[data-changes-section='Not committed']")`);
    await evaluate("window.externalCommit = false");
    await waitFor(`document.querySelectorAll("[data-changes-section='Not committed'] [data-diff-tree-file]").length > 0`);

    // The branch's commits are their own section, since its base; a file there opens the committed diff.
    assert.equal(await evaluate(`document.querySelectorAll("[data-changes-section='On this branch'] [data-diff-tree-file]").length`), 1);
    assert.ok(await evaluate('document.querySelector(`[aria-label="Comparison branch"]`).textContent.includes("main")'));
    await evaluate(`document.querySelector("[data-changes-section='On this branch'] [data-diff-tree-file]").click()`);
    await waitFor('window.fileCalls.some(call => call.startsWith("committed:"))');
    await waitFor('document.querySelectorAll("[data-diff-view] [data-diff-file]").length === 1');

    // Back slides the diff out, then the chat returns.
    await evaluate('document.querySelector("[data-diff-back]").click()');
    assert.equal(await evaluate('document.querySelector("[data-chat-stub]").classList.contains("hidden")'), true, "The chat waits for the diff to leave");
    await waitFor('!document.querySelector("[data-diff-view]") && !document.querySelector("[data-diff-bar]")');
    await waitFor('!document.querySelector("[data-chat-stub]").classList.contains("hidden")');
    // The committed file opens its diff again.
    await evaluate(`document.querySelector("[data-changes-section='On this branch'] [data-diff-tree-file]").click()`);
    await waitFor('!!document.querySelector("[data-diff-view]")');
    // While the diff shows the committed files, a refresh re-reads only their patches, not the uncommitted ones.
    const uncommittedReads = await evaluate('window.fileCalls.filter(call => call.startsWith("uncommitted:")).length');
    const lists = await evaluate("window.listCalls.length");
    await evaluate("window.endTurn()");
    await waitFor(`window.listCalls.length >= ${lists + 2}`);
    await delay(200);
    assert.equal(await evaluate('window.fileCalls.filter(call => call.startsWith("uncommitted:")).length'), uncommittedReads);

    // A chosen comparison narrows committed files without changing the Worktree branch.
    await evaluate('document.querySelector(`[aria-label="Comparison branch"]`).click()');
    await waitFor('!!document.querySelector("[role=listbox]")');
    await evaluate('[...document.querySelectorAll("[role=option]")].find(row => row.textContent === "parent").click()');
    await waitFor('document.querySelector(`[aria-label="Comparison branch"]`)?.textContent.includes("parent")');
    assert.equal(await evaluate("window.lastBase"), "refs/heads/parent");
    assert.ok(await evaluate('document.querySelector("[data-changes-panel]").textContent.includes("feature/current")'));
    await evaluate('[...document.querySelectorAll(`[aria-label="Changes view"] button`)].find(button => button.dataset.comparisonView === "commits").click()');
    await waitFor('!!document.querySelector("[data-commit-history] details")');
    await evaluate('document.querySelector("[data-commit-history] summary").click()');
    assert.ok(await evaluate('document.querySelector("[data-commit-history]").textContent.includes("maria@example.com")'));
    assert.ok(await evaluate('document.querySelector("[data-commit-history]").textContent.includes("Detailed explanation")'));
    assert.ok(await evaluate('document.querySelector("[data-commit-history]").textContent.includes("2 files")'));
    if (process.env.MILAGRE_SCREENSHOT_DIR) {
      window.showInactive();
      await delay(300);
      fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "comparison-history.png"), (await window.webContents.capturePage()).toPNG());
    }
    // A slow larger page keeps the visible commit card, its expansion and branch metadata in place.
    await evaluate('[...document.querySelectorAll("[data-commit-history] button")].find(button => button.textContent === "Show files in this commit").click()');
    await waitFor('document.querySelector("[data-commit-files] [data-diff-tree-file]")');
    assert.equal(await evaluate("window.commitFileCalls.at(-1).commit"), "a".repeat(40));
    assert.equal(await evaluate('document.querySelectorAll("[data-commit-files] [data-diff-tree-file]").length'), 1);
    await evaluate('window.commitPatchFailure = true; document.querySelector("[data-commit-files] [data-diff-tree-file]").click()');
    await waitFor('document.querySelector("[data-commit-patch-retry]")');
    const commitListReads = await evaluate("window.commitFileCalls.length");
    await evaluate(
      'window.retainedCommitTreeRow = document.querySelector("[data-commit-files] [data-diff-tree-file]"); window.commitPatchFailure = false; window.commitPatchHeld = true; document.querySelector("[data-commit-patch-retry]").click()',
    );
    await waitFor("window.commitPatchWaiters.length === 1");
    assert.equal(await evaluate("window.commitFileCalls.length"), commitListReads, "retry only re-reads the patch");
    assert.equal(await evaluate('document.querySelector("[data-commit-files] [data-diff-tree-file]") === window.retainedCommitTreeRow'), true);
    await evaluate("window.releaseCommitPatch()");
    await waitFor('document.querySelector("[data-commit-files] [data-diff-hunk]")');
    assert.equal(await evaluate("window.commitPatchCalls.at(-1).commit"), "a".repeat(40));
    assert.ok(await evaluate('document.querySelector("[data-commit-files] [data-diff-row=add]").textContent.includes("New tagline")'));
    assert.ok(
      await evaluate('document.querySelector("[data-commit-files] [data-diff-row=add]").querySelectorAll("span")[1].textContent.trim().length > 0'),
      "line numbers are rendered",
    );
    assert.equal(
      await evaluate('document.querySelectorAll("[data-commit-files] [data-diff-add]").length'),
      0,
      "historical inspection offers no comment write actions",
    );
    assert.ok(await evaluate('!!document.querySelector("[data-commit-files] [class*=diff-add-word]")'), "changed words use the shared renderer");
    assert.equal(await evaluate('document.querySelector("[data-commit-files]").textContent.includes("--- a/x")'), false);
    assert.equal(await evaluate('getComputedStyle(document.querySelector("[data-commit-files] [data-diff-body]")).maxHeight'), "none");
    await evaluate('document.querySelector("[data-commit-files] [data-diff-hunk]").scrollIntoView({ block: "end", behavior: "instant" })');
    await delay(150);
    if (process.env.MILAGRE_SCREENSHOT_DIR)
      await fs.promises.writeFile(path.join(process.env.MILAGRE_SCREENSHOT_DIR, "commit-files.png"), (await window.webContents.capturePage()).toPNG());
    await evaluate('[...document.querySelectorAll("[data-commit-history] button")].find(button => button.textContent === "Hide files in this commit").click()');
    await waitFor('!document.querySelector("[data-commit-files]")');
    await evaluate(
      'window.commitRoot = true; window.commitTruncated = true; [...document.querySelectorAll("[data-commit-history] button")].find(button => button.textContent === "Show files in this commit").click()',
    );
    await waitFor('document.querySelector("[data-commit-files]")?.textContent.includes("1000+ files · First commit")');
    await evaluate('[...document.querySelectorAll("[data-commit-history] button")].find(button => button.textContent === "Hide files in this commit").click()');
    await evaluate(
      'window.historyHeld = true; window.retainedCommit = document.querySelector("[data-commit-history] details"); [...document.querySelectorAll("button")].find(button => button.textContent === "Show more commits").click()',
    );
    await waitFor("window.historyWaiters.length > 0");
    assert.equal(await evaluate('document.querySelector("[data-commit-history] details") === window.retainedCommit && window.retainedCommit.open'), true);
    assert.ok(await evaluate('document.querySelector("[data-changes-panel]").textContent.includes("feature/current")'));
    await evaluate('[...document.querySelectorAll(`[aria-label="Changes view"] button`)].find(button => button.dataset.comparisonView === "files").click()');
    assert.ok(await evaluate('document.querySelector("[data-changes-panel]").textContent.includes("feature/current")'));
    assert.ok(await evaluate('document.querySelector(`[aria-label="Comparison branch"]`).textContent.includes("parent")'));
    await evaluate('[...document.querySelectorAll(`[aria-label="Changes view"] button`)].find(button => button.dataset.comparisonView === "commits").click()');
    await waitFor('document.querySelectorAll("[data-commit-history] details").length === 1');
    await evaluate("window.releaseHistory()");
    await waitFor('document.querySelectorAll("[data-commit-history] details").length === 2');

    assert.ok(await evaluate('window.historyCalls.slice(1).some(call => call.branchesVersion === "v1")'), "polls acknowledge the catalogue version");
    await evaluate('if (!document.querySelector("[data-commit-history] details").open) document.querySelector("[data-commit-history] summary").click()');
    for (const reason of ["timeout", "tooLarge"]) {
      await evaluate(`window.statsLimit = ${JSON.stringify(reason)}; window.refreshChanges()`);
      await waitFor('document.querySelector("[data-commit-history] summary").textContent.includes("Totals unavailable")');
      assert.equal(await evaluate('document.querySelectorAll("[data-commit-history] details").length'), 2);
      assert.ok(
        await evaluate(
          'document.querySelector("[data-commit-history] details").open && document.querySelector("[data-commit-history] details").textContent.includes("maria@example.com")',
        ),
      );
      assert.equal(await evaluate('document.querySelector("[data-commit-history] details:first-of-type summary [data-diff-counts]")'), null);
      await evaluate("window.statsLimit = null; window.refreshChanges()");
      await waitFor('!!document.querySelector("[data-commit-history] details:first-of-type summary [data-diff-counts]")');
    }
    assert.equal(await evaluate('document.querySelector(`[data-comparison-view="commits"] span`).textContent'), "2");
    await evaluate('document.querySelector(`[aria-label="Comparison branch"]`).click()');
    await waitFor('!!document.querySelector("[role=listbox]")');
    assert.ok(
      await evaluate(
        '[...document.querySelectorAll("[role=option]")].some(row => row.textContent.includes("feature/current") && row.getAttribute("aria-disabled") === "true")',
      ),
    );
    assert.ok(
      await evaluate(
        'document.querySelector("[role=listbox]").textContent.includes("Suggested") && document.querySelector("[role=listbox]").textContent.includes("Remote · origin")',
      ),
    );
    await evaluate('document.querySelector(`[aria-label="Comparison branch"]`).click(); window.noSharedHistory = true; window.refreshChanges()');
    await waitFor('document.querySelector("[data-comparison-controls]").textContent.includes("shares no history")');
    await evaluate('[...document.querySelectorAll("button")].find(button => button.textContent === "Compare with main instead").click()');
    await waitFor('window.lastBase === "refs/heads/main"');
    await evaluate('document.querySelector(`[aria-label="Comparison branch"]`).click()');
    await waitFor('!!document.querySelector("[role=listbox]")');
    await evaluate('[...document.querySelectorAll("[role=option]")].find(row => row.textContent === "parent").click()');
    await waitFor('window.lastBase === "refs/heads/parent"');
    await evaluate("window.noSharedHistory = false; window.branchDeleted = true; window.refreshChanges()");
    await waitFor('window.lastBase === "main" && document.querySelector("[role=status]")?.textContent.includes("parent no longer exists")');
    await evaluate('document.querySelector(`[aria-label="Dismiss missing branch notice"]`).click()');
    assert.equal(await evaluate('!!document.querySelector("[role=status]")'), false);

    // An older host keeps file diffs usable without an unavailable-history error card.
    await evaluate('window.historyError = "Unknown command: git:history"; window.refreshChanges()');
    await waitFor('!document.querySelector(`[aria-label="Comparison branch"]`) && !!document.querySelector("[data-diff-tree-file]")');
    assert.equal(await evaluate('document.querySelector("[data-changes-panel]").textContent.includes("Unknown command")'), false);
    await evaluate("window.historyError = null; window.refreshChanges()");
    await waitFor('!!document.querySelector(`[aria-label="Comparison branch"]`)');

    // Closing the panel returns to Chat.
    await evaluate('document.querySelector("[data-changes-toggle]").click()');
    await waitFor('!document.querySelector("[data-changes-panel]") && !document.querySelector("[data-diff-view]")');
    assert.equal(await evaluate('document.querySelector("[data-chat-stub]").classList.contains("hidden")'), false);
    // Link panels own their member histories. This unused reader stays inactive for every refresh route.
    await evaluate("window.setPanelLists(false)");
    await waitFor("window.fixturePanelLists === false");
    const historyCalls = await evaluate("window.historyCalls.length");
    await evaluate('document.querySelector("[data-changes-toggle]").click()');
    await waitFor('!!document.querySelector("[data-changes-panel]")');
    await evaluate("window.refreshChanges()");
    await evaluate("window.endTurn()");
    await delay(200);
    assert.equal(await evaluate("window.historyCalls.length"), historyCalls, "Link diff readers never request the member histories owned by their panel");

    console.log(
      "PASS: panel tree with merged folders and counts, file click opens the diff, Back slides it out, unified gutters and word tint, split pairing, large and binary files, committed section, turn-end and external-change refresh",
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
        name: "diff-view-fixture",
        resolveId(id) {
          if (id === "/__diff_view_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__diff_view_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__diff_view__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__diff_view_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__diff_view__`], { env, stdio: "inherit" });
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
