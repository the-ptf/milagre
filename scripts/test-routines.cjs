// The Routines page, a Routine's page and its in-place form, on real components with a stubbed window.milagre: groups and
// chip counts, a paused trigger's reason, the Routine page's chips, filter and day-grouped Runs, the New Routine form in
// place (Starts, chips with popovers, the {{ placeholder list, the createRoutine input a Linear trigger saves, landing on
// the new page), Edit in place with Rotate and Delete. Screenshots go to MILAGRE_SCREENSHOT_DIR when it is set.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");
const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RoutinesPage } from '/src/components/routines/RoutinesPage';
import { HeartbeatCard } from '/src/components/routines/HeartbeatCard';
import { NextCheck } from '/src/components/routines/NextCheck';
import { BabysitStoppedDivider } from '/src/components/BabysitStoppedDivider';
import '/src/styles.css';
// Keep the two-hour-old Run on the same calendar day, even when CI runs just after midnight.
const now = new Date(2026, 9, 17, 12, 0, 0).getTime();
Date.now = () => now;
const H = 3600000;
const base = { enabled: true, createdBy: { kind: 'user' }, runCount: 0, createdAt: now - 48 * H, updatedAt: now, runs: [] };
const D = 24 * H;
const t = (offset, extra) => ({ routineId: 'h2', startedAt: now - offset, ...extra });
// Today: an acted Run, then three quiet ones (the latest with a summary); yesterday a failed one; older days fold away.
const h2Runs = [
  t(0.2 * H, { id: 'a1', status: 'acted', chatId: '/code/milagre-ade#31', title: 'Fixed the flaky login test', endedAt: now - 0.2 * H + 38000 }),
  t(1 * H, { id: 'q1', status: 'quiet', summary: 'no TODOs in NOTES.md', chatId: '/code/milagre-ade#32' }),
  t(2 * H, { id: 'q2', status: 'quiet', summary: 'CI green' }),
  t(3 * H, { id: 'q3', status: 'quiet' }),
  t(D, { id: 'f1', status: 'failed', error: 'No worktree\\nat git' }),
  t(2 * D, { id: 'o1', status: 'acted', chatId: '/code/milagre-ade#33' }),
  t(2 * D + H, { id: 'o2', status: 'quiet' }),
  t(2 * D + 2 * H, { id: 'o3', status: 'missed' }),
];
const routines = [
  { ...base, id: 'h1', name: 'Babysit PR #473 until it merges', prompt: 'Check', trigger: { kind: 'schedule', cron: '*/15 * * * *', timezone: 'UTC' },
    target: { kind: 'chat', chatId: '/code/milagre-ade#12' }, createdBy: { kind: 'agent', chatId: '/code/milagre-ade#12' }, expiresAt: now + 50 * H, nextRunAt: now + 9 * 60000 },
  { ...base, id: 'h2', name: 'Watch CI on #461', prompt: 'Check', trigger: { kind: 'schedule', cron: '*/10 * * * *', timezone: 'UTC' },
    target: { kind: 'chat', chatId: '/code/milagre-ade#14' }, maxRuns: 20, runCount: 17, nextRunAt: now + 6 * 60000, runs: h2Runs },
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
  listRoutines: async () => {
    if (window.failList) throw new Error('The Mac did not answer.');
    return { routines: [...routines] };
  },
  onRoutinesChanged: (listener) => { window.routinesChanged = listener; return () => {}; },
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
    window.createCount = (window.createCount || 0) + 1;
    const routine = { ...base, id: 'new' + (routines.length + 1), ...input };
    routines.push(routine);
    return { routine, ...(input.trigger.kind === 'webhook' ? { hookUrl: 'https://relay.milagre.cloud/hook/k3fTESTsecret9Qx' } : {}) };
  },
  updateRoutine: async (id, patch) => {
    const current = routines.find((r) => r.id === id);
    // As the Mac does: a stale hook id in a patch is refused (only a rotate changes it).
    if (patch.trigger && patch.trigger.hookId !== undefined && patch.trigger.hookId !== current.trigger.hookId) throw new Error('Rotate the webhook URL to change it.');
    window.updated = [id, patch];
    return { ...current, ...patch };
  },
  routineHook: async (id) => ({ url: 'https://relay.milagre.cloud/hook/' + (window.rotated ? 'NEWsecret' : 'OLDsecret'), signed: true, signingHeader: 'sentry-hook-signature' }),
  rotateRoutineHook: async (id) => {
    window.rotated = true;
    routines.find((r) => r.id === id).trigger.hookId = 'b'.repeat(64);
    return { url: 'https://relay.milagre.cloud/hook/NEWsecret' };
  },
  deleteRoutine: async (id) => { window.deleted = id; const index = routines.findIndex((r) => r.id === id); if (index >= 0) routines.splice(index, 1); return { removed: true }; },
  runRoutineNow: async (id) => { window.localRan = id; },
};
// A paired computer, listed only once the check says so: its Routines come back already naming it, as main hands them over.
const STUDIO = '6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7';
window.studio = { id: STUDIO, name: 'studio', hostId: 'h', relayHost: 'relay.milagre.cloud', state: 'online', route: 'lan', lastSeen: now, addedAt: now, message: null, lan: true, lanRoutes: [] };
window.milagre.computers = { list: async () => ({ thisMac: 'Here', computers: [] }) };
const computerListeners = new Set();
window.computersChanged = (snapshot) => { for (const listener of computerListeners) listener(snapshot); };
window.milagre.onComputersChanged = (listener) => { computerListeners.add(listener); return () => computerListeners.delete(listener); };
const studioRoutines = [{ ...base, id: STUDIO + '|ab12cd34', name: 'Nightly API smoke', prompt: 'Smoke', trigger: { kind: 'schedule', cron: '0 2 * * *', timezone: 'UTC' },
  target: { kind: 'new-chat', projectPath: STUDIO + '|/code/api', workspace: 'worktree' } }];
