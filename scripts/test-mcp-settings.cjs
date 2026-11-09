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
window.removedAll = [];
window.removeAttempts = [];
// Stored definitions as mcp:definition answers them (secrets masked).
const definitions = {
  supabase: { name: 'supabase', type: 'sse', url: 'https://mcp.supabase.com/sse', headers: {} },
  argent: { name: 'argent', type: 'stdio', command: 'npx', args: ['@swmansion/argent', 'mcp', '--label', 'My Server'], env: { TOKEN: '••••••' } },
};
// The real bridge announces every write on mcp:changed; toggles name the account.
const announce = (event) => setTimeout(() => window.mcpChanged && window.mcpChanged(event), 10);
window.milagre = {
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
      // After "Add and sign in" saves docs, the next check says it needs a sign-in.
      if (key === 'claude:default' && window.saved && window.saved[0].name === 'docs') servers.push(s('docs', 'url', 'everywhere', 'needs-sign-in', 0, 'https://docs.example/mcp'));
      return { provider, accountId, label: accounts.find(a => a.provider === provider && a.accountId === accountId).label, problem: null, servers };
    },
    definition: async (name) => (window.noDefinition ? null : definitions[name] ?? { name, type: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: '••••••' } }),
    save: async (...args) => { if (window.failSave) throw new Error('Could not save this server.'); window.saved = args; announce({ name: args[0].name }); },
    saveUrl: async (...args) => { window.saved = args; announce({ name: args[0].name }); },
    remove: async (...args) => {
      window.removeAttempts.push(args);
      if (window.failRemove === args[1]) throw new Error('claude mcp remove failed');
      window.removedAll.push(args);
      announce({ name: args[0] });
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
  // React tracks input values itself; set through the native setter, then fire input.
  const type = (selector, value) =>
    evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
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
    await waitFor(`!!window.releaseAccounts`);
    await evaluate("window.releaseAccounts()");
    // linear needs a sign-in: Needs sign-in offers the sign-in, and Your servers still lists it (switches, Edit, Remove).
    await waitFor(`!!document.querySelector('[data-mcp-attention="linear"]')`);
    await waitFor(`!document.body.textContent.includes('Checking')`);
    assert.equal(await evaluate(`!!document.querySelector('[data-mcp-row="linear"]')`), true);
    assert.match(await text(), /Needs sign-in · 1/);
    assert.match(await text(), /Your servers · 4/);
    await click('[data-mcp-row="linear"] button');
    await waitFor(
      `!!document.querySelector('[data-mcp-row="linear"] [data-mcp-edit]') && !!document.querySelector('[data-mcp-row="linear"] [data-mcp-remove]')`,
    );
    await click('[data-mcp-row="linear"] button');
    await shot("mcp-page");
    await evaluate("document.documentElement.classList.add('dark')");
    await shot("mcp-page-dark");
    await evaluate("document.documentElement.classList.remove('dark')");

    // A row opens in place and lists each account with a switch.
    assert.ok(await evaluate(`!!document.querySelector('[data-mcp-row="pencil"]')`));
    await click('[data-mcp-row="pencil"] button');
    await waitFor(`document.querySelector('[data-mcp-row="pencil"]').dataset.open === 'true'`);
    await waitFor(
      `(() => { const el = document.querySelector('[data-mcp-switch="claude:default:pencil"]'); return !!el && el.getBoundingClientRect().height > 0; })()`,
    );
    await shot("mcp-open-row");
    // A toggle re-checks only its account, and the rows stay on screen while it does.
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
    // Refresh keeps the old rows until the new answers replace them.
    assert.equal(
      await evaluate(`(() => { document.querySelector('[aria-label="Refresh"]').click(); return !!document.querySelector('[data-mcp-row="pencil"]'); })()`),
      true,
    );
    await delay(100);
    assert.equal(await evaluate(`!!document.querySelector('[data-mcp-row="pencil"]')`), true);
    await waitFor(`!document.querySelector('[aria-label="Refresh"]').disabled`);
    await evaluate("window.checkDelay = 0");

    // Edit with a masked header: focusing and leaving the value keeps the stored secret.
    await click('[data-mcp-row="pencil"] [data-mcp-edit]');
    await waitFor(`!!document.querySelector('[data-mcp-sheet]')`);
    const value = `document.querySelector('[data-mcp-sheet] input[aria-label="Value"]')`;
    assert.equal(await evaluate(`${value}.value`), "••••••");
    await evaluate(`${value}.focus(); ${value}.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))`);
    await waitFor(`${value}.value === ''`);
    await evaluate(`${value}.blur(); ${value}.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))`);
    await waitFor(`${value}.value === '••••••'`);
    await evaluate("window.signedIn = null");
    await click('[data-mcp-sheet] button[type="submit"]');
    await waitFor(`!!window.saved`);
    assert.equal(await evaluate("window.saved[0].headers.Authorization"), "••••••");
    assert.equal(await evaluate("JSON.stringify(window.saved[2])"), JSON.stringify({ name: "pencil", target: "everywhere" }));
    await waitFor(`!document.querySelector('[data-mcp-sheet]')`);
    await delay(200);
    assert.equal(await evaluate("window.signedIn"), null, "an edit never starts a sign-in");
    await evaluate("window.saved = undefined");
    // A server whose settings can't be read says so instead of doing nothing.
    await evaluate("window.noDefinition = true");
    await click('[data-mcp-row="pencil"] [data-mcp-edit]');
    await waitFor(`document.body.textContent.includes("Couldn’t read this server’s settings. Edit it in its CLI config.")`);
    await evaluate("window.noDefinition = false");

    // An SSE server stays SSE through an edit.
    await openRow("supabase");
    // Off in Codex's own config: the line says so and Milagre's switch can't turn it on.
    assert.ok(await evaluate(`document.querySelector('[data-mcp-row="supabase"]').textContent.includes('Off in Codex’s config')`));
    assert.equal(await evaluate(`document.querySelector('[data-mcp-switch="codex:default:supabase"] [role="checkbox"]').disabled`), true);
    assert.equal(await evaluate(`document.querySelector('[data-mcp-switch="claude:default:supabase"] [role="checkbox"]').disabled`), false);
    await shot("mcp-provider-off");
    await click('[data-mcp-row="supabase"] [data-mcp-edit]');
    await waitFor(`!!document.querySelector('[data-mcp-sheet]')`);
    await click('[data-mcp-sheet] button[type="submit"]');
    await waitFor(`!!window.saved`);
    assert.equal(await evaluate("window.saved[0].type"), "sse");
    await waitFor(`!document.querySelector('[data-mcp-sheet]')`);
    await evaluate("window.saved = undefined");

    // A command server: an argument with a space survives an env-only edit, and the masked env value is replaced.
    await openRow("argent");
    await click('[data-mcp-row="argent"] [data-mcp-edit]');
    await waitFor(`!!document.querySelector('[data-mcp-sheet] textarea[aria-label="Arguments"]')`);
    assert.equal(await evaluate(`document.querySelector('[data-mcp-sheet] input[aria-label="Command"]').value`), "npx");
    await type('[data-mcp-sheet] input[aria-label="Value"]', "new-token");
    await shot("mcp-sheet-command");
    await click('[data-mcp-sheet] button[type="submit"]');
    await waitFor(`!!window.saved`);
    assert.equal(
      await evaluate("JSON.stringify(window.saved[0])"),
      JSON.stringify({
        name: "argent",
        type: "stdio",
        command: "npx",
        args: ["@swmansion/argent", "mcp", "--label", "My Server"],
        env: { TOKEN: "new-token" },
      }),
    );
    await waitFor(`!document.querySelector('[data-mcp-sheet]')`);
    await evaluate("window.saved = undefined");

    // A failed account: the summary counts it and a red alert sits next to it.
    assert.ok(
      await evaluate(
        `(() => { const row = document.querySelector('[data-mcp-row="argent"]'); return row.textContent.includes('2 of 3 connected') || !!row.querySelector('[data-mcp-failed]'); })()`,
      ),
    );
    assert.ok(await evaluate(`!!document.querySelector('[data-mcp-row="argent"] [data-mcp-failed]')`));

    // Sign in: the row waits for the browser, and comes back when the last account finishes.
    await click('[data-mcp-sign-in="linear"]');
    await waitFor(`window.signedIn && window.signedIn[0] === 'linear'`);
    await waitFor(`document.querySelector('[data-mcp-attention="linear"]').textContent.includes('Finish in your browser, then come back.')`);
    assert.ok(await evaluate(`!!document.querySelector('[data-mcp-cancel="linear"]')`));
    await evaluate(`window.mcpChanged({ name: 'linear', provider: 'claude', accountId: 'default', signIn: 'done', last: true })`);
    await waitFor(`!!document.querySelector('[data-mcp-sign-in="linear"]')`);

    // Projects, plugins and claude.ai open in place.
    const url = await evaluate("location.href");
    await click("[data-mcp-other]");
    await waitFor(`document.body.textContent.includes('Plugin · engineering') && document.body.textContent.includes('claude.ai connectors')`);
    assert.equal(await evaluate("location.href"), url);
    await evaluate(`document.querySelector('[data-mcp-other]').scrollIntoView()`);
    await shot("mcp-other");

    // The catalog hides raw configuration, filters by service, and isolates credentials between selections.
    await click("[data-mcp-add]");
    await waitFor(`!!document.querySelector('[data-mcp-catalog]')`);
    await waitFor(`document.activeElement?.getAttribute('aria-label') === 'Search services'`);
    await shot("mcp-catalog");
    await evaluate("document.documentElement.classList.add('dark')");
    await shot("mcp-catalog-dark");
    await evaluate("document.documentElement.classList.remove('dark')");
    await type('[aria-label="Search services"]', "NOtIon");
    await waitFor(`document.querySelectorAll('[data-mcp-service]').length === 1`);
    assert.equal(await evaluate(`document.querySelector('[data-mcp-service]').dataset.mcpService`), "notion");
    await type('[aria-label="Search services"]', "missing-service");
    await waitFor(`document.querySelector('[data-mcp-catalog]').textContent.includes('No matching services')`);
    assert.ok(await evaluate(`!!document.querySelector('[data-mcp-custom]')`));
    await type('[aria-label="Search services"]', "");
    await click('[data-mcp-service="github"]');
    await waitFor(`document.activeElement?.getAttribute('aria-label') === 'Personal access token'`);
    assert.equal(await evaluate(`document.querySelector('[aria-label="Personal access token"]').type`), "password");
    assert.equal(await evaluate(`!!document.querySelector('[data-mcp-sheet] [aria-label="URL"]')`), false);
    await click('[data-mcp-sheet] button[type="submit"]');
    await waitFor(`document.querySelector('[data-mcp-sheet] [role="alert"]')?.textContent.includes('personal access token')`);
    assert.equal(await evaluate("window.saved === undefined"), true);
    await type('[aria-label="Personal access token"]', "test-token");
    await click("[data-mcp-back]");
    await click('[data-mcp-service="github"]');
    await waitFor(`document.querySelector('[aria-label="Personal access token"]').value === ''`);
    await type('[aria-label="Personal access token"]', "Bearer test-token");
    await evaluate("window.failSave = true");
    await click('[data-mcp-sheet] button[type="submit"]');
    await waitFor(`document.querySelector('[data-mcp-sheet] [role="alert"]')?.textContent === 'Could not save this server.'`);
    assert.equal(await evaluate(`document.querySelector('[aria-label="Personal access token"]').value`), "Bearer test-token");
    await evaluate("window.failSave = false");
    await click('[data-mcp-sheet] button[type="submit"]');
    await waitFor(`!document.querySelector('[data-mcp-sheet]')`);
    assert.deepEqual(await evaluate("window.saved.slice(0, 2)"), [
      { name: "github", type: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer test-token" } },
      "everywhere",
    ]);
    await evaluate("window.saved = undefined");
    await click("[data-mcp-add]");
    await click('[data-mcp-service="notion"]');
    await waitFor(`document.querySelector('[data-mcp-sheet] h2').textContent === 'Add Notion'`);
    assert.equal(await evaluate(`!!document.querySelector('[data-mcp-sheet] input[aria-label="Name"]')`), false);
    await shot("mcp-preset");
    await click('[data-mcp-sheet] button[type="submit"]');
    await waitFor(`!document.querySelector('[data-mcp-sheet]')`);
    assert.deepEqual(await evaluate("window.saved.slice(0, 2)"), [
      { name: "notion", type: "http", url: "https://mcp.notion.com/mcp", headers: {} },
      "everywhere",
    ]);
    await evaluate("window.saved = undefined");

    // Add: Everywhere by default; a bad name is refused before any save.
    await click("[data-mcp-add]");
    await waitFor(`!!document.querySelector('[data-mcp-sheet]')`);
    await click("[data-mcp-custom]");
    assert.match(await evaluate(`document.querySelector('[data-mcp-sheet] input[type="radio"]:checked').closest('label').textContent`), /Everywhere/);
    await waitFor(`document.activeElement && document.activeElement.getAttribute('aria-label') === 'Name'`);
    // Switching URL and Command drops the headers typed for the other kind.
    await type('[data-mcp-sheet] input[aria-label="Header"]', "X-Team");
    await click('[data-mcp-sheet] [data-mcp-kind="command"]');
    await waitFor(`document.querySelector('[data-mcp-sheet] input[aria-label="Variable"]').value === ''`);
    await click('[data-mcp-sheet] [data-mcp-kind="url"]');
    await waitFor(`document.querySelector('[data-mcp-sheet] input[aria-label="Header"]').value === ''`);
    await type('[data-mcp-sheet] input[aria-label="Name"]', "a b");
    await type('[data-mcp-sheet] input[aria-label="URL"]', "https://docs.example/mcp");
    await click('[data-mcp-sheet] button[type="submit"]');
    await waitFor(`document.querySelector('[data-mcp-sheet]').textContent.includes('Use letters, numbers, - and _ only.')`);
    assert.equal(await evaluate("window.saved === undefined"), true);
    await type('[data-mcp-sheet] input[aria-label="Name"]', "docs");
    await waitFor(`document.querySelector('[data-mcp-sheet] input[aria-label="Name"]').value === 'docs'`);
    await shot("mcp-sheet");
    await evaluate("window.signedIn = null");
    await click('[data-mcp-sheet] button[type="submit"]');
    await waitFor(`!!window.saved`);
    assert.equal(
      await evaluate("JSON.stringify(window.saved.slice(0, 2))"),
      JSON.stringify([{ name: "docs", type: "http", url: "https://docs.example/mcp", headers: {} }, "everywhere"]),
    );
    assert.equal(await evaluate("window.saved.length === 3 && window.saved[2] === undefined"), true);
    await waitFor(`!document.querySelector('[data-mcp-sheet]')`);
    // "Add and sign in": the new server needs a sign-in, so it starts one.
    await waitFor(`window.signedIn && window.signedIn[0] === 'docs'`);
    // Remove asks first, naming every place, then reaches Everywhere and every provider config that holds the server.
    await openRow("pencil");
    await click('[data-mcp-row="pencil"] [data-mcp-remove]');
    await waitFor(`!!document.querySelector('[data-mcp-row="pencil"] [data-mcp-remove-question]')`);
    assert.ok(
      await evaluate(
        `document.querySelector('[data-mcp-row="pencil"] [data-mcp-remove-question]').textContent.includes('Remove pencil from Everywhere, Claude’s config and Codex’s config?')`,
      ),
    );
    assert.equal(await evaluate("window.removeAttempts.length"), 0);
    await shot("mcp-remove-confirm");
    await click('[data-mcp-row="pencil"] [data-mcp-remove-confirm]');
    await waitFor(`window.removedAll.length === 3`);
    assert.equal(
      await evaluate("JSON.stringify(window.removedAll)"),
      JSON.stringify([
        ["pencil", "everywhere"],
        ["pencil", "claude"],
        ["pencil", "codex"],
      ]),
    );
    // One config failing doesn't stop the rest, and the failure is reported once, by place.
    await evaluate("window.failRemove = 'claude'; window.removeAttempts = []");
    await openRow("argent");
    await click('[data-mcp-row="argent"] [data-mcp-remove]');
    await click('[data-mcp-row="argent"] [data-mcp-remove-confirm]');
    await waitFor(`window.removeAttempts.length === 2`);
    assert.equal(
      await evaluate("JSON.stringify(window.removeAttempts)"),
      JSON.stringify([
        ["argent", "claude"],
        ["argent", "codex"],
      ]),
    );
    await waitFor(`document.body.textContent.includes('Couldn’t remove argent from Claude’s config. claude mcp remove failed')`);
    await shot("mcp-remove-failed");
    console.log("PASS: MCP page groups sign-in, servers and outside sources; rows open in place; add, switch and sign-in call the bridge.");
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
