// Electron check of the Changes panel's PR mode: the merge card, files with viewed toggles, the PR's diff with a
// GitHub thread, adding to the review, submitting it, and the review guide. window.milagre.pr is a stub.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AnimatePresence } from "motion/react";
import { ChangesPanel } from "/src/components/changes/ChangesPanel";
import { ChangesPanelSlot } from "/src/components/changes/ChangesPanelSlot";
import { DiffBar } from "/src/components/changes/ChangesChrome";
import { DiffToolbar, DiffView, useDiffPreferences, useDiffPresence } from "/src/components/changes/DiffView";
import { ReviewGuideView } from "/src/components/changes/ReviewGuideView";
import { PullRequestPanelBody } from "/src/components/changes/PullRequestPanel";
import { useChanges } from "/src/components/changes/useChanges";
import { useDiffComments } from "/src/components/changes/useDiffComments";
import { usePullRequest, useReviewGuide } from "/src/components/changes/usePullRequest";
import { prRange, threadFixMessage } from "/src/lib/pull-request-view";
import "/src/styles.css";
window.setWindowDecoration = () => {};
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const PATCH = ["diff --git a/src/save.ts b/src/save.ts", "--- a/src/save.ts", "+++ b/src/save.ts", "@@ -1,3 +1,4 @@",
  " export async function save(file) {", "-  toast();", "+  await pick();", '+  showToast("File saved.");', " }", ""].join("\\n");
