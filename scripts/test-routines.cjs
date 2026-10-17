// The Routines page and the New routine form, on real components with a stubbed window.milagre: groups and chip counts,
// a paused trigger's reason, the Team Select opening inside the form's modal dialog (D7), the {{ placeholder list, and
// the createRoutine input a Linear trigger saves. Screenshots go to MILAGRE_SCREENSHOT_DIR when it is set.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { RoutinesPage } from '/src/components/routines/RoutinesPage';
import { HeartbeatCard } from '/src/components/routines/HeartbeatCard';
import { NextCheck } from '/src/components/routines/NextCheck';
import '/src/styles.css';
const now = Date.now();
const H = 3600000;
const base = { enabled: true, createdBy: { kind: 'user' }, runCount: 0, createdAt: now - 48 * H, updatedAt: now, runs: [] };
const routines = [
  { ...base, id: 'h1', name: 'Babysit PR #473 until it merges', prompt: 'Check', trigger: { kind: 'schedule', cron: '*/15 * * * *', timezone: 'UTC' },
    target: { kind: 'chat', chatId: '/code/milagre-ade#12' }, createdBy: { kind: 'agent', chatId: '/code/milagre-ade#12' }, expiresAt: now + 50 * H, nextRunAt: now + 9 * 60000 },
  { ...base, id: 'h2', name: 'Watch CI on #461', prompt: 'Check', trigger: { kind: 'schedule', cron: '*/10 * * * *', timezone: 'UTC' },
    target: { kind: 'chat', chatId: '/code/milagre-ade#14' }, maxRuns: 20, runCount: 17, nextRunAt: now + 6 * 60000 },
  { ...base, id: 't1', name: 'Take issues labelled agent', prompt: 'Work on {{issue.key}}',
    trigger: { kind: 'linear', workspace: 'milagre', event: 'label-added', team: 'MIL', label: 'agent' },
    target: { kind: 'new-chat', projectPath: '/code/milagre-ade', workspace: 'worktree' }, model: 'claude-opus-5-5', provider: 'claude', permissionMode: 'full',
    runs: [{ id: 'r1', routineId: 't1', startedAt: now - 2 * H, status: 'acted', chatId: '/code/milagre-ade#20',
      event: { kind: 'linear', key: 'k', change: 'label-added', issue: { id: 'i', key: 'MIL-142', title: 't', description: '', url: 'u', labels: [], state: 'Todo', team: 'MIL', workspace: 'milagre' } } }] },
  { ...base, id: 't2', name: 'Triage new Sentry crashes', prompt: 'Triage {{body}}', trigger: { kind: 'webhook', hookId: 'a'.repeat(64), signed: true },
    target: { kind: 'new-chat', projectPath: '/code/milagre-ade', workspace: 'project' } },
  { ...base, id: 't3', name: 'Morning Linear triage', prompt: 'Triage', enabled: false, pausedReason: '3 failed runs in a row: Linear sign-in needed',
    trigger: { kind: 'schedule', cron: '30 8 * * 1-5', timezone: 'America/Sao_Paulo' }, target: { kind: 'new-chat', projectPath: '/code/milagre-ade', workspace: 'worktree' } },
];
window.created = null;
window.milagre = {
  readRoutinesEnabled: async () => ({ enabled: true }),
  listRoutines: async () => ({ routines }),
  onRoutinesChanged: () => () => {},
  routineTargets: async () => ({ projects: [{ path: '/code/milagre-ade', name: 'milagre-ade', chats: [
    { chatId: '/code/milagre-ade#12', title: 'Subagent glance', lastAt: now },
    { chatId: '/code/milagre-ade#14', title: 'Notification chimes', lastAt: now },
  ] }] }),
  routineLinearOptions: async (args) => ({
    workspaces: [{ id: 'milagre', name: 'Milagre' }],
    teams: [{ key: 'MIL', name: 'Milagre' }, { key: 'OPS', name: 'Operations' }],
    labels: args && args.team === 'MIL' ? ['agent', 'bug'] : [],
    states: [{ name: 'Todo', type: 'unstarted' }],
  }),
  createRoutine: async (input) => {
    window.created = input;
    return { routine: { ...base, id: 'new', ...input }, ...(input.trigger.kind === 'webhook' ? { hookUrl: 'https://relay.milagre.cloud/hook/k3fTESTsecret9Qx' } : {}) };
  },
  updateRoutine: async (id, patch) => { window.updated = [id, patch]; return { ...routines.find((r) => r.id === id), ...patch }; },
  deleteRoutine: async (id) => { window.deleted = id; return { removed: true }; },
  runRoutineNow: async () => undefined,
};
const models = [{ id: 'claude-opus-5-5', name: 'Opus 5.5', provider: 'claude', description: '' }];
const beat = (id, name) => ({ id: 'step-' + id, kind: 'other', title: 'Set heartbeat', status: 'done', routine: { id, name } });
createRoot(document.getElementById('root')).render(<>
  <aside data-chat-surfaces style={{position:'fixed',left:16,bottom:16,width:380,display:'flex',flexDirection:'column',gap:8}}>
    <HeartbeatCard step={beat('h1', 'Babysit PR #473 until it merges')} />
    <HeartbeatCard step={beat('gone', 'Old heartbeat')} />
    <NextCheck chatKey="/code/milagre-ade#12" />
  </aside>
  <main style={{height:'100vh'}}><RoutinesPage models={models} projectPath="/code/milagre-ade" onOpenChat={(key) => { window.opened = key; }} onOpenExperimental={() => {}} /></main>
</>);
`;
async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(require("node:os").tmpdir(), "milagre-routines-ui-")));
  await app.whenReady();
  const win = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) => win.webContents.executeJavaScript(source);
  const waitFor = async (source) => {
    for (let i = 0; i < 160; i++) {
      if (await evaluate(source)) return;
      await delay(50);
    }
    throw new Error("Timed out: " + source);
  };
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const clickText = (selector, text) =>
    evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => node.textContent.trim() === ${JSON.stringify(text)}).click()`);
  const type = (selector, value) =>
    evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      input.focus();
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
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
    await waitFor(`document.querySelectorAll('[data-routine-row]').length === 5`);
    // Groups and the chips' counts (paused ones count in their group too).
    assert.deepEqual(
      JSON.parse(
        await evaluate(
          `JSON.stringify([...document.querySelectorAll('[data-routine-group]')].map((group) => [group.dataset.routineGroup, group.querySelectorAll('[data-routine-row]').length]))`,
        ),
      ),
      [
        ["heartbeats", 2],
        ["triggers", 3],
      ],
    );
    assert.deepEqual(
      JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('[data-routine-chip]')].map((chip) => chip.textContent.trim()))`)),
      ["All 5", "Heartbeats 2", "Triggers 3", "Paused 1"],
    );
    // The paused trigger says why and shows Paused; a heartbeat names its Chat.
    assert.equal(
      await evaluate(`document.querySelector('[data-routine-row="t3"] [data-routine-problem]').textContent`),
      "3 failed runs in a row: Linear sign-in needed",
    );
    assert.equal(await evaluate(`document.querySelector('[data-routine-row="t3"] [data-routine-status]').textContent`), "Paused");
    await waitFor(
      `document.querySelector('[data-routine-row="h2"] [data-routine-meta]').textContent === 'Every 10 min · in Notification chimes · 3 of 20 Runs left'`,
    );
    assert.equal(await evaluate(`document.querySelector('[data-routine-row="t1"] [data-routine-status]').textContent`), "MIL-142 · 2 h ago");
    assert.match(await evaluate("document.body.textContent"), /Closing the lid on battery pauses them\./);
    // Paused filter keeps only the paused row.
    await click('[data-routine-chip="paused"]');
    await waitFor(`document.querySelectorAll('[data-routine-row]').length === 1 && !!document.querySelector('[data-routine-row="t3"]')`);
    await click('[data-routine-chip="all"]');
    await waitFor(`document.querySelectorAll('[data-routine-row]').length === 5`);
    // The ⋯ menu: Run now only for schedules; a webhook trigger has none.
    await click('[data-routine-row="t2"] [data-routine-more]');
    await waitFor(`!!document.querySelector('[data-routine-menu]')`);
    assert.deepEqual(
      JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('[data-routine-action]')].map((row) => row.dataset.routineAction))`)),
      ["edit", "delete"],
    );
    await click('[data-routine-row="t2"] [data-routine-more]');
    await waitFor(`!document.querySelector('[data-routine-menu]')`);
    await click('[data-routine-row="h1"] [data-routine-more]');
    await waitFor(`!!document.querySelector('[data-routine-action="chat"]')`);
    assert.equal(await evaluate(`document.querySelector('[data-routine-action="chat"]').textContent.trim()`), "Open Chat");
    await click('[data-routine-action="chat"]');
    assert.equal(await evaluate("window.opened"), "/code/milagre-ade#12");
    await shot("routines-page");
    // A Chat's surfaces: the Heartbeat set card (Stop deletes the Routine; a gone one says Stopped) and Next check.
    assert.equal(
      await evaluate(`document.querySelector('[data-heartbeat-card="h1"]').textContent.includes('Heartbeat set: Babysit PR #473 until it merges')`),
      true,
    );
    assert.match(await evaluate(`document.querySelector('[data-heartbeat-card="h1"]').textContent`), /Every 15 min · ends in 2 days/);
    assert.equal(await evaluate(`document.querySelector('[data-heartbeat-card="gone"] [data-heartbeat-stopped]').textContent`), "Stopped");
    assert.match(await evaluate(`document.querySelector('[data-next-check]').textContent`), /^Next check \d\d:\d\d$/);
    await click('[data-heartbeat-card="h1"] [data-heartbeat-stop]');
    await waitFor(`window.deleted === 'h1'`);

    // New routine → Linear: the Team Select's panel opens inside the modal dialog and is the topmost element there.
    await click("[data-routine-new]");
    await waitFor(`!!document.querySelector('dialog[data-routine-form][open]')`);
    await click('[data-routine-trigger="linear"]');
    await waitFor(`!!document.querySelector('dialog[data-routine-form] button[aria-label="Team"]')`);
    await click('dialog[data-routine-form] button[aria-label="Team"]');
    await waitFor(`!!document.querySelector('[role="listbox"][aria-label="Team"]')`);
    assert.equal(
      await evaluate(`(() => {
        const panel = document.querySelector('[role="listbox"][aria-label="Team"]');
        const rect = panel.getBoundingClientRect();
        const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(20, rect.height / 2));
        return panel.closest('dialog') === document.querySelector('dialog[data-routine-form]') && rect.height > 0 && panel.contains(top);
      })()`),
      true,
    );
    await shot("routines-form-team");
    await clickText('[role="listbox"][aria-label="Team"] [data-picker-row]', "MIL · Milagre");
    await waitFor(`!document.querySelector('[role="listbox"][aria-label="Team"]')`);
    // MIL's labels load into the Label Select.
    await waitFor(`!!document.querySelector('dialog[data-routine-form] button[aria-label="Label"]')`);
    await click('dialog[data-routine-form] button[aria-label="Label"]');
    await waitFor(`!!document.querySelector('[role="listbox"][aria-label="Label"]')`);
    await clickText('[role="listbox"][aria-label="Label"] [data-picker-row]', "agent");
    await waitFor(`!document.querySelector('[role="listbox"][aria-label="Label"]')`);
    await type('dialog[data-routine-form] input[aria-label="Name"]', "Take issues labelled agent");

    // {{iss suggests issue.key first; Enter inserts it.
    await type("[data-routine-prompt]", "Work on {{iss");
    await waitFor(`!!document.querySelector('[data-routine-placeholders] [data-placeholder="issue.key"]')`);
    assert.equal(await evaluate(`document.querySelector('[data-routine-placeholders] [aria-selected="true"]').dataset.placeholder`), "issue.key");
    await shot("routines-form-placeholders");
    await evaluate(
      `document.querySelector('[data-routine-prompt]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`,
    );
    await waitFor(`document.querySelector('[data-routine-prompt]').value === 'Work on {{issue.key}}'`);
    await waitFor(`!document.querySelector('[data-routine-placeholders]')`);
    // With the mouse: a lower row is the topmost element at its own point (not clipped by the form's scroll fade).
    await type("[data-routine-prompt]", "Work on {{issue.key}} {{iss");
    await waitFor(`!!document.querySelector('[data-routine-placeholders] [data-placeholder="issue.state"]')`);
    assert.equal(
      await evaluate(`(() => {
        const row = document.querySelector('[data-routine-placeholders] [data-placeholder="issue.state"]');
        row.scrollIntoView({ block: 'nearest' });
        const rect = row.getBoundingClientRect();
        return row.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
      })()`),
      true,
    );
    await click('[data-routine-placeholders] [data-placeholder="issue.state"]');
    await waitFor(`document.querySelector('[data-routine-prompt]').value === 'Work on {{issue.key}} {{issue.state}}'`);

    // Save calls createRoutine with a Linear trigger.
    await click("[data-routine-save]");
    await waitFor(`window.created !== null`);
    assert.deepEqual(JSON.parse(await evaluate("JSON.stringify(window.created)")), {
      name: "Take issues labelled agent",
      prompt: "Work on {{issue.key}} {{issue.state}}",
      trigger: { kind: "linear", workspace: "milagre", event: "label-added", team: "MIL", label: "agent" },
      target: { kind: "new-chat", projectPath: "/code/milagre-ade", workspace: "worktree" },
    });
    await waitFor(`!document.querySelector('dialog[data-routine-form]')`);

    // Escape closes the form and is consumed there, so the page behind (and App's Escape) stays put.
    await click("[data-routine-new]");
    await waitFor(`!!document.querySelector('dialog[data-routine-form][open]')`);
    assert.equal(
      await evaluate(`(() => {
        const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        document.querySelector('dialog[data-routine-form] input[aria-label="Name"]').dispatchEvent(event);
        return event.defaultPrevented;
      })()`),
      true,
    );
    await waitFor(`!document.querySelector('dialog[data-routine-form]') && !!document.querySelector('[data-routines-page]')`);

    // A webhook Routine: the form stays open on its new URL, with Copy, until Done.
    await click("[data-routine-new]");
    await waitFor(`!!document.querySelector('dialog[data-routine-form][open]')`);
    await click('[data-routine-trigger="webhook"]');
    await waitFor(`document.querySelector('[data-routine-hook]').textContent.includes('The URL appears after you create the routine.')`);
    await type('dialog[data-routine-form] input[aria-label="Name"]', "Triage Sentry");
    await type("[data-routine-prompt]", "Triage this crash");
    await click("[data-routine-save]");
    await waitFor(`!!document.querySelector('[data-routine-hook-copy]')`);
    assert.match(
      await evaluate(`document.querySelector('dialog[data-routine-form]').textContent`),
      /Routine created.*relay\.milagre\.cloud\/hook\/k3fTESTsecret9Qx/,
    );
    assert.deepEqual(JSON.parse(await evaluate("JSON.stringify(window.created.trigger)")), { kind: "webhook", signed: false });
    await shot("routines-webhook-created");
    await clickText("dialog[data-routine-form] button", "Done");
    await waitFor(`!document.querySelector('dialog[data-routine-form]')`);
    console.log(
      "PASS: Routines page groups and counts Routines; Heartbeat cards and Next check show; the form's Selects open inside its dialog, {{ suggests placeholders, and Save creates a Linear Routine.",
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    await shot("routines-failure").catch(() => {});
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
        name: "routines-fixture",
        resolveId: (id) => (id === "/__routines.tsx" ? id : null),
        load: (id) => (id === "/__routines.tsx" ? fixture : null),
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (req.url !== "/__routines__") return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await server.transformIndexHtml(req.url, '<html><body><div id="root"></div><script type="module" src="/__routines.tsx"></script></body></html>'),
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
    const child = spawn(require("electron"), [__filename, server.resolvedUrls.local[0] + "__routines__", "-ApplePersistenceIgnoreState", "YES"], {
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
