// Design council screenshots: the REAL desktop renderer (App.tsx through Vite) with a fixed fixture behind a stubbed
// window.milagre bridge, captured in a hidden Electron window at 1440x900 @2x, light and dark.
//
//   node scripts/design-council/capture-desktop.cjs <outDir>
//
// Writes d01-chat-light.png, d01-chat-dark.png, ... (see SCREENS below). No provider, daemon or personal data: Vite runs on
// a random port, Electron gets a temp userData dir and a hidden window, and only those two processes are stopped at the
// end. A step that fails is logged and its screen is skipped; the run carries on with the next one. Selectors use
// aria-label, role and text so they survive styling changes.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

const ROOT = path.resolve(__dirname, "../..");
const WIDTH = 1440;
const HEIGHT = 900;
const SCALE = 2;
const THEMES = ["light", "dark"];
// Every timestamp in the fixture hangs off this instant, and the renderer's clock is frozen at it, so relative times
// ("5m", "1m 30s") and running timers read the same every run.
const NOW = Date.UTC(2026, 10, 9, 14, 0, 0);
const min = (n) => NOW - n * 60000;

// ---------------------------------------------------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------------------------------------------------
const projectPath = "/demo/milagre";
const projectImage = "data:image/png;base64," + fs.readFileSync(path.join(ROOT, "apps/desktop/app/public/logo-milagre-image.png")).toString("base64");

// [chat id, title, branch, provider, minutes since last activity, extra session fields]
const CHATS = [
  [2, "Reset paired phones from Settings", "feat/phone-reset", "claude", 3, {}],
  [3, "Find Projects from the phone", "feat/project-search", "codex", 6, {}],
  [4, "A sidebar for mobile", "feat/mobile-sidebar", "claude", 1, {}],
  [5, "Swipe between Chat and Changes", "feat/swipe-navigation", "codex", 9, {}],
  [6, "Keep the Chat timer running", "fix/chat-timer", "claude", 24, { unread: true }],
  [7, "Link Worktrees and share context", "feat/linked-worktrees", "codex", 75, {}],
  [8, "Tighten the relay health check", "fix/relay-health", "claude", 190, {}],
];
const MAIN_CHAT = 2;
const QUESTION_CHAT = 3;
const RUNNING_CHAT = 4;
const APPROVAL_CHAT = 5;
const CHAT_TITLE = Object.fromEntries(CHATS.map(([id, title]) => [id, title]));
// Sidebar PR badges, by branch.
const PULLS = {
  "feat/phone-reset": { number: 192, checks: "passed" },
  "feat/project-search": { number: 189, checks: "running" },
  "fix/chat-timer": { number: 177, checks: "passed", readyToMerge: true },
  "feat/linked-worktrees": { number: 168, checks: "failed" },
};

const userAsk =
  "Settings › Devices should let me remove every paired phone at once. Ask before clearing, and show how many phones are paired in the section title.";
const assistantReply = [
  "## Reset paired phones",
  "",
  "Settings › Devices now has a **Remove all** button. It asks first, then revokes each phone and refreshes the list. The section title shows the count, so it drops to zero at once.",
  "",
  "What changed:",
  "",
  "- `usePairedPhones` returns a `reset()` that revokes every phone and reports how many it removed.",
  "- `PairedPhones` shows *Paired phones (3)* and a confirm dialog before anything is removed.",
  "- A new test covers the confirm path: cancelling removes nothing.",
  "",
  "```ts",
  "export async function resetPairedPhones(bridge: Bridge, confirm = true): Promise<number> {",
  "  const phones = await bridge.listPhones();",
  "  if (confirm && !window.confirm(`Remove ${phones.length} phones?`)) return 0;",
  "  for (const phone of phones) await bridge.revokePhone(phone.id);",
  "  return phones.length;",
  "}",
  "```",
  "",
  "Run `npm test -- --only phone` to check the flow; all three tests pass.",
].join("\n");
const followUpAsk = "Nice. Does the phone app notice right away, or only after it reconnects?";
const followUpReply =
  "Right away. Revoking a phone closes its relay session, so the app drops to the pairing screen within a second. I checked it against the relay's `session:closed` event; nothing else needs to change.";

const editDiff = [
  "--- a/apps/desktop/app/src/components/PairedPhones.tsx",
  "+++ b/apps/desktop/app/src/components/PairedPhones.tsx",
  "@@ -21,8 +21,9 @@ export function PairedPhones() {",
  "   const { phones, refresh } = usePairedPhones();",
  "   return (",
  '     <section aria-label="Paired phones">',
  "-      <h2>Phones</h2>",
  "-      <button onClick={refresh}>Refresh</button>",
  "+      <h2>Paired phones ({phones.length})</h2>",
  "+      <button onClick={reset}>Remove all</button>",
  "+      <button onClick={refresh}>Refresh</button>",
  "       <PhoneList phones={phones} />",
  "     </section>",
  "   );",
].join("\n");

