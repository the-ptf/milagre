const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsPanel, SettingsNav } from '/src/components/Settings';
import '/src/styles.css';
const accounts = [
  { provider: 'claude', accountId: 'default', label: 'personal@example.test' },
  { provider: 'claude', accountId: 'work', label: 'Work' },
  { provider: 'codex', accountId: 'default', label: 'personal' },
  { provider: 'antigravity', accountId: 'default', label: 'Antigravity' },
];
const s = (name, transport, scope, state, tools, detail, error = null, extra = {}) => ({ name, transport, scope, state, tools, error, detail, ...extra });
const answers = {
  'claude:default': [
    s('pencil', 'command', 'user', 'connected', 14, 'pencil mcp --stdio'),
    s('linear', 'url', 'user', 'needs-sign-in', 0, 'https://mcp.linear.app/mcp'),
    s('argent', 'command', 'user', 'connected', 61, 'npx @swmansion/argent mcp'),
    s('supabase', 'url', 'user', 'connected', 29, 'https://mcp.supabase.com/mcp'),
    s('context7', 'url', 'project', 'connected', 2, 'https://mcp.context7.com/mcp'),
    s('plugin:engineering:notion', 'url', 'plugin', 'needs-sign-in', 0, 'https://mcp.notion.com/mcp'),
    s('plugin:engineering:datadog', 'url', 'plugin', 'disabled', 0, 'https://mcp.datadoghq.com'),
    s('claude.ai Gmail', 'connector', 'claude.ai', 'connected', 23, null),
    s('claude.ai Google Drive', 'connector', 'claude.ai', 'connected', 11, null),
  ],
  'claude:work': [
    s('pencil', 'command', 'user', 'connected', 14, 'pencil mcp --stdio'),
    s('argent', 'command', 'user', 'connected', 61, 'npx @swmansion/argent mcp'),
  ],
  'codex:default': [
    s('pencil', 'command', 'user', 'disabled', 0, 'pencil mcp --stdio'),
    s('linear', 'url', 'user', 'needs-sign-in', 0, 'https://mcp.linear.app/mcp'),
    s('argent', 'command', 'user', 'failed', 0, 'npx @swmansion/argent mcp', 'spawn argent ENOENT'),
    s('supabase', 'url', 'user', 'disabled', 0, 'https://mcp.supabase.com/mcp', null, { disabledBy: 'provider' }),
  ],
  'antigravity:default': [s('pencil', 'command', 'everywhere', 'connected', 14, 'pencil mcp --stdio')],
};
window.checks = 0;
window.accountsCalls = 0;
// The real bridge announces every write on mcp:changed; toggles name the account.
const announce = (event) => setTimeout(() => window.mcpChanged && window.mcpChanged(event), 10);
window.milagre = {
  connectors: { list: async () => [], movable: async () => [], onChanged: () => () => {} },
  listAccounts: async () => ({ providers: [] }),
  listRecentProjects: async () => [],
  onAccountsChanged: () => () => {},
  mcp: {
    accounts: async () => {
      window.accountsCalls++;
      if (!window.accountsOpened) await new Promise((resolve) => { window.releaseAccounts = () => { window.accountsOpened = true; resolve(); }; });
      return accounts;
    },
    check: async (provider, accountId) => {
      window.checks++;
      if (window.checkDelay) await new Promise((resolve) => setTimeout(resolve, window.checkDelay));
      const key = provider + ':' + accountId;
      const servers = [...answers[key]];
      return { provider, accountId, label: accounts.find(a => a.provider === provider && a.accountId === accountId).label, problem: null, servers };
    },
    toggle: async (...args) => { window.toggled = args; announce({ name: args[2], provider: args[0], accountId: args[1] }); },
    signIn: async (...args) => { window.signedIn = args; return { started: true }; },
    cancelSignIn: async (name) => { window.cancelled = name; },
    onChanged: (callback) => { window.mcpChanged = callback; return () => {}; },
  },
};
createRoot(document.getElementById('root')).render(<div style={{display:'flex',height:'100vh',gap:16}}><SettingsNav section="mcp" onSelect={()=>{}} onBack={()=>{}} /><main style={{flex:1}}><SettingsPanel section="mcp" models={[]} /></main></div>);
`;
async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-mcp-ui-")));
  await app.whenReady();
  const win = new BrowserWindow({ width: 1120, height: 1400, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) => win.webContents.executeJavaScript(source);
  const waitFor = async (source) => {
    for (let i = 0; i < 160; i++) {
      if (await evaluate(source)) return;
      await delay(50);
    }
    throw new Error("Timed out: " + source);
  };
  const text = () => evaluate("document.body.textContent");
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const openRow = async (name) => {
    if (!(await evaluate(`document.querySelector('[data-mcp-row="${name}"]').dataset.open === 'true'`))) await click(`[data-mcp-row="${name}"] button`);
    await waitFor(`document.querySelector('[data-mcp-row="${name}"]').dataset.open === 'true'`);
  };
  const shot = async (name) => {
    const dir = process.env.MILAGRE_SCREENSHOT_DIR;
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      await delay(250);
      fs.writeFileSync(path.join(dir, name + ".png"), (await win.webContents.capturePage()).toPNG());
    }
  };
  try {
    await win.loadURL(process.argv[2]);
    await waitFor(`!!document.querySelector('[data-connectors-view="mcp"]')`);
    await click('[data-connectors-view="mcp"]');
    await waitFor(`!!window.releaseAccounts`);
    await evaluate("window.releaseAccounts()");
    await waitFor(`!!document.querySelector('[data-mcp-attention="linear"]')`);
    await waitFor(`!document.body.textContent.includes('Checking')`);
    assert.equal(await evaluate(`!!document.querySelector('[data-mcp-row="linear"]')`), true);
    assert.match(await text(), /Needs sign-in · 1/);
    assert.match(await text(), /Your servers · 4/);
    await click('[data-mcp-row="linear"] button');
    await waitFor(`document.querySelector('[data-mcp-row="linear"]').dataset.open === 'true'`);
    assert.equal(await evaluate(`!!document.querySelector('[data-mcp-edit], [data-mcp-remove], [data-mcp-add]')`), false);
    await click('[data-mcp-row="linear"] button');
    await shot("mcp-page");
    await evaluate("document.documentElement.classList.add('dark')");
    await shot("mcp-page-dark");
    await evaluate("document.documentElement.classList.remove('dark')");

    assert.ok(await evaluate(`!!document.querySelector('[data-mcp-row="pencil"]')`));
    await click('[data-mcp-row="pencil"] button');
    await waitFor(`document.querySelector('[data-mcp-row="pencil"]').dataset.open === 'true'`);
    await waitFor(
      `(() => { const el = document.querySelector('[data-mcp-switch="claude:default:pencil"]'); return !!el && el.getBoundingClientRect().height > 0; })()`,
    );
    await shot("mcp-open-row");
    const accountsBefore = await evaluate("window.accountsCalls");
    await evaluate("window.checkDelay = 300");
    assert.equal(
      await evaluate(
        `(() => { document.querySelector('[data-mcp-switch="claude:default:pencil"] [role="checkbox"]').click(); return !!document.querySelector('[data-mcp-row="pencil"]'); })()`,
      ),
      true,
    );
    await waitFor(`JSON.stringify(window.toggled) === JSON.stringify(['claude','default','pencil',false])`);
    for (let i = 0; i < 20; i++) {
      assert.equal(await evaluate(`!!document.querySelector('[data-mcp-row="pencil"]')`), true, "pencil row vanished while re-checking");
      await delay(25);
    }
    await waitFor(`!document.body.textContent.includes('Checking')`);
    assert.equal(await evaluate("window.accountsCalls"), accountsBefore);
    assert.equal(
      await evaluate(`(() => { document.querySelector('[aria-label="Refresh"]').click(); return !!document.querySelector('[data-mcp-row="pencil"]'); })()`),
      true,
    );
    await delay(100);
    assert.equal(await evaluate(`!!document.querySelector('[data-mcp-row="pencil"]')`), true);
    await waitFor(`!document.querySelector('[aria-label="Refresh"]').disabled`);
    await evaluate("window.checkDelay = 0");

    await openRow("supabase");
    // Off in Codex's own config: the line says so and Milagre's switch can't turn it on.
    assert.ok(await evaluate(`document.querySelector('[data-mcp-row="supabase"]').textContent.includes('Off in Codex’s config')`));
    assert.equal(await evaluate(`document.querySelector('[data-mcp-switch="codex:default:supabase"] [role="checkbox"]').disabled`), true);
    assert.equal(await evaluate(`document.querySelector('[data-mcp-switch="claude:default:supabase"] [role="checkbox"]').disabled`), false);
    await shot("mcp-provider-off");
    assert.ok(
      await evaluate(
        `(() => { const row = document.querySelector('[data-mcp-row="argent"]'); return row.textContent.includes('2 of 3 connected') || !!row.querySelector('[data-mcp-failed]'); })()`,
      ),
    );
    assert.ok(await evaluate(`!!document.querySelector('[data-mcp-row="argent"] [data-mcp-failed]')`));

    await click('[data-mcp-sign-in="linear"]');
    await waitFor(`window.signedIn && window.signedIn[0] === 'linear'`);
    await waitFor(`document.querySelector('[data-mcp-attention="linear"]').textContent.includes('Finish in your browser, then come back.')`);
    assert.ok(await evaluate(`!!document.querySelector('[data-mcp-cancel="linear"]')`));
    await evaluate(`window.mcpChanged({ name: 'linear', provider: 'claude', accountId: 'default', signIn: 'done', last: true })`);
    await waitFor(`!!document.querySelector('[data-mcp-sign-in="linear"]')`);

    const url = await evaluate("location.href");
    await click("[data-mcp-other]");
    await waitFor(`document.body.textContent.includes('Plugin · engineering') && document.body.textContent.includes('claude.ai connectors')`);
    assert.equal(await evaluate("location.href"), url);
    await evaluate(`document.querySelector('[data-mcp-other]').scrollIntoView()`);
    await shot("mcp-other");

    console.log("PASS: MCP page groups sign-in, servers and outside sources; rows open in place; switch and sign-in call the bridge.");
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
    configFile: path.resolve(__dirname, "../apps/desktop/vite.config.ts"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "mcp-fixture",
        resolveId: (id) => (id === "/__mcp.tsx" ? id : null),
        load: (id) => (id === "/__mcp.tsx" ? fixture : null),
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (req, res, next) => {
            if (req.url !== "/__mcp__") return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await server.transformIndexHtml(req.url, '<html><body><div id="root"></div><script type="module" src="/__mcp.tsx"></script></body></html>'),
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
    const child = spawn(require("electron"), [__filename, server.resolvedUrls.local[0] + "__mcp__", "-ApplePersistenceIgnoreState", "YES"], {
      env,
      stdio: "inherit",
    });
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
