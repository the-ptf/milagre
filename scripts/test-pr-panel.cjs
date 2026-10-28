// Electron check of the Changes panel's PR tab: its header and merge button, checks status, reviewers and labels with
// their pickers, comment cards, the Files tab, the PR's diff with a GitHub thread, adding to the review and submitting
// it. window.milagre.pr is a stub.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React from "react";
import { createRoot } from "react-dom/client";
import { AnimatePresence } from "motion/react";
import { ChangesPanel } from "/src/components/changes/ChangesPanel";
import { ChangesPanelSlot } from "/src/components/changes/ChangesPanelSlot";
import { DiffBar } from "/src/components/changes/ChangesChrome";
import { DiffToolbar, DiffView, useDiffPreferences, useDiffPresence } from "/src/components/changes/DiffView";
import { PullRequestPanelBody } from "/src/components/changes/PullRequestPanel";
import { useChanges } from "/src/components/changes/useChanges";
import { useDiffComments } from "/src/components/changes/useDiffComments";
import { usePullRequest } from "/src/components/changes/usePullRequest";
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
  labels: [{ name: "bug", color: "d73a4a" }], commits: [{ oid: HEAD, headline: "fix" }],
  files: [
    { path: "src/save.ts", additions: 2, deletions: 1, status: "modified" },
    { path: "src/toast.tsx", additions: 1, deletions: 0, status: "added" },
  ],
  threads: [{ id: "T1", path: "src/save.ts", line: 3, side: "RIGHT", resolved: false, outdated: false,
    comments: [{ id: "C1", author: "jefo3", body: "Should the toast wait for the picker?", createdAt: "2026-10-25T11:00:00Z" }] }],
  comments: [{ id: "IC1", author: "marcosgenesis", body: "Looks **good** to me.", createdAt: "2026-10-25T12:00:00Z" }], pendingReview: { id: "R1", count: 1 },
};
window.calls = [];
window.prDetailBase = pr;
const record = (name) => async (request) => { window.calls.push({ name, ...request }); return { ok: true }; };
window.milagre = {
  git: { diffFiles: async () => ({ isRepo: true, base: null, files: [] }), diffFile: async () => ({ patch: "", binary: false, tooLarge: false }) },
  pr: {
    detail: async () => ({ ok: true, pr: window.prDetail ?? pr }),
    diffFiles: async (request) => { window.calls.push({ name: "diffFiles", ...request }); return { isRepo: true, base: null, files: [
      { path: "src/save.ts", status: "modified", added: 2, removed: 1, binary: false },
      { path: "src/toast.tsx", status: "added", added: 1, removed: 0, binary: false },
    ] }; },
    diffFile: async (request) => ({ patch: request.path === "src/save.ts" ? PATCH : "@@ -0,0 +1 @@\\n+export {};\\n", binary: false, tooLarge: false }),
    comment: record("comment"), reply: record("reply"), deleteComment: record("deleteComment"), submitReview: record("submitReview"),
    resolveThread: record("resolveThread"), merge: record("merge"), ready: record("ready"),
    labels: async (request) => (window.calls.push({ name: "labels", ...request }), { ok: true, labels: [{ name: "bug", color: "d73a4a", description: "Something isn't working" }, { name: "ui", color: "0e8a16", description: "" }] }),
    setLabels: record("setLabels"),
    reviewerCandidates: async () => ({ ok: true, logins: ["jefo3", "marcosgenesis", "octocat", "victorlucss"] }),
    requestReviewers: record("requestReviewers"),
  },
  onAgentEvent: () => () => {},
};
function Fixture() {
  const review = usePullRequest({ cwd: "/fixture", number: 673, active: true, bridge: window.milagre });
  // Where the pickers read their options; a Link Chat's other PR reads another Worktree.
  const [source, setSource] = React.useState("/fixture");
  window.setSource = setSource;
  const changes = useChanges({ cwd: "/fixture", base: "main", chatId: "chat-1", available: true, pullRequest: { number: 673, range: prRange(review.pr) } });
  const comments = useDiffComments("chat-1", changes);
  const prefs = useDiffPreferences();
  const presence = useDiffPresence(changes.diffOpen);
  const toChat = (text) => { window.sent = text; changes.closeDiff(); };
  const prReview = review.pr ? { pr: review.pr, threadActions: { reply: async () => true, resolve: () => {}, deleteComment: () => {}, fixInChat: (thread) => toChat(threadFixMessage(review.pr, thread)) },
    addToReview: (selection, path, body) => void review.write("comment", (bridge, cwd, number) => bridge.comment({ cwd, number, path, line: selection.end, side: selection.side === "old" ? "LEFT" : "RIGHT", body })),
    submit: async (event, body) => (await review.write("submit", (bridge, cwd, number) => bridge.submitReview({ cwd, number, event, body }))).ok, error: review.writeError } : undefined;
  return <div className="flex h-screen gap-3 bg-canvas p-0 text-ink">
    <button data-open-pr onClick={changes.showPullRequest} className="fixed bottom-2 left-2 z-50">PR</button>
    <main className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden pr-3 pb-3">
      <DiffBar open={changes.diffOpen} onBack={changes.closeDiff} trailing={<DiffToolbar changes={changes} prefs={prefs} />} />
      <AnimatePresence initial={false} onExitComplete={presence.onExitComplete}>
        {changes.diffOpen && <DiffView key="diff" changes={changes} prefs={prefs} comments={comments} review={prReview} />}
      </AnimatePresence>
      <div data-chat-stub className={"flex-1 pt-12 px-6 " + (presence.occupied ? "hidden" : "")}>Chat goes here</div>
    </main>
    <ChangesPanelSlot open={changes.open}>
      <ChangesPanel lists={changes.lists} mode={changes.mode} onModeChange={changes.setMode} onRefresh={() => void review.refresh()} onSelectFile={changes.selectFile} activePath={changes.activePath}
        pullRequest={{ number: 673, choices: [{ number: 673, state: "OPEN" }, { number: 650, state: "MERGED" }], onPick: (number) => { window.picked = number; },
          loading: false, body: <PullRequestPanelBody review={review} source={{ bridge: window.milagre.pr, cwd: source }}
          actions={{ openFile: changes.selectFile }} activePath={changes.activePath} local={{ count: 2, onOpen: () => changes.setMode("uncommitted") }} /> }} />
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

    // The panel opens on the PR's tab, beside the Changes tab and the Chat's other PR.
    await waitFor('!!document.querySelector("[data-pr-identity]")');
    const selected = (key) => evaluate(`document.querySelector('[data-changes-tab="${key}"]')?.getAttribute("aria-selected") ?? null`);
    assert.equal(await selected("pr:673"), "true");
    assert.equal(await selected("pr:650"), "false");
    assert.equal(await selected("changes"), "false");
    assert.match(await text("[data-pr-link]"), /the-ptf\/milagre\s*#673/);
    assert.equal(await text("[data-pr-merge]"), "Merge", "A ready PR gets the Merge button");

    // Summary | Files 2, with the checks status and its bar beside them.
    assert.equal(await evaluate('document.querySelector("[data-pr-tab=summary]").getAttribute("aria-selected")'), "true");
    assert.match(await text("[data-pr-tab=files]"), /Files\s*2/);
    assert.equal(await evaluate('document.querySelector("[data-pr-checks-status]").getAttribute("data-pr-checks-status")'), "pass");
    assert.equal(await text("[data-pr-checks-status]"), "1 passed · 1 skipped");
    assert.equal(await evaluate('document.querySelector("[data-pr-status]")'), null, "A ready PR has no blocked line");
    assert.deepEqual(
      await evaluate('[...document.querySelectorAll("[data-pr-checks-segment]")].map((segment) => segment.getAttribute("data-pr-checks-segment"))'),
      ["passed", "skipped"],
    );

    // Reviewers by review state, the PR's labels, and the comments as cards, newest first.
    assert.deepEqual(
      await evaluate('[...document.querySelectorAll("[data-pr-reviewers] [data-pr-reviewer]")].map((reviewer) => reviewer.getAttribute("data-pr-reviewer"))'),
      ["APPROVED", "COMMENTED"],
    );
    assert.equal(await text("[data-pr-labels] [data-pr-label=bug]"), "bug");
    const cards = () =>
      evaluate(
        '[...document.querySelectorAll("[data-pr-comments] article")].map((card) => card.getAttribute("data-pr-open-thread") ?? card.getAttribute("data-pr-comment"))',
      );
    assert.deepEqual(await cards(), ["IC1", "T1"]);
    assert.equal(await text("[data-pr-open-thread=T1] [data-pr-thread-path]"), "src/save.ts:3");
    assert.match(await text("[data-pr-comment=IC1]"), /marcosgenesis.*Looks good to me\./s);
    await click("[data-pr-comments-sort]");
    assert.deepEqual(await cards(), ["T1", "IC1"], "Oldest first flips them");
    await delay(150);
    await shot("panel");

    // The label picker lists the repository's labels; picking one adds it.
    await click("[data-pr-labels-add]");
    await waitFor('[...document.querySelectorAll("[data-picker-row]")].some((row) => row.textContent.includes("ui"))');
    await shot("labels");
    await evaluate('[...document.querySelectorAll("[data-picker-row]")].find((row) => row.textContent.startsWith("ui")).click()');
    await waitFor('window.calls.some((call) => call.name === "setLabels")');
    assert.deepEqual((await calls("setLabels"))[0], { name: "setLabels", cwd: "/fixture", number: 673, add: ["ui"], remove: [] });
    await click("[data-pr-labels-add]");
    await waitFor('!document.querySelector("[data-picker-panel]")');

    // Label text reads at 4.5:1 or better on its chip, in dark and light, even for a pale yellow.
    const contrast = () =>
      evaluate(`(() => {
        const canvas = document.createElement("canvas"), context = canvas.getContext("2d", { willReadFrequently: true });
        const rgb = (color) => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3); };
        const luminance = (color) => { const [r, g, b] = rgb(color).map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        return Math.min(...["d73a4a", "fbca04", "0e8a16", "ededed", "000000", "5319e7"].map((color) => {
          const chip = document.querySelector("[data-pr-label]");
          chip.style.setProperty("--label", "#" + color);
          const style = getComputedStyle(chip), a = luminance(style.color), b = luminance(style.backgroundColor);
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        }));
      })()`);
    assert.ok((await contrast()) >= 4.5, "Label chips read in dark");
    await evaluate('document.documentElement.classList.remove("dark")');
    assert.ok((await contrast()) >= 4.5, "Label chips read in light");
    await evaluate('document.documentElement.classList.add("dark"); document.querySelector("[data-pr-label]").style.setProperty("--label", "#d73a4a")');

    // The reviewer picker leaves out the author; picking someone requests their review.
    await click("[data-pr-reviewers-add]");
    await waitFor('[...document.querySelectorAll("[data-picker-row]")].some((row) => row.textContent.includes("octocat"))');
    assert.ok(
      await evaluate(
        'document.querySelector("[data-picker-panel]").getBoundingClientRect().left >= document.querySelector("[data-changes-panel]").getBoundingClientRect().left',
      ),
      "The picker opens inside the panel",
    );
    assert.ok(
      await evaluate('![...document.querySelectorAll("[data-picker-row]")].some((row) => row.textContent.includes("victorlucss"))'),
      "The author can't review their own PR",
    );
    await evaluate('[...document.querySelectorAll("[data-picker-row]")].find((row) => row.textContent.includes("octocat")).click()');
    await waitFor('window.calls.some((call) => call.name === "requestReviewers")');
    assert.deepEqual((await calls("requestReviewers"))[0], { name: "requestReviewers", cwd: "/fixture", number: 673, add: ["octocat"], remove: [] });
    await click("[data-pr-reviewers-add]");
    await waitFor('!document.querySelector("[data-picker-panel]")');

    // Merging asks once more, then merges with the remembered method.
    await click("[data-pr-merge]");
    assert.match(await text("[data-pr-merge]"), /Confirm merge/);
    assert.equal((await calls("merge")).length, 0, "The first click only asks to confirm");
    await click("[data-pr-merge]");
    await waitFor('window.calls.some((call) => call.name === "merge")');
    assert.equal((await calls("merge"))[0].method, "squash");

    // The arrow keys move between Summary and Files, and only the selected tab is in the Tab order.
    await evaluate('document.querySelector("[data-pr-tab=summary]").focus()');
    await evaluate('document.querySelector("[data-pr-tab=summary]").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))');
    assert.equal(await evaluate('document.activeElement.getAttribute("data-pr-tab")'), "files");
    assert.equal(await evaluate('document.querySelector("[data-pr-tab=summary]").tabIndex'), -1);
    await click("[data-pr-tab=summary]");

    // The Files tab lists the PR's files with their open threads.
    await click("[data-pr-tab=files]");
    await waitFor('!!document.querySelector("[data-pr-files]")');
    assert.equal(await text("[data-pr-file-threads]"), "1", "The file with an open thread is marked");
    await shot("files");

    // A file opens the PR's diff with GitHub's thread under its line.
    await click('[data-pr-file="src/save.ts"]');
    await waitFor('!!document.querySelector("[data-diff-view] [data-pr-thread=T1]")');
    const diffCall = (await calls("diffFiles"))[0];
    assert.deepEqual([diffCall.base, diffCall.head], ["b".repeat(40), "a".repeat(40)], "The diff reads the PR's commits");
    assert.equal(await text("[data-pr-thread=T1] [data-pr-thread-label]"), "Open");
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
    assert.equal(await text("[data-pr-review-summary]"), "1 pending");
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

    // Uncommitted files show as "Not in the PR yet", which switches the panel to them.
    await click("[data-pr-tab=summary]");
    assert.equal(await text("[data-pr-local]"), "2 files not in the PR yet");
    await click("[data-pr-local]");
    await waitFor('document.querySelector("[data-changes-panel]")?.getAttribute("aria-label") === "Changes"');
    assert.equal(await selected("changes"), "true");

    // Another Worktree's PR starts with fresh pickers: the label picker reads that Worktree's labels.
    await click('[data-changes-tab="pr:673"]');
    await waitFor('!!document.querySelector("[data-pr-identity]")');
    await evaluate('window.setSource("/other")');
    await click("[data-pr-labels-add]");
    await waitFor('window.calls.some((call) => call.name === "labels" && call.cwd === "/other")');
    await click("[data-pr-labels-add]");

    // A conflicting PR says so under its branch, and offers no merge when ready.
    await evaluate('window.prDetail = { ...window.prDetailBase, mergeStateStatus: "DIRTY", reviewDecision: "REVIEW_REQUIRED", viewerCanMergeAsAdmin: true }');
    await click("[data-diff-refresh]");
    await waitFor('!!document.querySelector("[data-pr-status]")');
    assert.equal(await evaluate('document.querySelector("[data-pr-status]").getAttribute("data-pr-status")'), "Conflicts");
    assert.match(await text("[data-pr-status]"), /Conflicts · This branch conflicts with main/);
    assert.equal(await evaluate('document.querySelector("[data-pr-auto], [data-pr-merge]")'), null, "No merge button for a conflicting PR");
    await click("[data-pr-more]");
    await waitFor('!!document.querySelector("[data-picker-panel]")');
    assert.ok(!(await evaluate('document.querySelector("[data-picker-panel]").textContent.includes("Merge anyway")')), "Not even as an admin");
    await click("[data-pr-more]");

    // At 280px the PR's number and the checks status stay whole; the repository name goes first.
    await evaluate('window.prDetail = { ...window.prDetail, mergeStateStatus: "BLOCKED" }');
    await click("[data-diff-refresh]");
    await waitFor('!!document.querySelector("[data-pr-auto]")');
    await evaluate('document.querySelector("[data-changes-panel]").style.width = "280px"');
    await delay(50);
    const whole = (selector) =>
      evaluate(
        `(() => { const node = document.querySelector(${JSON.stringify(selector)}); return node.scrollWidth <= node.clientWidth && node.getBoundingClientRect().right <= document.querySelector("[data-changes-panel]").getBoundingClientRect().right; })()`,
      );
    assert.ok(await whole("[data-pr-checks-status]"), "The checks status isn't cut");
    assert.ok(await whole("[data-pr-auto]"), "The merge button fits");
    assert.equal(await evaluate('document.querySelector("[data-pr-auto]").innerText.trim()'), "Auto-merge", "The merge button says it shorter");
    assert.ok(await evaluate('document.querySelector("[data-pr-link]").getBoundingClientRect().width >= 40'), "The PR's number shows");
    await shot("narrow");

    console.log(
      "PASS: PR panel tabs, header, checks status, reviewers and labels pickers, label contrast, picker placement, tab keys, comment cards, merge confirm, Files tab, PR diff with thread, add to review, submit review, Fix in Chat, local changes row, fresh pickers per Worktree, conflicts line, narrow header",
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