const t0 = min(4);
const steps = [
  {
    id: "s-read",
    kind: "read",
    title: "Read `usePairedPhones.ts`",
    file: "apps/mobile/src/hooks/usePairedPhones.ts",
    status: "done",
    offset: 0,
    startedAt: t0,
    endedAt: t0 + 400,
    durationMs: 400,
    detail: 'import { useCallback, useEffect, useState } from "react";\nimport { listPhones } from "../lib/phones";\n',
  },
  {
    id: "s-search",
    kind: "search",
    title: "Searched for `revokePhone`",
    status: "done",
    offset: 0,
    startedAt: t0 + 500,
    endedAt: t0 + 900,
    durationMs: 400,
    summary: "4 results",
  },
  {
    id: "s-edit",
    kind: "edit",
    title: "Edited `PairedPhones.tsx`",
    file: "apps/desktop/app/src/components/PairedPhones.tsx",
    status: "done",
    offset: 0,
    startedAt: t0 + 1000,
    endedAt: t0 + 1600,
    durationMs: 600,
    detail: editDiff,
  },
  {
    id: "s-bash",
    kind: "shell",
    title: "Ran `npm test -- --only phone`",
    input: "npm test -- --only phone",
    status: "done",
    offset: 0,
    startedAt: t0 + 2000,
    endedAt: t0 + 14200,
    durationMs: 12200,
    detail:
      "$ npm test -- --only phone\n ✓ reset removes every phone and says how many (12 ms)\n ✓ the sidebar badge follows the count (8 ms)\n ✓ reset asks before it clears (5 ms)\nTests 3 passed (3 files)",
  },
];

const state = {
  next_id: 1000,
  projects: { 1: { id: 1, name: "Milagre" } },
  worktrees: { 1: { id: 1, project_id: 1, path: projectPath, name: "main" } },
  sessions: {},
  messages: [],
  connections: {},
  events: [],
  approvals: [],
  tasks: {},
  artifacts: {},
  outputs: [],
  conflicts: [],
};
const DIFFS = { 2: [14, 6, 3], 3: [42, 9, 4], 4: [120, 31, 6], 5: [18, 2, 2], 6: [7, 3, 1], 7: [233, 80, 9], 8: [5, 1, 1] };
for (const [id, title, branch, provider, age, extra] of CHATS) {
  const [added, removed, files] = DIFFS[id];
  state.worktrees[id] = { id, project_id: 1, name: branch, path: `${projectPath}/${branch}`, base: "main", diff: { added, removed, files } };
  state.sessions[id] = {
    id,
    worktree_id: id,
    title,
    agent_name: title,
    provider,
    status: "Stopped",
    created_at: min(age + 30),
    summary: { count: 2, firstId: id * 10, lastId: id * 10 + 1, titleLine: title, lastAt: min(age) },
    ...extra,
  };
  const model = provider === "claude" ? "claude-opus-5-5" : "gpt-6.1-sol";
  if (id === MAIN_CHAT) {
    state.messages.push(
      { id: id * 10, session_id: id, role: "user", body: userAsk, context: null, model, created_at: min(5) },
      { id: id * 10 + 1, session_id: id, role: "assistant", body: assistantReply, context: null, model, steps, created_at: min(3) },
      { id: id * 10 + 2, session_id: id, role: "user", body: followUpAsk, context: null, model, created_at: min(2) },
      { id: id * 10 + 3, session_id: id, role: "assistant", body: followUpReply, context: null, model, created_at: min(2) },
    );
  } else {
    state.messages.push({
      id: id * 10,
      session_id: id,
      role: "user",
      body: `Let's work on ${title.toLowerCase()}.`,
      context: null,
      model,
      created_at: min(age + 2),
    });
    if (id !== QUESTION_CHAT && id !== RUNNING_CHAT && id !== APPROVAL_CHAT)
      state.messages.push({
        id: id * 10 + 1,
        session_id: id,
        role: "assistant",
        body: `Done: ${title.toLowerCase()} is in place and its checks pass.`,
        context: null,
        model,
        created_at: min(age),
      });
  }
}
const project = { path: projectPath, name: "Milagre", state };

// Two other Projects, so the sidebar shows several.
const otherState = (rows) => ({
  next_id: 100,
  projects: { 1: { id: 1, name: "x" } },
  worktrees: { 1: { id: 1, name: "main", path: "/work/x", diff: { added: 12, removed: 3, files: 2 } } },
  sessions: Object.fromEntries(
    rows.map(([id, title, age, extra = {}]) => [
      id,
      {
        id,
        worktree_id: 1,
        agent_name: "Claude",
        provider: "claude",
        status: "Idle",
        title,
        summary: { count: 1, firstId: id, lastId: id, titleLine: title, lastAt: min(age) },
        ...extra,
      },
    ]),
  ),
  messages: rows.map(([id, title]) => ({ id, session_id: id, role: "user", body: title, context: null })),
  connections: {},
  events: [],
  approvals: [],
  tasks: {},
  artifacts: {},
  outputs: [],
  conflicts: [],
});
const OTHER_PROJECTS = {
  "/demo/website": {
    name: "Website",
    state: otherState([
      [11, "Pricing page copy pass", 40],
      [12, "Lighthouse budget on mobile", 300],
    ]),
  },
  "/demo/relay": { name: "Relay", state: otherState([[21, "Rotate the Worker token", 130, { unread: true }]]) },
};

