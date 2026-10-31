// Browser integration check using the app's existing Electron/Vite dependencies.
const assert = require("node:assert/strict");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatRow } from "/src/components/sidebar/ChatRow";
import { useWorktreePullRequests } from "/src/components/useWorktreePullRequests";
import "/src/styles.css";
const listeners = new Set();
const changes = new Set();
window.pr = { number: 10213, title: "Show pull requests in the chat sidebar", url: "https://github.com/example/project/pull/10213", state: "OPEN" };
window.picks = 0;
window.reads = [];
window.milagre = {
  readPullRequestSnapshot: async projectPath => {
    window.reads.push(projectPath);
    return { worktrees: { "/fixture/worktree": window.pr }, chats: {}, pending: false };
  },
  onPullRequestsChanged: listener => { changes.add(listener); return () => changes.delete(listener); },
  onAgentEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); },
};
// The host's PR poll found a change in the Project's PRs.
window.refreshPR = () => changes.forEach(listener => listener({ projectPath: "/fixture" }));
const state = {
  sessions: { 1: { id: 1, worktree_id: 1 }, 2: { id: 2, worktree_id: 1 } },
  worktrees: { 1: { id: 1, path: "/fixture/worktree" } },
  messages: [{ session_id: 1 }, { session_id: 2 }],
};
function Fixture() {
  const [collapsed, setCollapsed] = useState(false);
  window.setCollapsed = setCollapsed;
  const [multi, setMulti] = useState([]);
  window.setMulti = setMulti;
  const { pullRequests: prs, dismissedBlockers, dismissBlockerAction } = useWorktreePullRequests("/fixture", state);
  window.dismissBlockerAction = (blocker = "conflicts") => dismissBlockerAction(prs["/fixture/worktree"], blocker);
  window.dismissedConflicts = dismissedBlockers;
  return <aside data-sidebar-collapsed={collapsed} style={{ width: collapsed ? 44 : 224, paddingTop: 10 }}>
    <ChatRow item={{ id: "1", label: "Rename fixture", details: { pullRequests: prs["/fixture/worktree"] ? [prs["/fixture/worktree"]] : [] } }}
      active collapsed={collapsed} actions={{}} onPick={() => window.picks++} />
    <ChatRow item={{ id: "2", label: "Chat without a PR" }}
      active={false} collapsed={collapsed} actions={{}} onPick={() => window.picks++} />
    <ChatRow item={{ id: "3", label: "Pick the next 3 issues", details: { pullRequests: multi } }}
      active={false} collapsed={collapsed} actions={{}} onPick={() => window.picks++} />
  </aside>;
}
document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  const { guardNavigation } = require("../apps/desktop/electron/links.cjs");
  // A fresh profile, so a zoom level saved for 127.0.0.1 in the shared Electron profile can't change the layout.
  app.setPath("userData", require("node:fs").mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-sidebar-pr-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 600, height: 400, show: false, webPreferences: { backgroundThrottling: false } });
  const opened = [];
  guardNavigation(window.webContents, { appUrl: process.argv[2], openExternal: (url) => opened.push(url) });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  async function waitFor(source) {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${source}`);
  }
  try {
    await window.loadURL(process.argv[2]);
    await waitFor('!!document.querySelector("[data-chat-pr]")');
    assert.deepEqual(await evaluate("window.reads"), ["/fixture"], "one snapshot answers every Chat of the Project");
    assert.equal(await evaluate('document.querySelector("[data-chat-pr]").textContent'), "#10213");
    assert.equal(await evaluate('document.querySelectorAll("[data-chat-pr]").length'), 1);
    assert.equal(await evaluate('!!document.querySelector("button a")'), false, "Link is not nested in a button");
    assert.equal(await evaluate('document.querySelector("[data-chat-pr]").hasAttribute("title")'), false, "PR link does not use a native tooltip");
    await evaluate(`document.querySelector('[data-chat-pr]').dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))`);
    await waitFor('!!document.querySelector("[data-chat-hover-card]")');
    assert.ok(
      await evaluate('document.querySelector("[data-chat-hover-card]").textContent.includes("Show pull requests in the chat sidebar")'),
      "Hover card includes the actual PR title",
    );
    assert.ok(
      await evaluate('[...document.querySelectorAll("[role=tooltip]")].some(node => node.textContent === "Open pull request #10213")'),
      "Shared tooltip shows PR status and number",
    );
    await evaluate(
      `document.querySelector('[data-chat-pr]').dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: document.body }))`,
    );
    // The card waits a moment for the pointer to reach it before closing.
    await waitFor('!document.querySelector("[data-chat-hover-card]")');
    const openColor = await evaluate('getComputedStyle(document.querySelector("[data-chat-pr] > span")).color');
    const geometry = await evaluate(`(() => {
      const row = document.querySelector('[data-row]').getBoundingClientRect();
      const label = document.querySelector('[data-row] > span:last-child').getBoundingClientRect();
      const link = document.querySelector('[data-chat-pr]').getBoundingClientRect();
      return { rowBottom: row.bottom, labelBottom: label.bottom, linkTop: link.top, linkBottom: link.bottom, labelLeft: label.left, linkLeft: link.left };
    })()`);
    assert.ok(geometry.linkTop >= geometry.labelBottom, "PR link is below the title");
    assert.ok(geometry.linkBottom <= geometry.rowBottom, "PR link fits inside row");
    assert.equal(geometry.linkLeft, geometry.labelLeft, "PR link aligns with title");
    await evaluate('document.querySelector("[data-chat-pr]").click()');
    await delay(150);
    assert.deepEqual(opened, ["https://github.com/example/project/pull/10213"]);
    assert.equal(await evaluate("window.picks"), 0, "Opening a PR does not select the chat");
    await evaluate("window.pr = { ...window.pr, readyToMerge: true }; window.refreshPR()");
    await waitFor('document.querySelector("[data-chat-pr]").textContent.includes("Ready")');
    assert.ok(await evaluate('document.querySelector("[data-chat-pr]").getAttribute("aria-label").includes("ready to merge")'));
    await evaluate(`document.querySelector('[data-chat-pr]').dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))`);
    await waitFor('document.querySelector("[data-chat-hover-card]")?.textContent.includes("Ready to merge")');
    assert.ok(await evaluate('[...document.querySelectorAll("[role=tooltip]")].some(node => node.textContent === "Ready to merge · Pull request #10213")'));
    // Capture the row and card with the pointer over the chat title, clear of the link tooltip.
    await evaluate(
      `document.querySelector('[data-chat-pr]').dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: document.querySelector('[data-row]') }))`,
    );
    await delay(200);
    await window.webContents.capturePage().then((image) => require("node:fs").writeFileSync("/tmp/milagre-sidebar-pr-ready.png", image.toPNG()));
    await evaluate(
      `document.querySelector('[data-chat-pr]').dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: document.body }))`,
    );
    await delay(600);
    assert.equal(await evaluate('document.querySelectorAll("[data-chat-hover-card]").length'), 0, "Leaving the row closes the card after the grace period");
    await evaluate("window.pr = { ...window.pr, readyToMerge: false }; window.refreshPR()");
    await waitFor('!document.querySelector("[data-chat-pr]").textContent.includes("Ready")');
    await evaluate("window.pr = { ...window.pr, hasConflicts: true }; window.refreshPR()");
    await waitFor('document.querySelector("[data-chat-pr]").textContent.includes("Conflicts")');
    assert.equal(await evaluate('document.querySelector("[data-chat-pr] > span").classList.contains("text-red-ink")'), true);
    assert.ok(await evaluate('document.querySelector("[data-chat-pr]").getAttribute("aria-label").includes("conflicts")'));
    await window.webContents.capturePage().then((image) => require("node:fs").writeFileSync("/tmp/milagre-sidebar-pr-conflicts.png", image.toPNG()));
    await evaluate("window.dismissBlockerAction()");
    await waitFor("window.dismissedConflicts.includes(window.pr.url)");
    await evaluate("window.refreshPR()");
    await delay(100);
    assert.equal(await evaluate("window.dismissedConflicts.includes(window.pr.url)"), true, "Refreshing the same conflict keeps the action dismissed");
    assert.ok(
      await evaluate('document.querySelector("[data-chat-pr]").textContent.includes("Conflicts")'),
      "Dismissing the action preserves the sidebar conflict state",
    );
    assert.ok(
      await evaluate('JSON.parse(localStorage.getItem("milagre.dismissed-conflict-actions")).includes(window.pr.url)'),
      "Dismissal persists across reloads",
    );
    await evaluate("window.pr = { ...window.pr, hasConflicts: false }; window.refreshPR()");
    await waitFor('!document.querySelector("[data-chat-pr]").textContent.includes("Conflicts")');
    await waitFor("!window.dismissedConflicts.includes(window.pr.url)");
    await evaluate("window.pr = { ...window.pr, hasConflicts: true }; window.refreshPR()");
    await waitFor('document.querySelector("[data-chat-pr]").textContent.includes("Conflicts")');
    assert.equal(await evaluate("window.dismissedConflicts.includes(window.pr.url)"), false, "A later conflict can offer the action again");
    await evaluate("window.pr = { ...window.pr, hasConflicts: false }; window.refreshPR()");
    await waitFor('!document.querySelector("[data-chat-pr]").textContent.includes("Conflicts")');
    const shot = (name) =>
      process.env.MILAGRE_SCREENSHOT_DIR &&
      window.webContents
        .capturePage()
        .then((image) => require("node:fs").writeFileSync(require("node:path").join(process.env.MILAGRE_SCREENSHOT_DIR, name), image.toPNG()));
    await evaluate("window.pr = { ...window.pr, isBehind: true }; window.refreshPR()");
    await waitFor('document.querySelector("[data-chat-pr]").textContent.includes("Out of date")');
    assert.equal(await evaluate('document.querySelector("[data-chat-pr] > span").classList.contains("text-orange-ink")'), true, "An outdated branch is orange");
    assert.ok(await evaluate('document.querySelector("[data-chat-pr]").getAttribute("aria-label").includes("out of date")'));
    await shot("sidebar-out-of-date.png");
    await evaluate('window.dismissBlockerAction("behind")');
    await waitFor('window.dismissedConflicts.includes("behind:" + window.pr.url)');
    await evaluate("window.pr = { ...window.pr, changesRequested: true }; window.refreshPR()");
    await waitFor('document.querySelector("[data-chat-pr]").textContent.includes("Needs changes")');
    assert.equal(
      await evaluate('document.querySelector("[data-chat-pr] > span").classList.contains("text-red-ink")'),
      true,
      "Requested changes outrank an outdated branch",
    );
    assert.ok(await evaluate('window.dismissedConflicts.includes("behind:" + window.pr.url)'), "A new blocker leaves the other dismissal alone");
    await shot("sidebar-changes-requested.png");
    await evaluate("window.pr = { ...window.pr, isBehind: false, changesRequested: false }; window.refreshPR()");
    await waitFor('!document.querySelector("[data-chat-pr]").textContent.includes("Needs changes")');
    await waitFor('!window.dismissedConflicts.includes("behind:" + window.pr.url)');
    await evaluate('window.pr = { ...window.pr, checks: "running" }; window.refreshPR()');
    await waitFor('document.querySelector("[data-chat-pr]").textContent.includes("CI running")');
    assert.equal(await evaluate('document.querySelector("[data-chat-pr] > span").classList.contains("text-orange-ink")'), true, "Running CI is orange");
    assert.ok(await evaluate('document.querySelector("[data-chat-pr]").getAttribute("aria-label").includes("CI running")'));
    assert.ok(
      await evaluate('[...document.querySelectorAll("[role=tooltip]")].every(node => !node.textContent.includes("CI running"))'),
      "Running CI is not a blocker and offers no action",
    );
    await shot("sidebar-ci-running.png");
    await evaluate('window.pr = { ...window.pr, checks: "failed" }; window.refreshPR()');
    await waitFor('document.querySelector("[data-chat-pr]").textContent.includes("CI failed")');
    assert.equal(await evaluate('document.querySelector("[data-chat-pr] > span").classList.contains("text-red-ink")'), true, "Failed CI is red");
    assert.ok(await evaluate('document.querySelector("[data-chat-pr]").getAttribute("aria-label").includes("ci failed")'));
    await shot("sidebar-ci-failed.png");
    await evaluate('window.dismissBlockerAction("checks-failed")');
    await waitFor('window.dismissedConflicts.includes("checks-failed:" + window.pr.url)');
    await evaluate('window.pr = { ...window.pr, checks: "running" }; window.refreshPR()');
    await waitFor('document.querySelector("[data-chat-pr]").textContent.includes("CI running")');
    await waitFor('!window.dismissedConflicts.includes("checks-failed:" + window.pr.url)');
    await evaluate("delete window.pr.checks; window.pr = { ...window.pr }; window.refreshPR()");
    await waitFor('!document.querySelector("[data-chat-pr]").textContent.includes("CI")');
    assert.equal(await evaluate('getComputedStyle(document.querySelector("[data-chat-pr] > span")).color'), openColor);
    await evaluate('window.pr = { ...window.pr, state: "MERGED" }; window.refreshPR()');
    await waitFor('document.querySelector("[data-chat-pr]").getAttribute("aria-label").includes("merged")');
    const mergedColor = await evaluate('getComputedStyle(document.querySelector("[data-chat-pr] > span")).color');
    assert.notEqual(openColor, mergedColor);
    assert.equal(await evaluate('document.querySelector("[data-chat-pr] > span").classList.contains("text-purple-500")'), true);
    await window.webContents.capturePage().then((image) => require("node:fs").writeFileSync("/tmp/milagre-sidebar-pr.png", image.toPNG()));
    await evaluate("window.setCollapsed(true)");
    await waitFor('!document.querySelector("[data-chat-pr]")');
    assert.equal(await evaluate('document.querySelector("[data-row]").getBoundingClientRect().height'), 32);
    assert.equal(
      await evaluate(`(() => {
      const row = document.querySelector('[data-row]').getBoundingClientRect();
      const initials = document.querySelector('.sidebar-chat-initials').getBoundingClientRect();
      return (initials.left + initials.right) / 2 === (row.left + row.right) / 2;
    })()`),
      true,
      "Collapsed chat initials remain centered",
    );
    await evaluate("window.setCollapsed(false); window.pr = null; window.refreshPR()");
    await waitFor('!document.querySelector("[data-chat-pr]") && document.querySelector("aside").dataset.sidebarCollapsed === "false"');
    assert.equal(await evaluate('document.querySelector("[data-row]").getBoundingClientRect().height'), 32);

    // A chat that made three PRs: the row shows the first and "+2", the card lists all of them.
    const prUrl = (n) => `https://github.com/example/project/pull/${n}`;
    await evaluate(`window.setMulti([
      { number: 84, url: "${prUrl(84)}", title: "Show the to-do pill", state: "MERGED", readyToMerge: false, hasConflicts: false },
      { number: 88, url: "${prUrl(88)}", title: "Find text in the open chat", state: "OPEN", readyToMerge: false, hasConflicts: false },
      { number: 90, url: "${prUrl(90)}", title: "Run a setup command in new worktrees", state: "OPEN", readyToMerge: false, hasConflicts: true },
    ])`);
    await waitFor('document.querySelectorAll("[data-chat-prs] [data-chat-pr]").length === 1');
    assert.deepEqual(
      await evaluate('[...document.querySelectorAll("[data-chat-pr]")].map(link => link.textContent)'),
      ["#90"],
      "Conflicts first; one chip and no status words with several PRs",
    );
    assert.equal(await evaluate('document.querySelector("[data-chat-pr-more]").textContent'), "+2");
    assert.ok(await evaluate('document.querySelector("[data-chat-pr]").getAttribute("aria-label").includes("conflicts")'));
    assert.equal(await evaluate('document.querySelector("[data-chat-pr] > span").classList.contains("text-red-ink")'), true);
    const multiGeometry = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-row]')];
      const row = rows[2].getBoundingClientRect();
      const chips = document.querySelector('[data-chat-prs]').getBoundingClientRect();
      return { rowHeight: row.height, rowRight: row.right, chipsRight: chips.right, chipsBottom: chips.bottom, rowBottom: row.bottom };
    })()`);
    assert.equal(multiGeometry.rowHeight, 46);
    assert.ok(multiGeometry.chipsRight <= multiGeometry.rowRight && multiGeometry.chipsBottom <= multiGeometry.rowBottom, "Chips fit inside the row");
    const thirdRow = 'document.querySelectorAll("[data-row]")[2]';
    await waitFor('!document.querySelector("[data-chat-hover-card]")');
    await evaluate(`${thirdRow}.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))`);
    await waitFor('document.querySelectorAll("[data-chat-card-pr]").length === 3');
    assert.deepEqual(
      await evaluate('[...document.querySelectorAll("[data-chat-card-pr]")].map(link => link.textContent)'),
      ["#84 · Show the to-do pillMerged", "#88 · Find text in the open chat", "#90 · Run a setup command in new worktreesConflicts"],
      "The card lists every PR in the order the chat made them, a merged one saying so",
    );
    // Moving onto the card keeps it open past the grace period.
    await evaluate(
      `${thirdRow}.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: document.querySelector('[data-chat-hover-card]') }))`,
    );
    await evaluate(
      `document.querySelector('[data-chat-hover-card]').dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', relatedTarget: ${thirdRow} }))`,
    );
    await delay(500);
    assert.ok(await evaluate('!!document.querySelector("[data-chat-hover-card]")'), "Card stays open while the pointer is on it");
    await window.webContents.capturePage().then((image) => require("node:fs").writeFileSync("/tmp/milagre-sidebar-multi-pr.png", image.toPNG()));
    const picksBefore = await evaluate("window.picks");
    await evaluate('document.querySelector("[data-chat-card-pr]").click()');
    await delay(150);
    assert.deepEqual(opened.at(-1), prUrl(84), "A PR in the card opens externally");
    assert.equal(await evaluate("window.picks"), picksBefore, "Opening a PR from the card does not select the chat");
    await waitFor('!document.querySelector("[data-chat-hover-card]")');
    // Leaving the card closes it after the grace period.
    await evaluate(`${thirdRow}.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))`);
    await waitFor('!!document.querySelector("[data-chat-hover-card]")');
    await evaluate(`${thirdRow}.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: document.body }))`);
    assert.ok(await evaluate('!!document.querySelector("[data-chat-hover-card]")'), "The card waits for the pointer to cross the gap");
    await waitFor('!document.querySelector("[data-chat-hover-card]")');
    await evaluate("window.setMulti([])");
    await waitFor('!document.querySelector("[data-chat-prs]")');
    console.log("PASS: several PRs: one chip, +N, card lists all and stays open for clicks");
    console.log(
      "PASS: PR lookup, red conflict state and recovery, out-of-date and changes-requested states, merged purple icon, external link, title alignment, collapsed sidebar, and no-PR row",
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
        name: "sidebar-pr-fixture",
        resolveId(id) {
          if (id === "/__sidebar_pr_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__sidebar_pr_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__sidebar_pr__") return next();
            const html = await server.transformIndexHtml(
              request.url,
              '<html><body><div id="root"></div><script type="module" src="/__sidebar_pr_fixture.tsx"></script></body></html>',
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
    const child = spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__sidebar_pr__`], { env, stdio: "inherit" });
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