window.milagre.on = (id) => ({
  readRoutinesEnabled: async () => ({ enabled: true }),
  listRoutines: async () => ({ routines: [...studioRoutines] }),
  onRoutinesChanged: () => () => {},
  routineTargets: async () => ({ projects: [{ path: STUDIO + '|/code/api', name: 'api', chats: [] }] }),
  runRoutineNow: async (routineId) => { window.remoteRan = [id, routineId]; },
  updateRoutine: async (routineId, patch) => ({ ...studioRoutines[0], ...patch }),
  deleteRoutine: async () => ({ removed: true }),
});
const models = [{ id: 'claude-opus-5-5', name: 'Opus 5.5', provider: 'claude', description: '' }];
const beat = (id, name) => ({ id: 'step-' + id, kind: 'other', title: 'Set Heartbeat', status: 'done', routine: { id, name } });
createRoot(document.getElementById('root')).render(<>
  <aside data-chat-surfaces style={{position:'fixed',left:16,bottom:16,width:380,display:'flex',flexDirection:'column',gap:8}}>
    <HeartbeatCard step={beat('h1', 'Babysit PR #473 until it merges')} />
    <HeartbeatCard step={beat('gone', 'Old heartbeat')} />
    <NextCheck chatKey="/code/milagre-ade#12" />
    <BabysitStoppedDivider context={{ kind: 'babysit-stopped', routineId: 'gone', pr: 473, reason: 'failures', times: 3 }} />
  </aside>
  <main style={{height:'100vh'}}><Host /></main>
</>);
function Host() {
  const [routineId, setRoutineId] = useState(null);
  window.openRoutine = setRoutineId;
  return <RoutinesPage models={models} projectPath="/code/milagre-ade" routineId={routineId} onOpenRoutine={setRoutineId}
    unreadChats={new Set(['/code/milagre-ade#32'])} canOpen={() => true}
    onOpenChat={(key) => { window.opened = key; }} onOpenRunChat={(key) => { window.runChat = key; }}
    onCloseRunChat={() => { window.paneClosed = (window.paneClosed || 0) + 1; }} />;
}
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
    // A Chat whose babysit Heartbeat ended says why, on a line like a Heartbeat's.
    const stopped = "Stopped babysitting PR #473: the same problem failed 3 times.";
    assert.equal(await evaluate(`document.querySelector('[data-babysit-stopped-divider]').textContent`), stopped);
    assert.equal(await evaluate(`document.querySelector('[data-babysit-stopped-divider]').getAttribute('aria-label')`), stopped);
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
      JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('[data-routine-filter]')].map((chip) => chip.textContent.trim()))`)),
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
    await click('[data-routine-filter="paused"]');
    await waitFor(`document.querySelectorAll('[data-routine-row]').length === 1 && !!document.querySelector('[data-routine-row="t3"]')`);
    await click('[data-routine-filter="all"]');
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

    // A Routine's page: name with On, one toolbar (switch, Run now, Edit), chips, times, then Runs by day with a filter.
    await click('[data-routine-row="h2"] [data-routine-open]');
    await waitFor(`!!document.querySelector('[data-routine-page="h2"]')`);
    assert.equal(await evaluate(`document.querySelector('[data-routine-status-pill]').textContent.trim()`), "On");
    assert.deepEqual(
      JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('[data-routine-chip]')].map((chip) => chip.textContent.trim()))`)),
      ["Every 10 min", "In Notification chimes", "Default model", "Default mode"],
    );
    assert.deepEqual(
      JSON.parse(
        await evaluate(`JSON.stringify([...document.querySelectorAll('[data-routine-toolbar] button')].map((button) => button.getAttribute('aria-label')))`),
      ),
      ["Watch CI on #461 on", "Run now", "Edit"],
    );
    assert.equal(await evaluate(`!!document.querySelector('[data-routine-page] [data-routine-more]')`), false);
    assert.match(await evaluate(`document.querySelector('[data-routine-times]').textContent`), /^Next Run 12:06 · last Run 11:48 · 3 of 20 Runs left$/);
    assert.deepEqual(
      JSON.parse(
        await evaluate(`JSON.stringify([...document.querySelectorAll('[data-routine-runs] [data-segment]')].map((segment) => segment.textContent.trim()))`),
      ),
      ["All8", "Acted2", "Failed1", "Unread1"],
    );
    assert.deepEqual(JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('[data-run-day]')].map((day) => day.dataset.runDay))`)), [
      "Today",
      "Yesterday",
      "Thu, Oct 15",
    ]);
    // Today's quiet stretch folds into one line with the latest quiet summary; the older day is one summary line.
    assert.match(
      await evaluate(`document.querySelector('[data-run-day="Today"] [data-routine-fold]').textContent`),
      /09:00–11:00.*3 quiet · no TODOs in NOTES\.md/,
    );
    assert.match(await evaluate(`document.querySelector('[data-run-day="Yesterday"] [data-routine-run="f1"]').textContent`), /Failed: No worktree/);
    assert.match(await evaluate(`document.querySelector('[data-run-day-summary]').textContent`), /All day.*1 acted · 1 quiet · 1 missed/);
    await click("[data-run-day-summary]");
    await waitFor(`!!document.querySelector('[data-routine-run="o1"]')`);
    await click('[data-run-day="Today"] [data-routine-fold] button');
    await waitFor(`!!document.querySelector('[data-routine-run="q1"] [data-run-unread]')`);
    // The Runs line up with the header: a row's time starts where the name does.
    assert.equal(
      await evaluate(
        `Math.abs(document.querySelector('[data-routine-run="a1"] span').getBoundingClientRect().left - document.querySelector('[data-routine-page] h1').getBoundingClientRect().left) < 1`,
      ),
      true,
    );
    await shot("routine-page");
    // A Run's row opens its Chat beside the page (App moves its Chat pane there).
    await click('[data-routine-run="a1"]');
    assert.equal(await evaluate("window.runChat"), "/code/milagre-ade#31");
    // The Failed filter keeps only the failed Run.
    await click('[data-routine-runs] [data-segment="failed"]');
    await waitFor(`document.querySelectorAll('[data-routine-run]').length === 1 && !!document.querySelector('[data-routine-run="f1"]')`);

    // Edit in place: the name becomes a field, Cancel and Save replace the toolbar, the Runs go, Delete sits at the bottom.
    // A Run Chat open beside the page closes as the form takes it over.
    await evaluate("window.paneClosed = 0");
    await click("[data-routine-edit]");
    await waitFor(`!!document.querySelector('[data-routine-editor="h2"]')`);
    await waitFor("window.paneClosed > 0");
    assert.equal(await evaluate(`document.querySelector('[data-routine-editor] input[aria-label="Name"]').value`), "Watch CI on #461");
    assert.equal(await evaluate(`!!document.querySelector('[data-routine-runs], [data-routine-toolbar]')`), false);
    assert.match(await evaluate(`document.querySelector('[data-routine-delete]').textContent`), /Its Chats stay\..*Delete Routine/);
    // The Schedule chip's popover: a Select inside it opens into the popover, and picking from it keeps the popover open.
    await click('[data-routine-chip-trigger="Schedule"]');
    await waitFor(`!!document.querySelector('[data-routine-chip-popover="Schedule"]')`);
    await click('[data-routine-chip-popover="Schedule"] [data-segment="at"]');
    await waitFor(`!!document.querySelector('[data-routine-chip-popover="Schedule"] button[aria-label="Timezone"]')`);
    await click('[data-routine-chip-popover="Schedule"] button[aria-label="Timezone"]');
    await waitFor(`!!document.querySelector('[role="listbox"][aria-label="Timezone"]')`);
    assert.equal(
      await evaluate(`(() => {
        const panel = document.querySelector('[role="listbox"][aria-label="Timezone"]');
        const rect = panel.getBoundingClientRect();
        const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(40, rect.height / 2));
        return !!panel.closest('[data-routine-chip-popover="Schedule"]') && rect.height > 0 && panel.contains(top);
      })()`),
      true,
    );
    await clickText('[role="listbox"][aria-label="Timezone"] [data-picker-row]', "UTC");
    await waitFor(`!document.querySelector('[role="listbox"][aria-label="Timezone"]')`);
    assert.equal(await evaluate(`!!document.querySelector('[data-routine-chip-popover="Schedule"]')`), true);
    // UTC names its zone on the chip unless this computer is on UTC too.
    assert.match(await evaluate(`document.querySelector('[data-routine-chip-trigger="Schedule"]').textContent.trim()`), /^Weekdays at 09:00( \(UTC\))?$/);
    await shot("routine-edit-schedule");
    await evaluate(
      `document.querySelector('[data-routine-chip-popover="Schedule"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`,
    );
    await waitFor(`!document.querySelector('[data-routine-chip-popover="Schedule"]') && !!document.querySelector('[data-routine-editor="h2"]')`);
    await click("[data-routine-save]");
    await waitFor(`!!document.querySelector('[data-routine-page="h2"]')`);
    assert.deepEqual(JSON.parse(await evaluate("JSON.stringify([window.updated[0], window.updated[1].trigger])")), [
      "h2",
      { kind: "schedule", cron: "0 9 * * 1-5", timezone: "UTC" },
    ]);
    // Cancel leaves without saving; Delete asks, then deletes and goes back to the list.
    await evaluate("window.updated = null");
    await click("[data-routine-edit]");
    await waitFor(`!!document.querySelector('[data-routine-editor="h2"]')`);
    await click("[data-routine-cancel]");
    await waitFor(`!!document.querySelector('[data-routine-page="h2"]')`);
    // With changes, Cancel and Escape ask to discard them first; Keep editing stays.
    await click("[data-routine-edit]");
    await waitFor(`!!document.querySelector('[data-routine-editor="h2"]')`);
    await type('[data-routine-form] input[aria-label="Name"]', "Watch CI on #462");
    await click("[data-routine-cancel]");
    await waitFor(`!!document.querySelector('[data-routine-discard]')`);
    await click("[data-routine-discard-keep]");
    await waitFor(`!document.querySelector('[data-routine-discard]') && !!document.querySelector('[data-routine-editor="h2"]')`);
    await evaluate(
      `document.querySelector('[data-routine-form] input[aria-label="Name"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`,
    );
    await waitFor(`!!document.querySelector('[data-routine-discard]')`);
    await shot("routine-discard");
    await click("[data-routine-discard-keep]");
    // Opening another Routine asks too: Keep editing goes back to the form, Discard goes on to the other page.
    await evaluate("window.openRoutine('t1')");
    await waitFor(`!!document.querySelector('[data-routine-discard]') && !!document.querySelector('[data-routine-editor="h2"]')`);
    await click("[data-routine-discard-keep]");
    await waitFor(
      `!document.querySelector('[data-routine-discard]') && document.querySelector('[data-routine-editor="h2"] input[aria-label="Name"]').value === 'Watch CI on #462'`,
    );
    await evaluate("window.openRoutine('t1')");
    await waitFor(`!!document.querySelector('[data-routine-discard]')`);
    await click("[data-routine-discard-confirm]");
    await waitFor(`!!document.querySelector('[data-routine-page="t1"]') && !document.querySelector('[data-routine-editor]')`);
    assert.equal(await evaluate("window.updated"), null);
    await evaluate("window.openRoutine('h2')");
    await waitFor(`!!document.querySelector('[data-routine-page="h2"]')`);
    await click("[data-routine-edit]");
    await waitFor(`!!document.querySelector('[data-routine-delete-start]')`);
    await click("[data-routine-delete-start]");
    await waitFor(`!!document.querySelector('[data-routine-delete-confirm]')`);
    assert.match(await evaluate(`document.querySelector('[data-routine-delete]').textContent`), /Delete Watch CI on #461\? Its Chats stay\./);
    await click("[data-routine-delete-confirm]");
    await waitFor(`window.deleted === 'h2' && !!document.querySelector('[data-routines-page]')`);

    // New Routine in place: Create stays off until a name and a prompt are given; Starts picks the trigger.
    await click("[data-routine-new]");
    await waitFor(`!!document.querySelector('[data-routine-editor="new"]')`);
    assert.equal(await evaluate(`document.querySelector('[data-routine-save]').disabled`), true);
    assert.equal(await evaluate(`document.querySelector('[data-routine-editor] input[aria-label="Name"]').placeholder`), "Name this Routine");
    assert.deepEqual(
      JSON.parse(
        await evaluate(
          `JSON.stringify([...document.querySelectorAll('[data-routine-editor] [data-routine-chips] button')].map((chip) => chip.textContent.trim()))`,
        ),
      ),
      ["Every hour", "New Worktree in milagre-ade", "Default model", "Retry on another provider", "Default mode"],
    );
    assert.match(
      await evaluate(`document.querySelector('[data-routine-runs-placeholder]').textContent`),
      /Runs show here once the Routine is created\. The first one starts at 13:00\./,
    );
    assert.equal(await evaluate(`document.querySelector('[data-routine-prompt-hint]').textContent`), "Type {{ for the Run's fields");
    // Every offers only the steps a cron repeats on evenly.
    await click('[data-routine-chip-trigger="Schedule"]');
    await waitFor(`!!document.querySelector('[data-routine-chip-popover="Schedule"] button[aria-label="Every"]')`);
    await click('[data-routine-chip-popover="Schedule"] button[aria-label="Every"]');
    await waitFor(`!!document.querySelector('[role="listbox"][aria-label="Every"]')`);
    assert.deepEqual(
      JSON.parse(
        await evaluate(
          `JSON.stringify([...document.querySelectorAll('[role="listbox"][aria-label="Every"] [data-picker-row]')].map((row) => row.textContent.trim()))`,
        ),
      ),
      ["1", "2", "3", "4", "6", "8", "12", "24"],
    );
    await clickText('[role="listbox"][aria-label="Every"] [data-picker-row]', "1");
    await waitFor(`!document.querySelector('[role="listbox"][aria-label="Every"]')`);
    await evaluate(
      `document.querySelector('[data-routine-chip-popover="Schedule"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`,
    );
    await waitFor(`!document.querySelector('[data-routine-chip-popover="Schedule"]') && !!document.querySelector('[data-routine-editor="new"]')`);
    await shot("routine-new");
    // Linear: its rows show under the chips, and the Team Select's panel is the topmost element where it opens.
    await click('[data-routine-editor] [data-segment="linear"]');
    await waitFor(`!!document.querySelector('[data-routine-form] button[aria-label="Team"]')`);
    assert.doesNotMatch(await evaluate(`document.querySelector('[data-routine-runs-placeholder]').textContent`), /first one/);
    assert.equal(
      await evaluate(`document.querySelector('[data-routine-prompt-hint]').textContent`),
      "Type {{ for the Run's fields. Issue text is passed as data, not instructions.",
    );
    await click('[data-routine-form] button[aria-label="Team"]');
    await waitFor(`!!document.querySelector('[role="listbox"][aria-label="Team"]')`);
    assert.equal(
      await evaluate(`(() => {
        const panel = document.querySelector('[role="listbox"][aria-label="Team"]');
        const rect = panel.getBoundingClientRect();
        const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(20, rect.height / 2));
        return rect.height > 0 && panel.contains(top);
      })()`),
      true,
    );
    await shot("routines-form-team");
    await clickText('[role="listbox"][aria-label="Team"] [data-picker-row]', "MIL · Milagre");
    await waitFor(`!document.querySelector('[role="listbox"][aria-label="Team"]')`);
    // MIL's labels load into the Label Select.
    await waitFor(`!!document.querySelector('[data-routine-form] button[aria-label="Label"]')`);
    await click('[data-routine-form] button[aria-label="Label"]');
    await waitFor(`!!document.querySelector('[role="listbox"][aria-label="Label"]')`);
    await clickText('[role="listbox"][aria-label="Label"] [data-picker-row]', "agent");
    await waitFor(`!document.querySelector('[role="listbox"][aria-label="Label"]')`);
    await type('[data-routine-form] input[aria-label="Name"]', "Take issues labelled agent");
    assert.equal(await evaluate(`document.querySelector('[data-routine-chip="trigger"]').textContent.trim()`), "Linear · label agent added · team MIL");

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

    // Create calls createRoutine with a Linear trigger and lands on the new Routine's page.
    await waitFor(`!document.querySelector('[data-routine-save]').disabled`);
    await click("[data-routine-save]");
    await waitFor(`window.created !== null`);
    assert.deepEqual(JSON.parse(await evaluate("JSON.stringify(window.created)")), {
      name: "Take issues labelled agent",
      prompt: "Work on {{issue.key}} {{issue.state}}",
      trigger: { kind: "linear", workspace: "milagre", event: "label-added", team: "MIL", label: "agent" },
      target: { kind: "new-chat", projectPath: "/code/milagre-ade", workspace: "worktree" },
    });
    await waitFor(`!!document.querySelector('[data-routine-page^="new"]') && !document.querySelector('[data-routine-editor]')`);
    await click("[data-routine-back]");
    await waitFor(`!!document.querySelector('[data-routines-page]')`);

    // Escape cancels the (unchanged) form and is consumed there, so App's Escape stays put.
    await click("[data-routine-new]");
    await waitFor(`!!document.querySelector('[data-routine-editor="new"]')`);
    assert.equal(
      await evaluate(`(() => {
        const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        document.querySelector('[data-routine-form] input[aria-label="Name"]').dispatchEvent(event);
        return event.defaultPrevented;
      })()`),
      true,
    );
    await waitFor(`!document.querySelector('[data-routine-form]') && !!document.querySelector('[data-routines-page]')`);

    // A webhook Routine: its new page shows its URL once, with Copy.
    await click("[data-routine-new]");
    await waitFor(`!!document.querySelector('[data-routine-editor="new"]')`);
    await click('[data-routine-editor] [data-segment="webhook"]');
    await waitFor(`document.querySelector('[data-routine-hook]').textContent.includes('The URL appears after you create the Routine.')`);
    await type('[data-routine-form] input[aria-label="Name"]', "Triage Sentry");
    await type("[data-routine-prompt]", "Triage this crash");
    await click("[data-routine-save]");
    await waitFor(`!!document.querySelector('[data-routine-created] [data-routine-hook-copy]')`);
    assert.match(
      await evaluate(`document.querySelector('[data-routine-created]').textContent`),
      /Routine created.*relay\.milagre\.cloud\/hook\/k3fTESTsecret9Qx/,
    );
    assert.deepEqual(JSON.parse(await evaluate("JSON.stringify(window.created.trigger)")), { kind: "webhook", signed: false });
    await shot("routines-webhook-created");
    await click("[data-routine-back]");
    await waitFor(`!!document.querySelector('[data-routines-page]')`);

    // A Linear comment Routine: no Where chip, a note instead; the target is filled from the open Project.
    await click("[data-routine-new]");
    await waitFor(`!!document.querySelector('[data-routine-editor="new"]')`);
    await click('[data-routine-editor] [data-segment="linear"]');
    await waitFor(`!!document.querySelector('[data-routine-form] button[aria-label="When"]')`);
    await click('[data-routine-form] button[aria-label="When"]');
    await waitFor(`!!document.querySelector('[role="listbox"][aria-label="When"]')`);
    await clickText('[role="listbox"][aria-label="When"] [data-picker-row]', "New comment");
    await waitFor(`!!document.querySelector('[data-routine-comment-note]')`);
    assert.equal(await evaluate(`document.querySelector('[data-routine-comment-note]').textContent.trim()`), "Comments go into the Chat linked to the issue.");
    assert.equal(await evaluate(`!!document.querySelector('[data-routine-chip-trigger="Where"]')`), false);
    await type('[data-routine-form] input[aria-label="Name"]', "Answer comments");
    await type("[data-routine-prompt]", "Reply to the comment");
    // The Mac's list can't be read after the create: the form says so, and Create stays off, so a second click makes nothing.
    await evaluate("window.failList = true; window.createCount = 0");
    await click("[data-routine-save]");
    await waitFor(`window.created && window.created.name === 'Answer comments'`);
    await waitFor(`document.querySelector('[data-routine-save]').disabled && /did not answer/.test(document.querySelector('[data-routine-form]').textContent)`);
    await click("[data-routine-save]");
    await delay(200);
    assert.equal(await evaluate("window.createCount"), 1);
    await evaluate("window.failList = false; window.routinesChanged()");
    assert.deepEqual(JSON.parse(await evaluate("JSON.stringify([window.created.trigger, window.created.target])")), [
      { kind: "linear", workspace: "milagre", event: "comment" },
      { kind: "new-chat", projectPath: "/code/milagre-ade", workspace: "worktree" },
    ]);
    await waitFor(`!document.querySelector('[data-routine-form]')`);
    await click("[data-routine-back]");
    await waitFor(`!!document.querySelector('[data-routines-page]')`);

    // Edit the webhook from its row's menu: the page opens in its form; rotate its URL, then Save: the patch carries no
    // stale hook id, so it goes through.
    await click('[data-routine-row="t2"] [data-routine-more]');
    await waitFor(`!!document.querySelector('[data-routine-action="edit"]')`);
    await click('[data-routine-action="edit"]');
    await waitFor(`!!document.querySelector('[data-routine-editor="t2"] [data-routine-hook-rotate]')`);
    await click("[data-routine-hook-rotate]");
    await click("[data-routine-hook-rotate-confirm]");
    await waitFor(`document.querySelector('[data-routine-hook]').textContent.includes('NEWsecret')`);
    await click("[data-routine-save]");
    await waitFor(`!!document.querySelector('[data-routine-page="t2"]')`);
    assert.equal(await evaluate("window.updated[0]"), "t2");
    assert.deepEqual(JSON.parse(await evaluate("JSON.stringify(window.updated[1].trigger)")), { kind: "webhook", signed: true });

    // A paired computer comes online: its Routines join the list, its rows carry its laptop mark and name (this Mac's carry
    // none), the Computer chips narrow the list to one Mac, and Run now goes to the studio.
    await click("[data-routine-back]");
    await waitFor(`!!document.querySelector('[data-routines-page]')`);
    await evaluate(`window.computersChanged({ thisMac: 'Here', computers: [window.studio] })`);
    const remote = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7|ab12cd34";
    const row = (id) => `[data-routine-row=${JSON.stringify(id)}]`;
    await waitFor(`!!document.querySelector(${JSON.stringify(row(remote))})`);
    await waitFor(`document.querySelector(${JSON.stringify(row(remote) + " [data-routine-computer]")})?.textContent.startsWith('studio')`);
    assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(row(remote) + " [data-routine-computer] svg")})`), true, "the laptop mark");
    const marks = JSON.parse(
      await evaluate(
        `JSON.stringify([...document.querySelectorAll('[data-routine-row]')].map((node) => [node.dataset.routineRow, !!node.querySelector('[data-routine-computer]')]))`,
      ),
    );
    for (const [id, marked] of marks) assert.equal(marked, id === remote, id);
    const computerChips = JSON.parse(
      await evaluate(`JSON.stringify([...document.querySelectorAll('[data-routine-computer-filter]')].map((node) => node.textContent.trim()))`),
    );
    const total = marks.length;
    assert.deepEqual(computerChips, [`Every computer ${total}`, `Here ${total - 1}`, "studio 1"]);
    await shot("routines-two-computers");
    await click('[data-routine-computer-filter="6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7"]');
    await waitFor(`document.querySelectorAll('[data-routine-row]').length === 1`);
    assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(row(remote))})`), true);
    assert.equal(await evaluate(`document.querySelector('[data-routine-filter="all"]').textContent.trim()`), "All 1", "the kind counts follow the computer");
    await shot("routines-one-computer");
    await click('[data-routine-computer-filter="all"]');
    await waitFor(`document.querySelectorAll('[data-routine-row]').length === ${total}`);
    await click(`${row(remote)} [data-routine-more]`);
    await waitFor(`!!document.querySelector('[data-routine-action="run"]')`);
    await click('[data-routine-action="run"]');
    await waitFor("!!window.remoteRan");
    assert.deepEqual(JSON.parse(await evaluate("JSON.stringify(window.remoteRan)")), ["6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7", remote]);
    assert.equal(await evaluate("window.localRan === undefined"), true, "this Mac ran nothing");
    // The studio goes offline: its last copy stays listed, and the page says that's what it is.
    await evaluate(`window.computersChanged({ thisMac: 'Here', computers: [{ ...window.studio, state: 'offline' }] })`);
    const problem = `[data-routines-computer-problem="6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7"]`;
    await waitFor(`document.querySelector(${JSON.stringify(problem)})?.textContent.startsWith('studio is offline.')`);
    assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(row(remote))})`), true, "the last copy stays listed");
    // The studio comes back online: its notice goes and its Routines stay listed.
    await evaluate(`window.computersChanged({ thisMac: 'Here', computers: [window.studio] })`);
    await waitFor(`!document.querySelector(${JSON.stringify(problem)})`);
    assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(row(remote))})`), true, "its Routines stay listed");
    // Other computers switched off: the studio's Routines leave the list.
    await evaluate(`window.computersChanged({ thisMac: 'Here', computers: [{ ...window.studio, state: 'off' }] })`);
    await waitFor(`!document.querySelector(${JSON.stringify(row(remote))})`);
    console.log(
      "PASS: Routines page groups and counts Routines; Heartbeat cards and Next check show; a Routine's page shows its chips and Runs by day; Edit and New Routine work in place, {{ suggests placeholders, and Create lands on the new Routine; a paired computer's Routines join the list, named by it, and its Run now goes to it; an offline one keeps its last copy with a notice.",
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
          useAsyncMiddleware(server.middlewares, async (req, res, next) => {
            if (req.url !== "/__routines__") return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await server.transformIndexHtml(
                req.url,
                '<html><body><div id="root"></div><script>localStorage.setItem("milagre-settings", JSON.stringify({ otherComputers: true }))</script><script type="module" src="/__routines.tsx"></script></body></html>',
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