const runStart = min(1.5);
const run = (text, more = {}) => ({ text, model: "claude-opus-5-5", startedAt: runStart, steps: [], approvals: [], questions: [], answered: {}, ...more });
const runs = {
  seq: 1,
  runs: {
    [`${projectPath}#${RUNNING_CHAT}`]: run("Laying out the drawer and checking it on an iPhone 17.", {
      steps: [
        { id: "r1", kind: "read", title: "Read `Sidebar.tsx`", status: "done", offset: 0, startedAt: runStart, endedAt: runStart + 500, durationMs: 500 },
        { id: "r2", kind: "shell", title: "Ran `npm run typecheck`", status: "running", offset: 54, startedAt: runStart + 1000 },
      ],
    }),
    [`${projectPath}#${QUESTION_CHAT}`]: run("I found two ways to scope the search. Which one should I build?", {
      model: "gpt-6.1-sol",
      questions: [
        {
          requestId: "search-scope",
          questions: [
            {
              id: "scope",
              header: "Search",
              question: "Should Project search on the phone include folders Git ignores?",
              options: [
                { label: "Skip ignored folders", description: "Faster, and results stay focused on real Projects." },
                { label: "Include everything", description: "Finds Projects inside build output and vendored code too." },
              ],
              multiSelect: false,
              allowOther: true,
              secret: false,
            },
          ],
        },
      ],
    }),
    [`${projectPath}#${APPROVAL_CHAT}`]: run("The swipe handler is in place. I'll run the gesture checks on the simulator next.", {
      model: "gpt-6.1-sol",
      permissionMode: "ask",
      steps: [
        {
          id: "a1",
          kind: "edit",
          title: "Edited `SwipePager.tsx`",
          file: "apps/mobile/src/components/SwipePager.tsx",
          status: "done",
          offset: 0,
          startedAt: runStart,
          endedAt: runStart + 700,
          durationMs: 700,
          detail: "@@ -1,3 +1,4 @@\n-const THRESHOLD = 40;\n+const THRESHOLD = 24;\n+const VELOCITY = 0.3;\n",
        },
        {
          id: "a2",
          kind: "shell",
          title: "Run `npm run test:mobile -- swipe`",
          input: "npm run test:mobile -- swipe",
          status: "running",
          offset: 81,
          startedAt: runStart + 1000,
        },
      ],
      approvals: [
        {
          requestId: "approve-swipe",
          kind: "command",
          tool: "Bash",
          title: "Run `npm run test:mobile -- swipe`",
          description: "Run the swipe navigation checks on the booted simulator",
          command: "npm run test:mobile -- swipe",
          cwd: `${projectPath}/feat/swipe-navigation`,
          allowForChat: true,
          stepId: "a2",
        },
      ],
    }),
  },
};

// Changes panel: uncommitted files in the main Chat's Worktree.
const patch = (...lines) => lines.join("\n") + "\n";
const FILES = {
  "apps/mobile/src/hooks/usePairedPhones.ts": {
    status: "modified",
    added: 9,
    removed: 4,
    patch: patch(
      "@@ -1,16 +1,21 @@",
      ' import { useCallback, useEffect, useState } from "react";',
      '-import { listPhones } from "../lib/phones";',
      '+import { listPhones, revokePhone } from "../lib/phones";',
      " ",
      " // The phones this Mac has paired with, newest first.",
      " export function usePairedPhones() {",
      "   const [phones, setPhones] = useState<Phone[]>([]);",
      "   const [loading, setLoading] = useState(true);",
      " ",
      "-  const refresh = useCallback(() => listPhones().then(setPhones), []);",
      "+  const refresh = useCallback(async () => {",
      "+    setPhones(await listPhones());",
      "+    setLoading(false);",
      "+  }, []);",
      " ",
      "   useEffect(() => {",
      "-    void refresh();",
      "+    refresh().catch(() => setLoading(false));",
      "   }, [refresh]);",
      " ",
      "-  return { phones, refresh };",
      "+  const reset = useCallback(async () => {",
      "+    for (const phone of phones) await revokePhone(phone.id);",
      "+    await refresh();",
      "+    return phones.length;",
      "+  }, [phones, refresh]);",
      "+",
      "+  return { phones, loading, refresh, reset };",
      " }",
    ),
  },
  "apps/desktop/app/src/components/PairedPhones.tsx": {
    status: "modified",
    added: 3,
    removed: 2,
    patch: patch(
      "@@ -21,8 +21,9 @@ export function PairedPhones() {",
      "   const { phones, refresh } = usePairedPhones();",
      "   return (",
      '     <section aria-label="Paired phones">',
      "-      <h2>Phones</h2>",
      "-      <button onClick={refresh}>Refresh</button>",
      "+      <h2>Paired phones ({phones.length})</h2>",
      "+      <button onClick={reset}>Remove all</button>",
      "+      <button onClick={refresh}>Refresh</button>",
      "       <PhoneList phones={phones} />",
      "     </section>",
      "   );",
    ),
  },
  "apps/desktop/app/src/lib/phones.test.ts": {
    status: "added",
    added: 7,
    removed: 0,
    patch: patch(
      "@@ -0,0 +1,7 @@",
      '+import { expect, test } from "vitest";',
      '+import { resetPairedPhones } from "./phones";',
      "+",
      '+test("reset removes every phone and says how many", async () => {',
      "+  const bridge = fakeBridge(3);",
      "+  expect(await resetPairedPhones(bridge, false)).toBe(3);",
      "+});",
    ),
  },
};

