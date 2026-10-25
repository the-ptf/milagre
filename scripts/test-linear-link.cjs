// Real Electron checks for linking an existing Worktree to a Linear issue from the sidebar row: the row menu's
// "Link issue…" (only when Linear is on and the chat has its own Worktree), "Unlink issue" for a stored
// link, and the hover card's hint when the branch doesn't name the key. MILAGRE_SCREENSHOT_DIR saves images outside the repo.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");

const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles.css';
import { ChatRow } from '/src/components/sidebar/ChatRow';
const issues = [
  { key: 'ENG-1', title: 'Fix login redirect', url: 'https://linear.app/acme/issue/ENG-1', branchName: 'eng-1-fix-login-redirect', state: { name: 'In Progress', type: 'started', color: '#f2c94c' } },
  { key: 'ENG-2', title: 'Dark mode tokens', url: 'https://linear.app/acme/issue/ENG-2', branchName: 'eng-2-dark-mode-tokens', description: 'Share the palette.', state: { name: 'Backlog', type: 'backlog', color: '#8e8e93' } },
];
const linearOn = new URLSearchParams(location.search).get('linear') === 'on';
window.__linkQueries = [];
window.__link = [];
window.__unlink = [];
window.milagre = {
  listEditors: async () => [],
  listLinearIssues: async (query) => {
    window.__linkQueries.push(query ?? null);
    const search = (query ?? '').trim().toLowerCase();
    return { issues: issues.filter((issue) => !search || (issue.key + ' ' + issue.title).toLowerCase().includes(search)) };
  },
};
// The app only sets linearKey / linkable while Linear is on and connected; the fixture follows the same rule.
const on = (value) => (linearOn ? value : undefined);
const actions = {
  onLinkIssue: (id, key) => window.__link.push({ id, key }),
  onUnlinkIssue: (id) => window.__unlink.push({ id }),
};
const rows = [
  // Own Worktree, no link yet: the menu offers Link.
  { id: 'chat-link', label: 'Login redirect', mark: 'idle', details: { branch: 'milagre/login-fix-ab12', path: '/worktrees/login', linkable: on(true) } },
  // Own Worktree stored as ENG-1 on a milagre/ branch: the menu offers Unlink, and the card explains the PR line.
  { id: 'chat-stored', label: 'Stored link', mark: 'idle', details: { branch: 'milagre/login-fix-cd34', path: '/worktrees/stored', linkable: on(true), linearKey: on('ENG-1'), linearIssue: on(issues[0]) } },
  // Stored ENG-1 on a branch that names it: no hint in the card.
  { id: 'chat-named', label: 'Named branch', mark: 'idle', details: { branch: 'eng-1-fix-login-redirect', path: '/worktrees/named', linkable: on(true), linearKey: on('ENG-1'), linearIssue: on(issues[0]) } },
  // A Worktree another chat shares, even with a stored key: neither item, as on the phone.
  { id: 'chat-shared', label: 'Shared worktree', mark: 'idle', details: { branch: 'milagre/login-fix-ef56', path: '/worktrees/shared', linearKey: on('ENG-1'), linearIssue: on(issues[0]) } },
  // An own Worktree near the bottom of the window: its picker must stay inside the window.
  { id: 'chat-low', label: 'Low chat', mark: 'idle', details: { branch: 'milagre/login-fix-gh78', path: '/worktrees/low', linkable: on(true) } },
  // The main checkout: neither item.
  { id: 'chat-main', label: 'Main checkout', mark: 'idle', details: { branch: 'main', path: '/fixture' } },
];
function Fixture() {
  return (
    <div style={{ padding: 40, width: 760, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ width: 280 }}>
        {rows.map((row) => (
          <div key={row.id} data-row={row.id}>
            {row.id === 'chat-low' && <div style={{ height: Math.max(0, window.innerHeight - 420) }} />}
            <ChatRow item={row} active={false} collapsed={false} onPick={() => {}} actions={actions} />
          </div>
        ))}
      </div>
    </div>
  );
}
createRoot(document.getElementById('root')).render(<Fixture />);
`;

async function checks(url) {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "milagre-linear-link-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  async function waitFor(source) {
    for (let n = 0; n < 200; n++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error("Timed out: " + source);
  }
  const rowEl = (id) => `document.querySelector('[data-row="${id}"]')`;
  // Opens a row's ⋮ menu and returns the labels of its items.
  async function openMenu(id) {
    await evaluate(`${rowEl(id)}.querySelector('button[aria-haspopup="menu"]').click()`);
    await waitFor(`!!document.querySelector('[data-chat-menu]')`);
    return evaluate(`[...document.querySelectorAll('[data-chat-menu] [data-menu-row]')].map((el) => el.textContent.trim())`);
  }
  async function closeMenu() {
    await evaluate(`document.querySelector('[data-chat-menu]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitFor(`!document.querySelector('[data-chat-menu]')`);
  }
  // A pointer entering the row opens its hover card after the delay.
  async function hover(id) {
    await evaluate(`${rowEl(id)}.firstElementChild.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))`);
    await delay(700);
  }
  async function screenshot(name) {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    await delay(250);
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), (await window.webContents.capturePage()).toPNG());
  }
  const errors = [];
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") errors.push(details.message);
  });
  try {
    // Linear off: no link or unlink item on any row.
    await window.loadURL(url + "?linear=off");
    await waitFor(`!!document.querySelector('[data-row="chat-link"]')`);
    const offLabels = await openMenu("chat-link");
    assert.equal(offLabels.includes("Link issue…"), false, "no link item while Linear is off");
    await closeMenu();

    await window.loadURL(url + "?linear=on");
    await waitFor(`!!document.querySelector('[data-row="chat-link"]')`);

    // The main checkout offers neither item.
    const mainLabels = await openMenu("chat-main");
    assert.equal(
      mainLabels.some((label) => /Linear issue/.test(label)),
      false,
      "the main checkout has no Linear item",
    );
    await closeMenu();

    // An own Worktree with no link offers Link, not Unlink.
    const linkLabels = await openMenu("chat-link");
    assert.equal(linkLabels.includes("Link issue…"), true, "Link is offered for an own Worktree");
    assert.equal(linkLabels.includes("Unlink issue"), false);
    await screenshot("link-menu");

    // Picking an issue in the picker hands its key to the link action for this chat.
    await evaluate(`[...document.querySelectorAll('[data-chat-menu] [data-menu-row]')].find((el) => el.textContent.trim() === 'Link issue…').click()`);
    await waitFor(`document.querySelectorAll('[data-linear-link-picker] [data-linear-issue-row]').length === 2`);
    assert.equal(await evaluate(`!!document.querySelector('[data-linear-link-picker] [data-linear-logo]')`), true, "picker rows show Linear's mark");
    await screenshot("link-picker");
    await evaluate(`[...document.querySelectorAll('[data-linear-link-picker] [data-linear-issue-row] button')][1].click()`);
    await waitFor(`!document.querySelector('[data-linear-link-picker]')`);
    assert.deepEqual(await evaluate(`window.__link`), [{ id: "chat-link", key: "ENG-2" }], "picking calls the link action with the chat and key");

    // A stored link offers Unlink instead of Link, and Unlink calls the unlink action.
    const storedLabels = await openMenu("chat-stored");
    assert.equal(storedLabels.includes("Unlink issue"), true, "Unlink is offered for a stored link");
    assert.equal(storedLabels.includes("Link issue…"), false, "Link is replaced by Unlink");
    await evaluate(`[...document.querySelectorAll('[data-chat-menu] [data-menu-row]')].find((el) => el.textContent.trim() === 'Unlink issue').click()`);
    await waitFor(`window.__unlink.length === 1`);
    assert.deepEqual(await evaluate(`window.__unlink`), [{ id: "chat-stored" }]);

    // A shared Worktree offers neither Link nor Unlink, even with a stored key.
    const sharedLabels = await openMenu("chat-shared");
    assert.equal(
      sharedLabels.some((label) => /Linear issue/.test(label)),
      false,
      "a shared Worktree has no Linear item",
    );
    await closeMenu();

    // The picker opened from a row near the bottom of the window stays inside it.
    await evaluate(`${rowEl("chat-low")}.scrollIntoView({ block: 'end' })`);
    await openMenu("chat-low");
    await evaluate(`[...document.querySelectorAll('[data-chat-menu] [data-menu-row]')].find((el) => el.textContent.trim() === 'Link issue…').click()`);
    await waitFor(`document.querySelectorAll('[data-linear-link-picker] [data-linear-issue-row]').length === 2`);
    // The picker moves once its height is known, a frame after the rows appear, so wait for it to settle.
    await waitFor(
      `(() => { const box = document.querySelector('[data-linear-link-picker]').getBoundingClientRect(); return box.top >= 0 && box.bottom <= window.innerHeight; })()`,
    );
    const box = JSON.parse(await evaluate(`JSON.stringify(document.querySelector('[data-linear-link-picker]').getBoundingClientRect())`));
    const viewport = await evaluate(`window.innerHeight`);
    assert.ok(box.top >= 0 && box.bottom <= viewport, `the picker stays inside the window (${JSON.stringify(box)} in ${viewport})`);
    await evaluate(`document.querySelector('[data-linear-link-picker] [data-linear-issue-row] button')?.click()`);
    await waitFor(`!document.querySelector('[data-linear-link-picker]')`);

    // The hover card hints when the branch doesn't name the stored key, and not when it does.
    await hover("chat-stored");
    assert.equal(
      await evaluate(`document.querySelector('[data-chat-card-link-hint]')?.textContent`),
      'Add "Fixes ENG-1" to the PR description so Linear tracks it.',
      "the hint shows under the issue line",
    );
    await screenshot("link-hover-hint");
    await evaluate(`${rowEl("chat-stored")}.firstElementChild.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' }))`);
    await delay(600);
    await hover("chat-named");
    assert.equal(await evaluate(`!!document.querySelector('[data-chat-card-link-hint]')`), false, "no hint when the branch names the key");

    assert.deepEqual(errors, []);
    console.log("PASS: row menu links, unlinks and hints per the Linear and Worktree state; picking an issue calls the link action");
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(errors);
    await screenshot("failure");
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const { spawn } = require("node:child_process");
  const server = await createServer({
    configFile: path.resolve(__dirname, "../apps/desktop/vite.config.ts"),
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-linear-link"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "linear-link-fixture",
        enforce: "pre",
        resolveId(id) {
          if (id === "/__linear_link_fixture.tsx") return id;
        },
        load(id) {
          if (id === "/__linear_link_fixture.tsx") return fixture;
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (!request.url.startsWith("/__linear-link")) return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__linear_link_fixture.tsx"></script></body></html>',
              ),
            );
          });
        },
      },
    ],
  });
  try {
    await server.listen();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [__filename, server.resolvedUrls.local[0] + "__linear-link"], { env, stdio: "inherit" });
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await server.close();
  }
}
(process.versions.electron ? checks(process.argv[2]) : main()).catch((error) => {
  console.error(error);
  if (process.versions.electron) require("electron").app.exit(1);
  else process.exitCode = 1;
});