const pr = {
  number: 673, url: "https://github.com/the-ptf/milagre/pull/673", title: "fix: open shared files across devices", body: "Shared files **open** on paired Macs.",
  state: "OPEN", isDraft: false, author: "victorlucss", createdAt: "2026-10-25T10:00:00Z", updatedAt: "2026-10-25T10:00:00Z",
  baseRefName: "main", headRefName: "milagre/fix-shared-file", headRefOid: HEAD, baseRefOid: BASE, additions: 3, deletions: 1, changedFiles: 2,
  mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", autoMerge: null, viewerCanMergeAsAdmin: false, viewerIsAuthor: true,
  checks: [{ name: "unit", workflow: "CI", outcome: "pass" }, { name: "smoke", outcome: "skipped" }],
  reviewers: [{ login: "marcosgenesis", state: "APPROVED" }, { login: "jefo3", state: "COMMENTED" }],
  labels: [], commits: [{ oid: HEAD, headline: "fix" }],
  files: [
    { path: "src/save.ts", additions: 2, deletions: 1, status: "modified", viewed: "UNVIEWED" },
    { path: "src/toast.tsx", additions: 1, deletions: 0, status: "added", viewed: "VIEWED" },
  ],
  threads: [{ id: "T1", path: "src/save.ts", line: 3, side: "RIGHT", resolved: false, outdated: false,
    comments: [{ id: "C1", author: "jefo3", body: "Should the toast wait for the picker?", createdAt: "2026-10-25T11:00:00Z" }] }],
  comments: [], pendingReview: { id: "R1", count: 1 },
};
const guide = { headRefOid: HEAD, provider: "claude", writtenAt: "", notCovered: ["src/toast.tsx"], stops: [
  { title: "The save path", kind: "implementation", summary: "Saving picks a folder first.", attention: { kind: "risk", text: "The toast can cover the sheet." },
    excerpts: [{ path: "src/save.ts", startLine: 1, endLine: 3, lines: [{ number: 1, text: "export async function save(file) {", added: false }, { number: 2, text: "  await pick();", added: true }, { number: 3, text: '  showToast("File saved.");', added: true }], notes: [{ letter: "A", line: 3, text: "Runs before the picker closes." }] }],
    files: [], questions: ["Should it wait?"] },
  { title: "The toast", kind: "ui", summary: "A new toast.", excerpts: [], files: [{ path: "src/toast.tsx", note: "New" }], questions: [] },
] };
window.calls = [];
const record = (name) => async (request) => { window.calls.push({ name, ...request }); return { ok: true }; };
window.milagre = {
  git: { diffFiles: async () => ({ isRepo: true, base: null, files: [] }), diffFile: async () => ({ patch: "", binary: false, tooLarge: false }) },
  pr: {
    detail: async () => ({ ok: true, pr }),
    diffFiles: async (request) => { window.calls.push({ name: "diffFiles", ...request }); return { isRepo: true, base: null, files: [
      { path: "src/save.ts", status: "modified", added: 2, removed: 1, binary: false },
      { path: "src/toast.tsx", status: "added", added: 1, removed: 0, binary: false },
    ] }; },
    diffFile: async (request) => ({ patch: request.path === "src/save.ts" ? PATCH : "@@ -0,0 +1 @@\\n+export {};\\n", binary: false, tooLarge: false }),
    comment: record("comment"), reply: record("reply"), deleteComment: record("deleteComment"), submitReview: record("submitReview"),
    resolveThread: record("resolveThread"), fileViewed: record("fileViewed"), merge: record("merge"), ready: record("ready"),
    guide: async () => ({ ok: true, guide, read: [], writing: false }), writeGuide: async () => ({ ok: true, writing: true }), guideRead: record("guideRead"),
  },
  onAgentEvent: () => () => {},
};
function Fixture() {
  const review = usePullRequest({ cwd: "/fixture", number: 673, active: true, bridge: window.milagre });
  const changes = useChanges({ cwd: "/fixture", base: "main", chatId: "chat-1", available: true, pullRequest: { number: 673, range: prRange(review.pr) } });
  const guideState = useReviewGuide({ cwd: "/fixture", pr: review.pr, active: changes.mode === "pr", bridge: window.milagre });
  const comments = useDiffComments("chat-1", changes);
  const prefs = useDiffPreferences();
  const [stop, setStop] = useState(0);
  const guideShowing = changes.guideOpen && Boolean(guideState.guide);
  const presence = useDiffPresence(changes.diffOpen || guideShowing);
  const toChat = (text) => { window.sent = text; changes.closeDiff(); };
  const prReview = review.pr ? { pr: review.pr, threadActions: { reply: async () => true, resolve: () => {}, deleteComment: () => {}, fixInChat: (thread) => toChat(threadFixMessage(review.pr, thread)) },
    addToReview: (selection, path, body) => void review.write("comment", (bridge, cwd, number) => bridge.comment({ cwd, number, path, line: selection.end, side: selection.side === "old" ? "LEFT" : "RIGHT", body })),
    toggleViewed: () => {}, submit: async (event, body) => (await review.write("submit", (bridge, cwd, number) => bridge.submitReview({ cwd, number, event, body }))).ok, error: review.writeError } : undefined;
  const openGuide = (next) => { if (guideShowing && next > stop) void guideState.markRead(stop); if (next >= (guideState.guide?.stops.length ?? 0)) return changes.closeDiff(); setStop(next); changes.openGuide(); };
  return <div className="flex h-screen gap-3 bg-canvas p-0 text-ink">
    <button data-open-pr onClick={changes.showPullRequest} className="fixed bottom-2 left-2 z-50">PR</button>
    <main className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden pr-3 pb-3">
      <DiffBar open={changes.diffOpen || guideShowing} onBack={changes.closeDiff} trailing={guideShowing ? undefined : <DiffToolbar changes={changes} prefs={prefs} />} />
      <AnimatePresence initial={false} onExitComplete={presence.onExitComplete}>
        {changes.diffOpen && <DiffView key="diff" changes={changes} prefs={prefs} comments={comments} review={prReview} />}
        {guideShowing && <ReviewGuideView key="guide" pr={review.pr} guide={guideState.guide} stop={stop} onStop={openGuide} onOpenFile={changes.selectFile} onAsk={() => {}} />}
      </AnimatePresence>
      <div data-chat-stub className={"flex-1 pt-12 px-6 " + (presence.occupied ? "hidden" : "")}>Chat goes here</div>
    </main>
    <ChangesPanelSlot open={changes.open}>
      <ChangesPanel list={changes.list} mode={changes.mode} onModeChange={changes.setMode} onRefresh={() => void review.refresh()} onSelectFile={changes.selectFile} activePath={changes.activePath}
        pullRequest={{ number: 673, choices: [{ number: 673, state: "OPEN" }, { number: 650, state: "MERGED" }], onPick: (number) => { window.picked = number; },
          totals: { added: 3, removed: 1 }, loading: false, body: <PullRequestPanelBody review={review} guide={guideState}
          actions={{ openFile: changes.selectFile, fixChecks: () => {}, fixThread: (p, thread) => toChat(threadFixMessage(p, thread)), openGuide, writeGuide: () => void guideState.write("claude") }}
          activePath={changes.activePath} guideOpen={guideShowing} guideStop={stop} local={{ count: 2, onOpen: () => changes.setMode("uncommitted") }} /> }} />
    </ChangesPanelSlot>
  </div>;
}
localStorage.clear();
createRoot(document.getElementById("root")).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  await app.whenReady();
  const window = new BrowserWindow({ width: 1280, height: 760, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) =>
    window.webContents.executeJavaScript(source).catch((error) => {
      throw new Error(`evaluate failed: ${source}\n${error}`);
    });
  async function waitFor(source) {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${source}`);
  }
  const dir = process.env.MILAGRE_SCREENSHOT_DIR;
  const shot = async (name) => dir && fs.writeFileSync(path.join(dir, `pr-panel-${name}.png`), (await window.webContents.capturePage()).toPNG());
  const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const calls = (name) => evaluate(`window.calls.filter((call) => call.name === ${JSON.stringify(name)})`);
  try {
    if (dir) fs.mkdirSync(dir, { recursive: true });
    await window.loadURL(process.argv[2]);
    window.webContents.setZoomFactor(1);
    await evaluate('document.documentElement.classList.add("dark")');
    await waitFor('!!document.querySelector("[data-open-pr]")');
    await click("[data-open-pr]");

    // The panel opens in PR mode on the merge card.
    await waitFor('!!document.querySelector("[data-pr-merge-title]")');
    assert.equal(await text("[data-pr-merge-title]"), "Ready to merge");
    assert.equal(await text("[data-pr-merge-detail]"), "Checks passed · 1 approval · no conflicts");
    assert.match(await text("[data-pr-merge]"), /Squash and merge/);
    assert.equal(await text("[data-pr-viewed-count]"), "1 of 2 viewed");
    assert.equal(await text("[data-pr-file-threads]"), "1", "The file with an open thread is marked");
    assert.match(await text("[data-changes-panel] [data-diff-counts=total]"), /\+3/);
    await delay(150);
    await shot("panel");

    // Merging asks once more, then merges with the remembered method.
    await click("[data-pr-merge]");
    assert.match(await text("[data-pr-merge]"), /Confirm merge/);
    assert.equal((await calls("merge")).length, 0, "The first click only asks to confirm");
    await click("[data-pr-merge]");
    await waitFor('window.calls.some((call) => call.name === "merge")');
    assert.equal((await calls("merge"))[0].method, "squash");

    // A file opens the PR's diff with GitHub's thread under its line.
    await click('[data-pr-file="src/save.ts"] button');
    await waitFor('!!document.querySelector("[data-diff-view] [data-pr-thread=T1]")');
    const diffCall = (await calls("diffFiles"))[0];
    assert.deepEqual([diffCall.base, diffCall.head], ["b".repeat(40), "a".repeat(40)], "The diff reads the PR's commits");
    assert.equal(await text("[data-pr-thread=T1] [data-pr-thread-label]"), "Open");
    assert.ok(await evaluate('!!document.querySelector(\'[data-diff-file="src/save.ts"] [data-pr-viewed="off"]\')'), "The file header has a Viewed toggle");
    await delay(200);
    await shot("diff");

    // A new line comment can go to the review.
    await evaluate(
      `document.querySelectorAll('[data-diff-file="src/save.ts"] [data-diff-row=add]')[0].querySelector("[data-diff-add]").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }))`,
    );
    await evaluate('window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))');
    await waitFor('!!document.querySelector("[data-diff-comment-input]")');
    assert.equal(await text("[data-diff-comment-save]"), "Add to review⌘↵");
    assert.ok(await evaluate('!!document.querySelector("[data-diff-comment-chat]")'), "Send to Chat sits beside it");
    await evaluate(
      `(() => { const field = document.querySelector("[data-diff-comment-input]"); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(field, "Why pick first?"); field.dispatchEvent(new Event("input", { bubbles: true })); })()`,
    );
    await click("[data-diff-comment-save]");
    await waitFor('window.calls.some((call) => call.name === "comment")');
    const comment = (await calls("comment"))[0];
    assert.deepEqual([comment.path, comment.line, comment.side, comment.body], ["src/save.ts", 2, "RIGHT", "Why pick first?"]);

    // The review bar submits the pending review with a verdict.
    assert.equal(await text("[data-pr-review-summary]"), "1 pending · 1 of 2 viewed");
    await click("[data-pr-review-open]");
    await waitFor('!!document.querySelector("[data-pr-review-form]")');
    await shot("review");
    await click("[data-pr-review-submit]");
    await waitFor('window.calls.some((call) => call.name === "submitReview")');
    assert.equal((await calls("submitReview"))[0].event, "COMMENT");

    // Fix in Chat on the thread goes to the Chat with its context.
    await click("[data-pr-thread=T1] [data-pr-fix]");
    await waitFor("typeof window.sent === 'string'");
    assert.match(await evaluate("window.sent"), /src\/save\.ts:3/);

    // The guide: Start opens its first stop; the panel lists the stops; Next marks the first read.
    await waitFor('!!document.querySelector("[data-pr-guide-start]")');
    await click("[data-pr-guide-start]");
    await waitFor('!!document.querySelector("[data-guide-title]")');
    assert.equal(await text("[data-guide-title]"), "The save path");
    assert.equal(await text("[data-guide-position]"), "Stop 1 of 2");
    assert.ok(await evaluate('!!document.querySelector("[data-guide-attention=risk]")'));
    assert.ok(await evaluate("!!document.querySelector(\"[data-pr-guide-stops] [data-pr-guide-stop='1']\")"), "The panel lists the stops");
    await delay(200);
    await shot("guide");
    await click("[data-guide-next]");
    await waitFor('document.querySelector("[data-guide-title]")?.textContent === "The toast"');
    assert.equal((await calls("guideRead"))[0].stop, 0);
    await click("[data-diff-back]");
    await waitFor('!document.querySelector("[data-guide-view]")');

    // Uncommitted files show as "Not in the PR yet", which switches the panel to them.
    assert.match(await text("[data-pr-local]"), /Not in the PR yet\s*2 files/);
    await click("[data-pr-local]");
    await waitFor('document.querySelector("[data-changes-panel]")?.getAttribute("aria-label") === "Changes"');

    console.log(
      "PASS: PR panel merge card and confirm, files and viewed count, PR diff with thread, add to review, submit review, Fix in Chat, review guide, local changes row",
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
        name: "pr-panel-fixture",
        resolveId(id) {
          if (id === "/__pr_panel_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__pr_panel_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__pr_panel__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__pr_panel_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__pr_panel__`], { env, stdio: "inherit" });
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