// The main Chat's PR, as the Changes panel's PR tab reads it.
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const PR_DETAIL = {
  number: 192,
  url: "https://github.com/acme/milagre/pull/192",
  title: "feat: remove every paired phone from Settings",
  body: "Settings › Devices gets **Remove all**, with a confirm dialog and the paired count in the section title.\n\n- Revokes each phone's relay session\n- Covered by `phones.test.ts`",
  state: "OPEN",
  isDraft: false,
  author: "demo-author",
  createdAt: new Date(min(50)).toISOString(),
  updatedAt: new Date(min(3)).toISOString(),
  baseRefName: "main",
  headRefName: "feat/phone-reset",
  headRefOid: HEAD,
  baseRefOid: BASE,
  additions: 19,
  deletions: 6,
  changedFiles: 3,
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  autoMerge: null,
  viewerCanMergeAsAdmin: false,
  viewerIsAuthor: true,
  checks: [
    { name: "typecheck", workflow: "CI", outcome: "pass" },
    { name: "unit", workflow: "CI", outcome: "pass" },
    { name: "electron (shard 1)", workflow: "CI", outcome: "pass" },
  ],
  reviewers: [
    { login: "reviewer-one", state: "APPROVED" },
    { login: "reviewer-two", state: "COMMENTED" },
  ],
  labels: [{ name: "feature", color: "0e8a16" }],
  commits: [{ oid: HEAD, headline: "feat: remove every paired phone from Settings" }],
  files: Object.entries(FILES).map(([p, f]) => ({ path: p, additions: f.added, deletions: f.removed, status: f.status })),
  threads: [
    {
      id: "T1",
      path: "apps/desktop/app/src/components/PairedPhones.tsx",
      line: 24,
      side: "RIGHT",
      resolved: false,
      outdated: false,
      comments: [
        { id: "C1", author: "reviewer-two", body: "Should Remove all be disabled while the list is loading?", createdAt: new Date(min(20)).toISOString() },
      ],
    },
  ],
  comments: [
    {
      id: "IC1",
      author: "reviewer-one",
      body: "Tried it with three phones paired: the count updates at once. Looks good.",
      createdAt: new Date(min(15)).toISOString(),
    },
  ],
  pendingReview: null,
};

const MODELS = { codex: null, claude: null, antigravity: null, kiro: null };

// ---------------------------------------------------------------------------------------------------------------------
// The renderer entry: real App, stubbed host bridge.
// ---------------------------------------------------------------------------------------------------------------------
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles.css';
const NOW = ${NOW};
// Freeze the clock so relative times and running timers render the same every run.
{
  const RealDate = Date;
  class FixedDate extends RealDate { constructor(...args) { if (args.length === 0) super(NOW); else super(...args); } static now() { return NOW; } }
  window.Date = FixedDate;
}
window.addEventListener('error', e => console.error('[page error]', e.error?.stack || e.message));
const params = new URLSearchParams(location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
const project = ${JSON.stringify(project)};
const others = ${JSON.stringify(OTHER_PROJECTS)};
const runs = ${JSON.stringify(runs)};
const FILES = ${JSON.stringify(FILES)};
const PULLS = ${JSON.stringify(PULLS)};
const PR_DETAIL = ${JSON.stringify(PR_DETAIL)};
const entries = Object.entries(FILES).map(([path, f]) => ({ path, status: f.status, added: f.added, removed: f.removed, binary: false }));
const recent = [{ path: project.path, name: project.name }, ...Object.entries(others).map(([path, p]) => ({ path, name: p.name }))];
const pullFor = (p) => {
  const branch = Object.keys(PULLS).find((b) => p && p.endsWith(b));
  if (!branch) return null;
  const { number, checks, readyToMerge } = PULLS[branch];
  const title = Object.values(project.state.sessions).find((s) => project.state.worktrees[s.worktree_id]?.name === branch)?.title ?? branch;
  return { number, title, url: 'https://github.com/acme/milagre/pull/' + number, state: 'OPEN', checks, readyToMerge: !!readyToMerge };
};
const replies = {
  getCurrentProject: project, getRuns: runs, getModels: ${JSON.stringify(MODELS)},
  getCliStatus: {codex:{state:'ready'},claude:{state:'ready'},antigravity:{state:'ready'},kiro:{state:'missing'}},
  getRuntimeConnection: {connected:true}, getLinkedWork: {delegations:[],negotiations:[],receiveOnly:[]},
  listRecentProjects: recent, listProjects: [], listNamedLinks: [], listBranches: ['main', 'feat/phone-reset'],
  getWorktreeRoots: [], getCachedUsage: {providers:[]}, readUsage: {providers:[]}, getAgentPorts: {},
  getUpdateState: {status:'idle'}, listSkills: {skills:[],warnings:[]}, listAgentPorts: [],
  readDiffStats: {}, getDiffStats: {}, readDesignsEnabled: {enabled: true}, listEditors: [], getAppVersion: '1.0.0',
};
const prBridge = {
  detail: async () => ({ ok: true, pr: PR_DETAIL }),
  diffFiles: async () => ({ isRepo: true, base: null, files: entries }),
  diffFile: async ({ path }) => ({ patch: FILES[path]?.patch ?? '', binary: false, tooLarge: false }),
  labels: async () => ({ ok: true, labels: [] }),
  reviewerCandidates: async () => ({ ok: true, logins: [] }),
  image: async () => ({ ok: false }),
};
window.milagre = new Proxy({}, {get(_, name) {
  if (typeof name !== 'string') return undefined;
  if (name === 'git') return {
    diffStats: async () => ({ added: 19, removed: 6 }),
    diffFiles: async ({ mode } = {}) => ({ isRepo: true, base: 'main', files: mode === 'committed' ? [] : entries }),
    diffFile: async ({ path }) => ({ patch: FILES[path]?.patch ?? '', binary: false, tooLarge: false }),
    history: async () => ({
      isRepo: true, branch: 'feat/phone-reset', base: 'main', comparisonRef: 'refs/heads/main', head: 'a1b2c3d', total: 2,
      branches: [{ ref: 'refs/heads/main', name: 'main' }, { ref: 'refs/heads/feat/phone-reset', name: 'feat/phone-reset' }],
      branchesVersion: 'v1', hasMore: false,
      commits: [
        { sha: 'a1b2c3d4e5f6', author: 'Victor Lucas', email: 'victor@example.invalid', date: '2026-11-09T13:40:00Z', message: 'Add Remove all to paired phones', files: 2, added: 14, removed: 3 },
        { sha: 'b2c3d4e5f6a1', author: 'Victor Lucas', email: 'victor@example.invalid', date: '2026-11-09T12:10:00Z', message: 'Return a reset() from usePairedPhones', files: 1, added: 5, removed: 3 },
      ],
    }),
  };
  if (name === 'pr') return new Proxy(prBridge, { get: (t, k) => t[k] ?? (async () => ({ ok: true })) });
  if (name.startsWith('on')) return () => () => {};
  // Only Milagre has an image; the other Projects show their initials.
  if (name === 'getProjectImage') return async (p) => (p === undefined || p === project.path ? ${JSON.stringify(projectImage)} : null);
  if (name === 'readProject') return async (p) => others[p] ? { path: p, name: others[p].name, state: others[p].state } : p === project.path ? project : null;
  if (name === 'getProjectAccounts') return async (scopeKey) => ({ scopeKey, providers: [] });
  if (name === 'readPullRequest') return async (p) => pullFor(p);
  if (name === 'readPullRequests') return async (_, paths) => paths.map(pullFor);
  if (name === 'readPullRequestSnapshot') return async () => { throw new Error('Unknown command: pull-requests:snapshot'); };
  return async () => name in replies ? replies[name] : null;
}});
localStorage.setItem('milagre-settings', JSON.stringify({ theme, defaultPermissionMode: 'auto', notifyWhenWaiting: false, notifyOnCompletion: false, showDockBadge: false, showUsageInSidebar: false }));
const { default: App } = await import('/src/App');
createRoot(document.getElementById('root')).render(<App />);
`;

// ---------------------------------------------------------------------------------------------------------------------
// Screens. Each runs on a fresh page load in the given theme; `ready` waits for the app, `act` drives it.
// ---------------------------------------------------------------------------------------------------------------------
/** In-page helpers, injected once per load; everything finds elements by role, aria-label or text. */
const HELPERS = `
window.__c = {
  visible(el) { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; },
  byLabel(label, root = document) { return [...root.querySelectorAll('[aria-label]')].filter((el) => el.getAttribute('aria-label') === label && __c.visible(el)); },
  byLabelStart(prefix, root = document) { return [...root.querySelectorAll('[aria-label]')].filter((el) => el.getAttribute('aria-label').startsWith(prefix) && __c.visible(el)); },
  byText(text, selector = 'button, [role=button], a, [role=tab], [role=menuitem], [role=option], [data-row]') {
    return [...document.querySelectorAll(selector)].filter((el) => __c.visible(el) && el.textContent.trim().includes(text));
  },
  chatRow(title) {
    const rows = [...document.querySelectorAll('[data-row]')].filter((el) => __c.visible(el) && el.textContent.includes(title));
    return rows.find((el) => el.tagName === 'BUTTON') || rows[0] || [...document.querySelectorAll('[data-chat-id]')].find((el) => __c.visible(el) && el.textContent.includes(title));
  },
  click(el) { if (!el) return false; el.scrollIntoView?.({ block: 'nearest' }); el.click(); return true; },
};
`;

const SCREENS = [
  {
    name: "d01-chat",
    what: "Sidebar with three Projects (running, unread, PR badges) and the main Chat's transcript with markdown, tool rows and the composer",
    async act(p) {
      await p.openChat(CHAT_TITLE[MAIN_CHAT]);
      await p.waitFor(
        `document.body.innerText.includes(${JSON.stringify("Reset paired phones")}) && document.querySelectorAll('.markdown .code-token').length > 5`,
      );
      await p.expandToolRows();
    },
  },
  {
    name: "d01b-edit-diff",
    what: "The same Chat scrolled to its tool rows, with the edit step opened to show its inline diff",
    async act(p) {
      await p.openChat(CHAT_TITLE[MAIN_CHAT]);
      await p.waitFor(`document.querySelectorAll('.markdown .code-token').length > 5`);
      await p.expandToolRows();
      const ok = await p.eval(
        `__c.click([...document.querySelectorAll('[aria-expanded="false"]')].find((b) => __c.visible(b) && /^\\s*Edited/.test(b.textContent)))`,
      );
      if (!ok) throw new Error("No Edited step row to open");
      await delay(400);
      // Scroll the transcript back to its top so the request, the tool rows and the diff share the screen.
      await p.eval(
        `[...document.querySelectorAll('main *, [role=main] *')].filter((el) => el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(el).overflowY)).forEach((el) => { el.scrollTop = 0; })`,
      );
    },
  },
  {
    name: "d02-new-chat",
    what: "New Chat / empty state",
    async act(p) {
      const ok = await p.eval(`__c.click(__c.byLabel('New chat')[0] || __c.byLabel('New Chat')[0])`);
      if (!ok) throw new Error("No New chat button");
      await p.waitFor(`!!document.querySelector('[data-prompt-editor]')`);
    },
  },
  {
    name: "d03-approval",
    what: "A Chat waiting on a command approval",
    async act(p) {
      await p.openChat(CHAT_TITLE[APPROVAL_CHAT]);
      await p.waitFor(`__c.byText('Allow', 'button').length > 0 || document.body.innerText.includes('npm run test:mobile')`);
    },
  },
  {
    name: "d03b-question",
    what: "A Chat waiting on a question card",
    async act(p) {
      await p.openChat(CHAT_TITLE[QUESTION_CHAT]);
      await p.waitFor(`document.body.innerText.includes('Skip ignored folders')`);
    },
  },
  {
    name: "d04-changes",
    what: "Changes panel open beside the Chat, listing three changed files",
    async act(p) {
      await p.openChat(CHAT_TITLE[MAIN_CHAT]);
      await p.waitFor(`document.querySelectorAll('.markdown .code-token').length > 5`);
      await p.openChanges();
    },
  },
  {
    name: "d04b-diff",
    what: "A file's diff open from the Changes panel (the diff view takes the Chat's place)",
    async act(p) {
      await p.openChat(CHAT_TITLE[MAIN_CHAT]);
      await p.waitFor(`document.querySelectorAll('.markdown .code-token').length > 5`);
      await p.openChanges();
      const ok = await p.eval(`__c.click(document.querySelector('[data-diff-tree-file]') || __c.byText('usePairedPhones.ts')[0])`);
      if (!ok) throw new Error("No file in the Changes panel");
      await p.waitFor(`document.querySelectorAll('[data-diff-body] .code-token').length > 10`);
    },
  },
  {
    name: "d05-settings",
    what: "Settings, first page",
    async act(p) {
      const ok = await p.eval(`__c.click(__c.byLabel('Settings')[0] || __c.byText('Settings')[0])`);
      if (!ok) throw new Error("No Settings button");
      await p.waitFor(`!!document.querySelector('[role=radiogroup], [role=switch]') && document.body.innerText.includes('Appearance')`);
    },
  },
  {
    name: "d06-palette",
    what: "Command palette open over the Chat",
    async act(p) {
      await p.openChat(CHAT_TITLE[MAIN_CHAT]);
      await p.waitFor(`document.querySelectorAll('.markdown .code-token').length > 5`);
      const ok = await p.eval(`__c.click(__c.byLabel('Command palette')[0])`);
      if (!ok) throw new Error("No Command palette button");
      await p.waitFor(`!!document.querySelector('dialog[open] input')`);
    },
  },
  {
    name: "d07-model-picker",
    what: "Composer's model picker open",
    async act(p) {
      await p.openChat(CHAT_TITLE[MAIN_CHAT]);
      await p.waitFor(`document.querySelectorAll('.markdown .code-token').length > 5`);
      // The composer's model button: it holds the model's name (Opus 5.5, GPT-6.1-Sol, ...) and toggles aria-expanded.
      const ok = await p.eval(
        `__c.click(document.querySelector('[data-model-name]')?.closest('button') || [...document.querySelectorAll('button[aria-expanded]')].find((b) => __c.visible(b) && /Opus|Sonnet|GPT|Gemini/.test(b.textContent)))`,
      );
      if (!ok) throw new Error("No model picker trigger");
      await p.waitFor(
        `!!document.querySelector('[data-model-picker]') || [...document.querySelectorAll('[role=listbox], [role=menu], [role=dialog]')].some(__c.visible)`,
      );
    },
  },
  {
    name: "d08-pr-panel",
    what: "The Chat's PR in the Changes panel: checks, reviewers, comments, merge button",
    async act(p) {
      await p.openChat(CHAT_TITLE[MAIN_CHAT]);
      await p.waitFor(`document.querySelectorAll('.markdown .code-token').length > 5`);
      await p.openChanges();
      await p.eval(`__c.click([...document.querySelectorAll('[data-changes-tab]')].find((t) => t.getAttribute('data-changes-tab').startsWith('pr:')))`);
      await p.waitFor(`!!document.querySelector('[data-pr-identity]')`);
    },
  },
];

// ---------------------------------------------------------------------------------------------------------------------
// Electron side
// ---------------------------------------------------------------------------------------------------------------------
async function capture(baseUrl, outDir, userData) {
  const { app, BrowserWindow } = require("electron");
  app.commandLine.appendSwitch("force-device-scale-factor", String(SCALE));
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.setPath("userData", userData);
  await app.whenReady();
  const only = (process.env.COUNCIL_ONLY || "").split(",").filter(Boolean);
  const results = [];
  const window = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    show: false,
    webPreferences: { backgroundThrottling: false, partition: "council-capture" },
  });
  // Nothing leaves this machine: only our own Vite server answers (GitHub avatars, fonts CDNs and the like fall back).
  const blocked = new Set();
  window.webContents.session.webRequest.onBeforeRequest({ urls: ["*://*/*"] }, (details, callback) => {
    const local = /^(https?|wss?):\/\/(127\.0\.0\.1|localhost)[:/]/.test(details.url);
    if (!local) blocked.add(new URL(details.url).host);
    callback({ cancel: !local });
  });
  const errors = [];
  window.webContents.on("console-message", (e) => {
    if (e.level === "error") errors.push(e.message.slice(0, 400));
  });
  const page = {
    eval: (source) =>
      window.webContents.executeJavaScript(source).catch((error) => {
        throw new Error(`${error.message}\n    in: ${source.slice(0, 200)}`);
      }),
    async waitFor(source, { timeout = 8000, soft = false } = {}) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await page.eval(`(() => { try { return !!(${source}); } catch { return false; } })()`)) return true;
        await delay(50);
      }
      if (soft) return false;
      throw new Error("Timed out waiting for: " + source.slice(0, 200));
    },
    async openChat(title) {
      await page.waitFor(`!!__c.chatRow(${JSON.stringify(title)})`);
      await page.eval(`__c.click(__c.chatRow(${JSON.stringify(title)}))`);
      await page.waitFor(`__c.chatRow(${JSON.stringify(title)})?.getAttribute('aria-current') === 'page'`, { soft: true });
    },
    async openChanges() {
      const ok = await page.eval(`__c.click(document.querySelector('[data-panel-toggle=changes]') || __c.byLabelStart('Changes')[0])`);
      if (!ok) throw new Error("No Changes toggle");
      await page.waitFor(`document.querySelectorAll('[data-diff-tree-file]').length >= 3 || document.body.innerText.includes('usePairedPhones.ts')`);
    },
    // Compact tool display folds a reply's calls into one line; open it so the rows themselves are judged.
    async expandToolRows() {
      await page.eval(
        `(() => { const fold = [...document.querySelectorAll('button[aria-expanded="false"]')].find((b) => /\\b(tool|step|call|ran|read|edited)/i.test(b.textContent) && b.closest('.markdown, [data-message], main')); if (fold) fold.click(); })()`,
      );
    },
  };
  async function load(theme) {
    await window.loadURL(`${baseUrl}?theme=${theme}`);
    await page.waitFor(`!!document.querySelector('[data-row]') && !document.querySelector('.startup-splash-screen')`, { timeout: 30000 });
    await page.eval(HELPERS + ";true");
  }
  async function settle() {
    await page.eval(`document.fonts.ready.then(() => true)`);
    // Move focus and hover away so no tooltip or focus ring depends on timing.
    await page.eval(`document.activeElement?.blur?.()`);
    await page.eval(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    await delay(900);
    // Entrances still playing jump to their end; endless animations (spinners, shimmers, glints) are parked at their
    // first frame, so every run paints the same pixels.
    // A pure rotation (a spinner) is stopped outright: a paused compositor rotation still lands on a different step each run.
    await page.eval(`document.getAnimations().forEach((a) => { try {
      if (a.effect?.getTiming?.().iterations !== Infinity) { if (a.playState === 'running') a.finish(); return; }
      const frames = a.effect.getKeyframes?.() ?? [];
      const rotation = frames.length > 0 && frames.every((f) => Object.keys(f).every((k) => ['offset', 'easing', 'composite', 'computedOffset', 'transform', 'rotate'].includes(k)));
      if (rotation && a.effect.target) a.effect.target.style.setProperty('animation', 'none', 'important');
      else { a.pause(); a.currentTime = 0; }
    } catch {} })`);
    await page.eval(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    await delay(300);
  }
  try {
    for (const screen of SCREENS) {
      if (only.length && !only.some((o) => screen.name.startsWith(o))) continue;
      for (const theme of THEMES) {
        const file = `${screen.name}-${theme}.png`;
        const started = Date.now();
        errors.length = 0;
        try {
          await load(theme);
          await screen.act(page);
          await settle();
          if (process.env.COUNCIL_DEBUG)
            console.log(
              await page.eval(
                `JSON.stringify(document.getAnimations().map((a) => [a.animationName || a.id || a.constructor.name, a.playState, a.effect?.getTiming?.().iterations, a.effect?.target?.className?.baseVal ?? String(a.effect?.target?.className).slice(0, 60)]))`,
              ),
            );
          window.webContents.invalidate();
          await delay(250);
          const image = await window.webContents.capturePage();
          fs.writeFileSync(path.join(outDir, file), image.toPNG());
          const { width, height } = image.getSize();
          results.push({ file, ok: true, ms: Date.now() - started, size: `${width}x${height}` });
          console.log(`ok   ${file} (${width}x${height}, ${Date.now() - started} ms)`);
        } catch (error) {
          results.push({ file, ok: false, error: String(error.message || error) });
          console.log(`FAIL ${file}: ${String(error.message || error).split("\n")[0]}`);
          if (process.env.COUNCIL_DEBUG) {
            fs.writeFileSync(path.join(outDir, `FAILED-${file}`), (await window.webContents.capturePage()).toPNG());
            console.log((await page.eval("document.body.innerText").catch(() => "")).slice(0, 3000));
          }
        }
        if (errors.length) console.log(`     console errors: ${errors.slice(0, 3).join(" | ")}`);
      }
    }
  } finally {
    if (blocked.size) console.log(`Blocked outside requests to: ${[...blocked].join(", ")}`);
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify({ width: WIDTH, height: HEIGHT, scale: SCALE, screens: SCREENS.map(({ name, what }) => ({ name, what })), results }, null, 2),
    );
    app.exit(results.some((r) => r.ok) ? 0 : 1);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Node side: Vite on a random port, then Electron; both are stopped at the end.
// ---------------------------------------------------------------------------------------------------------------------
/** An OS-assigned free port (ephemeral range, far from the user's own Vite on 5180 and the daemon's 8797/8798). */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = require("node:net").createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => (port > 8900 ? resolve(port) : freePort().then(resolve, reject)));
    });
  });
}

async function main() {
  const outDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), "milagre-council-desktop"));
  fs.mkdirSync(outDir, { recursive: true });
  const started = Date.now();
  process.chdir(ROOT);
  const { createServer } = await import("vite");
  const port = await freePort();
  const { useAsyncMiddleware } = require(path.join(ROOT, "scripts/async-middleware.cjs"));
  const server = await createServer({
    configFile: path.join(ROOT, "apps/desktop/vite.config.ts"),
    cacheDir: path.join(ROOT, "node_modules/.vite-design-council"),
    logLevel: "warn",
    server: { host: "127.0.0.1", port, strictPort: true, hmr: false },
    plugins: [
      {
        name: "design-council-fixture",
        resolveId: (id) => (id === "/__council.tsx" ? id : undefined),
        load: (id) => (id === "/__council.tsx" ? fixture : undefined),
        configureServer(s) {
          useAsyncMiddleware(s.middlewares, async (req, res, next) => {
            if (!req.url.startsWith("/__council/app")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(await s.transformIndexHtml(req.url, '<html><body><div id="root"></div><script type="module" src="/__council.tsx"></script></body></html>'));
          });
        },
      },
    ],
  });
  let child;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-council-electron-"));
  const stop = () => child && child.exitCode === null && child.kill("SIGTERM");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await server.listen();
    const url = `${server.resolvedUrls.local[0]}__council/app`;
    console.log(`Vite (ours) at ${url}`);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(require("electron"), [__filename, "--capture", url, outDir, userData], { env, stdio: "inherit" });
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (c) => resolve(c ?? 1));
    });
    process.exitCode = code;
  } finally {
    stop();
    await server.close();
    fs.rmSync(userData, { recursive: true, force: true });
    console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)} s -> ${outDir}`);
  }
}

if (process.versions.electron) {
  const i = process.argv.indexOf("--capture");
  capture(process.argv[i + 1], process.argv[i + 2], process.argv[i + 3]).catch((error) => {
    console.error(error);
    require("electron").app.exit(1);
  });
} else {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
