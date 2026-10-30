// Themed surfaces gallery: the real App (sidebar, chat with a Shiki code block, Changes and its diff view, a real xterm
// Terminal, the design canvas) under ten themes, switched live through the app's own settings. Each surface asserts its
// computed colors against the registry's palette; set MILAGRE_SCREENSHOT_DIR for `<theme>-<surface>.png` images.
// Only the host bridge on window.milagre is stubbed (a Proxy, as in capture-readme.cjs; a fake terminals API that
// streams scripted ANSI output; fixed diffs and designs).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");
const { panelMenuHelpers } = require("./panel-menu-test.cjs");

const { designHtml } = require("@milagre/shared/design");

const projectPath = "/demo/milagre";
const CHAT_TITLES = { shell: "Phone pairing follow-ups", design: "A sidebar for mobile" };
const topics = [
  ["Phone pairing follow-ups", "feat/phone-pairing"],
  ["Find Projects from the phone", "feat/project-search"],
  ["A sidebar for mobile", "feat/mobile-sidebar"],
  ["Swipe between Chat and Changes", "feat/swipe-navigation"],
  ["Keep the Chat timer running", "fix/chat-timer"],
];
const reply = [
  "The pairing count lives in `usePairedPhones`. Resetting now asks first, and the hook reports how many phones it removed:",
  "",
  "```ts",
  "// Reset every paired phone, then tell the caller how many were removed.",
  "export async function resetPairedPhones(bridge: Bridge, confirm = true): Promise<number> {",
  "  const phones = await bridge.listPhones();",
  "  if (confirm && !window.confirm(`Remove ${phones.length} phones?`)) return 0;",
  "  for (const phone of phones) await bridge.revokePhone(phone.id);",
  "  return phones.length;",
  "}",
  "```",
  "",
  "- The sidebar badge reads the same hook, so it drops to zero at once.",
  "- Run `npm test -- --only phone` to check the flow.",
].join("\n");
const followUp = [
  "Here is the test as a diff, and the command that runs only that file:",
  "",
  "```diff",
  ' test("reset asks before it clears", async () => {',
  "-  expect(await resetPairedPhones(bridge)).toBe(0);",
  '+  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);',
  "+  expect(await resetPairedPhones(bridge)).toBe(0);",
  "+  expect(confirm).toHaveBeenCalledOnce();",
  " });",
  "```",
  "",
  "```bash",
  "npx vitest run apps/desktop/app/src/lib/phones.test.ts --reporter verbose",
  "```",
].join("\n");
const designReply = "Here are two screens for the mobile sidebar: the list of Chats, and a Chat open beside it.";
const step = (id, title) => ({
  id: `design-${id}`,
  kind: "artifact",
  title: `Showed \`${title}\``,
  status: "done",
  offset: 0,
  artifact: { id, version: 1, title, format: "design" },
});
const state = {
  next_id: 100,
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
topics.forEach(([title, branch], i) => {
  const id = i + 2;
  state.worktrees[id] = { id, project_id: 1, name: branch, path: `${projectPath}/${branch}`, base: "main" };
  state.sessions[id] = { id, worktree_id: id, title, agent_name: title, provider: i % 2 ? "claude" : "codex", status: "Stopped" };
  state.messages.push({ id: id * 10, session_id: id, role: "user", body: `Let's work on ${title.toLowerCase()}.`, context: null, model: "claude-sonnet-5-5" });
});
const message = (id, session_id, role, body, more = {}) => ({ id, session_id, role, body, context: null, model: "claude-sonnet-5-5", ...more });
state.messages.push(
  message(21, 2, "assistant", reply),
  message(22, 2, "user", "Good. Show me the test that should fail first, and how to run just that file."),
  message(23, 2, "assistant", followUp),
);
state.messages.push({
  id: 41,
  session_id: 4,
  role: "assistant",
  body: designReply,
  context: null,
  model: "claude-sonnet-5-5",
  steps: [step("chats", "Chat list"), step("open", "Chat open")],
});
const project = { path: projectPath, name: "Milagre", state };

const patch = (...lines) => lines.join("\n") + "\n";
const files = {
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

// One screen of a terminal: a prompt, `ls --color`, `git status` and a test run, then all sixteen ANSI colors.
const E = "\x1b[";
const terminalScript = [
  `${E}1;32mvictor@mac${E}0m:${E}1;34m~/milagre${E}0m$ ls --color`,
  `${E}1;34mapps${E}0m  ${E}1;34mpackages${E}0m  ${E}1;34mscripts${E}0m  ${E}1;36mCHANGELOG.md${E}0m  ${E}1;32mbuild.sh${E}0m  ${E}31mrelease.tar.gz${E}0m  ${E}1;35mlogo.png${E}0m  ${E}33mpackage.json${E}0m`,
  `${E}1;32mvictor@mac${E}0m:${E}1;34m~/milagre${E}0m$ git status -sb`,
  `${E}1m##${E}0m ${E}32mfeat/phone-pairing${E}0m...${E}31morigin/feat/phone-pairing${E}0m [ahead 2]`,
  ` ${E}32mM${E}0m apps/mobile/src/hooks/usePairedPhones.ts`,
  `${E}31m M${E}0m apps/desktop/app/src/components/PairedPhones.tsx`,
  `${E}31m??${E}0m apps/desktop/app/src/lib/phones.test.ts`,
  `${E}1;32mvictor@mac${E}0m:${E}1;34m~/milagre${E}0m$ npm test -- --only phone`,
  `${E}90m> milagre-monorepo@0.1.0 test${E}0m`,
  ` ${E}32m✓${E}0m reset removes every phone and says how many ${E}90m(12 ms)${E}0m`,
  ` ${E}32m✓${E}0m the sidebar badge follows the count ${E}90m(8 ms)${E}0m`,
  ` ${E}31m✗${E}0m ${E}1mreset asks before it clears${E}0m`,
  `   ${E}31mAssertionError:${E}0m expected ${E}32m1${E}0m, received ${E}31m0${E}0m ${E}33m(window.confirm was not called)${E}0m`,
  `   ${E}36mat${E}0m ${E}34mapps/desktop/app/src/lib/phones.test.ts:9:5${E}0m`,
  `${E}1;36mTests${E}0m 2 passed, ${E}1;31m1 failed${E}0m, ${E}1;33m1 skipped${E}0m ${E}35m(3 files)${E}0m`,
  `${E}1;32mvictor@mac${E}0m:${E}1;34m~/milagre${E}0m$ colors`,
  Array.from({ length: 8 }, (_, i) => `${E}${30 + i}m██${E}0m`).join(" ") + "   " + Array.from({ length: 8 }, (_, i) => `${E}${90 + i}m██${E}0m`).join(" "),
  Array.from({ length: 8 }, (_, i) => `${E}${40 + i}m  ${E}0m`).join(" ") + "   " + Array.from({ length: 8 }, (_, i) => `${E}${100 + i}m  ${E}0m`).join(" "),
  `${E}1;32mvictor@mac${E}0m:${E}1;34m~/milagre${E}0m$ `,
].join("\r\n");

const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '/src/App';
import { updateSettings } from '/src/lib/settings';
import { resolvePalette } from '@milagre/shared/themes';
import { Terminal } from '@xterm/xterm';
import '/src/styles.css';
window.addEventListener('error', e => console.error(e.error?.stack || e.message));
const opened = [];
const open = Terminal.prototype.open;
Terminal.prototype.open = function (element) { opened.push(this); return open.call(this, element); };
window.__gallery = {
  set: (colorTheme, theme) => updateSettings({ colorTheme, theme }),
  palette: (colorTheme, scheme) => resolvePalette(colorTheme, scheme),
  terminal: () => opened.find((term) => term.element?.isConnected),
  // A color as the browser computes it, so a palette value can be compared with getComputedStyle output.
  css: (property, value) => { const probe = document.createElement('i'); probe.style[property] = value; document.body.appendChild(probe); const out = getComputedStyle(probe)[property]; probe.remove(); return out; },
};
const project = ${JSON.stringify(project)};
const FILES = ${JSON.stringify(files)};
const entries = Object.entries(FILES).map(([path, f]) => ({ path, status: f.status, added: f.added, removed: f.removed, binary: false }));
const script = ${JSON.stringify(terminalScript)};
const terminalInfo = (chatId) => ({ id: 'term-1', chatId, title: 'zsh', cwd: '${projectPath}/feat/phone-pairing', label: 'phone-pairing', busy: false, cols: 100, rows: 14, createdAt: 1 });
const never = () => new Promise(() => {});
const designs = {
  chats: { title: 'Chat list', width: 390, height: 844, format: 'design', document: ${JSON.stringify(designChats())}, html: ${JSON.stringify(designHtml(designChats()))} },
  open: { title: 'Chat open', width: 390, height: 844, format: 'design', document: ${JSON.stringify(designOpen())}, html: ${JSON.stringify(designHtml(designOpen()))} },
};
const replies = {
  getCurrentProject: project, getRuns: {runs:{},seq:1}, getModels: {codex:null,claude:null,antigravity:null,kiro:null},
  getCliStatus: {codex:{state:'ready'},claude:{state:'ready'},antigravity:{state:'ready'},kiro:{state:'missing'}},
  getRuntimeConnection: {connected:true}, getLinkedWork: {delegations:[],negotiations:[],receiveOnly:[]},
  listRecentProjects: [{path:project.path,name:project.name}], listBranches: ['main'],
  getWorktreeRoots: [], getCachedUsage: {providers:[]}, readUsage: {providers:[]}, getAgentPorts: {},
  getProjectImage: null, getUpdateState: null, listSkills: {skills:[],warnings:[]}, listAgentPorts: [],
  readDiffStats: {}, getDiffStats: {}, readDesignsEnabled: {enabled: true},
};
window.milagre = new Proxy({}, {get(_, name) {
  if (name === 'git') return {
    diffStats: async () => ({ added: 12, removed: 6 }),
    diffFiles: async ({ mode }) => ({ isRepo: true, base: 'main', files: mode === 'committed' ? [] : entries }),
    diffFile: async ({ path }) => ({ patch: FILES[path].patch, binary: false, tooLarge: false }),
  };
  if (name === 'terminals') return {
    list: async ({ chatId }) => ({ terminals: window.__terminalOpen ? [terminalInfo(chatId)] : [] }),
    open: async ({ chatId }) => { window.__terminalOpen = true; return terminalInfo(chatId); },
    // The host's long poll: the scripted output once, then nothing more until the Terminal ends.
    read: async ({ after }) => (after === 0 ? { offset: script.length, data: script, reset: false, ended: false } : never()),
    input: async () => ({ accepted: true }),
    resize: async () => null,
    close: async () => null,
  };
  if (name === 'artifacts') return {
    list: async () => Object.entries(designs).map(([id, design]) => ({id, version: 1, versions: 1, ...design})),
    comments: async () => [],
    addComments: async () => [],
    get: async ({ id, version }) => ({ id, version: 1, versions: 1, latest: 1, ...designs[id] }),
  };
  if (name.startsWith('on')) return () => () => {};
  if (name === 'readPullRequest') return async () => null;
  if (name === 'readPullRequests') return async (_, paths) => paths.map(() => null);
  return async () => name in replies ? replies[name] : null;
}});
localStorage.setItem('milagre-settings', JSON.stringify({theme:'dark',defaultPermissionMode:'auto',notifyWhenWaiting:false,notifyOnCompletion:false,showDockBadge:false,showUsageInSidebar:false}));
localStorage.setItem('milagre.terminal.height', '420');
createRoot(document.getElementById('root')).render(<App />);
`;

function designChats() {
  const nodes = [{ id: "heading", type: "text", x: 20, y: 56, width: 350, height: 42, text: "Chats", fontSize: 30, fill: "#1d1b18" }];
  const rows = [
    ["Phone pairing follow-ups", "Testing the reset flow"],
    ["Find Projects from the phone", "Waiting for your answer"],
    ["A sidebar for mobile", "Stopped"],
    ["Swipe between Chat and Changes", "PR #184 ready to merge"],
  ];
  rows.forEach(([title, subtitle], i) => {
    const y = 116 + i * 88;
    nodes.push(
      { id: `row-${i}`, type: "rectangle", x: 20, y, width: 350, height: 78, radius: 16, fill: "#ffffff" },
      { id: `title-${i}`, type: "text", x: 36, y: y + 12, width: 306, height: 40, text: title, fontSize: 16, fontWeight: 700, fill: "#1d1b18" },
      { id: `subtitle-${i}`, type: "text", x: 36, y: y + 54, width: 306, height: 20, text: subtitle, fontSize: 13, fill: "#7a746c" },
    );
  });
  nodes.push({ id: "dot", type: "ellipse", x: 344, y: 132, width: 10, height: 10, fill: "#2f6f4f" });
  return { schemaVersion: 1, width: 390, height: 844, background: "#f6f4ef", nodes };
}
function designOpen() {
  const nodes = [{ id: "heading", type: "text", x: 20, y: 56, width: 350, height: 34, text: "A sidebar for mobile", fontSize: 22, fill: "#ffffff" }];
  ["Let's work on a sidebar for mobile.", "Opened the Chat list as a drawer; swipe right to reveal it.", "Nice. Keep the active Chat highlighted."].forEach(
    (text, i) => {
      const x = i === 1 ? 20 : 60;
      const y = 112 + i * 90;
      nodes.push(
        { id: `message-${i}`, type: "rectangle", x, y, width: 310, height: 80, radius: 18, fill: i === 1 ? "#2f6f4f" : "#354039" },
        { id: `text-${i}`, type: "text", x: x + 14, y: y + 12, width: 282, height: 56, text, fontSize: 15, fill: "#ffffff" },
      );
    },
  );
  nodes.push(
    { id: "prompt", type: "rectangle", x: 16, y: 764, width: 358, height: 52, radius: 24, fill: "#3a443f" },
    { id: "placeholder", type: "text", x: 34, y: 778, width: 322, height: 28, text: "Prompt or mention a file with @", fontSize: 16, fill: "#b5b9b6" },
  );
  return { schemaVersion: 1, width: 390, height: 844, background: "#1f2a24", nodes };
}

const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const close = (rgb, hex) => rgb.every((value, i) => Math.abs(value - hexRgb(hex)[i]) <= 3);
/** The pixel under a point given in CSS pixels, from a capture that may be at a higher device resolution. */
function pixelAt(image, x, y, cssWidth) {
  const { width } = image.getSize();
  const scale = width / cssWidth;
  const offset = (Math.round(y * scale) * width + Math.round(x * scale)) * 4;
  const bitmap = image.toBitmap();
  return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]];
}

const THEMES = [
  ["milagre-blue-dark", "milagre-blue", "dark"],
  ["milagre-blue-light", "milagre-blue", "light"],
  ["gray-dark", "gray", "dark"],
  ["catppuccin-mocha", "catppuccin-mocha", "dark"],
  ["catppuccin-latte", "catppuccin-mocha", "light"],
  ["dracula", "dracula", "dark"],
  ["nord", "nord", "dark"],
  ["gruvbox-dark", "gruvbox", "dark"],
  ["tokyo-night", "tokyo-night", "dark"],
  ["rose-pine-dawn", "rose-pine", "light"],
];

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "milagre-theming-gallery-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 1360, height: 900, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) =>
    window.webContents.executeJavaScript(source).catch((error) => {
      throw new Error(`${error.message}\n  in: ${source.slice(0, 300)}`);
    });
  const { evaluatePanel } = panelMenuHelpers(evaluate);
  const errors = [];
  window.webContents.on("console-message", (e) => {
    if (e.level === "error") errors.push(e.message);
  });
  const waitFor = async (source) => {
    for (let i = 0; i < 400; i++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw Error("Timed out: " + source);
  };
  const dir = process.env.MILAGRE_SCREENSHOT_DIR;
  const shot = async (name) => {
    if (!dir) return;
    fs.mkdirSync(dir, { recursive: true });
    await delay(250);
    window.webContents.invalidate();
    fs.writeFileSync(path.join(dir, name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  const open = async (title) => {
    await window.loadURL(process.argv[2] + "app");
    await waitFor(`!!document.querySelector('[data-row]')`);
    await evaluate(`[...document.querySelectorAll('[data-row]')].find((row) => row.textContent.includes(${JSON.stringify(title)})).click()`);
  };
  // Switches theme through the app's own settings and waits for its stylesheet; returns the palette for assertions.
  const applyTheme = async (colorTheme, mode) => {
    await evaluate(`window.__gallery.set(${JSON.stringify(colorTheme)}, ${JSON.stringify(mode)})`);
    const page = await evaluate(`window.__gallery.palette(${JSON.stringify(colorTheme)}, ${JSON.stringify(mode)}).page`);
    await waitFor(
      `getComputedStyle(document.documentElement).getPropertyValue('--page').trim() === ${JSON.stringify(page)} && !document.documentElement.classList.contains('theme-switching')`,
    );
    return evaluate(`window.__gallery.palette(${JSON.stringify(colorTheme)}, ${JSON.stringify(mode)})`);
  };
  const css = (property, value) => evaluate(`window.__gallery.css(${JSON.stringify(property)}, ${JSON.stringify(value)})`);
  const style = (selector, property) => evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)}))[${JSON.stringify(property)}]`);
  const surfaces = {
    shell: {
      title: CHAT_TITLES.shell,
      async ready() {
        await waitFor(`document.querySelectorAll('.markdown .code-token').length > 5`);
        await delay(300);
      },
      async check(p, label) {
        assert.equal(await style("body", "backgroundColor"), await css("backgroundColor", p.page), `${label}: the window is the theme's page`);
        const keyword = await evaluate(
          `getComputedStyle([...document.querySelectorAll('.markdown .code-token')].find((token) => token.textContent === 'export')).color`,
        );
        assert.equal(keyword, await css("color", p.syntax.keyword), `${label}: the code block's keyword color follows the theme`);
        assert.equal(await style("aside", "backgroundColor"), await css("backgroundColor", p.surface), `${label}: the sidebar is the theme's surface`);
      },
    },
  };
  surfaces.diff = {
    title: CHAT_TITLES.shell,
    async ready() {
      await evaluatePanel(`document.querySelector('[data-panel-toggle=changes]').click()`);
      await waitFor(`document.querySelectorAll('[data-diff-tree-file]').length === 3`);
      await evaluate(`document.querySelector('[data-diff-tree-file]').click()`);
      await waitFor(`document.querySelectorAll('[data-diff-file]').length === 3 && document.querySelectorAll('[data-diff-body] .code-token').length > 20`);
      await delay(600);
    },
    async check(p, label) {
      assert.equal(
        await style("[data-diff-file]", "backgroundColor"),
        await css("backgroundColor", p.surface),
        `${label}: a file's card is the theme's surface`,
      );
      assert.equal(
        await style("[data-diff-row=add]", "backgroundColor"),
        await css("backgroundColor", p.diffAdd),
        `${label}: added lines use the theme's add tint`,
      );
      assert.equal(
        await style("[data-diff-row=remove]", "backgroundColor"),
        await css("backgroundColor", p.diffRemove),
        `${label}: removed lines use the theme's remove tint`,
      );
      const keyword = await evaluate(
        `getComputedStyle([...document.querySelectorAll('[data-diff-body] .code-token')].find((token) => token.textContent === 'import')).color`,
      );
      assert.equal(keyword, await css("color", p.syntax.keyword), `${label}: the diff's keyword color follows the theme`);
    },
  };
  surfaces.terminal = {
    title: CHAT_TITLES.shell,
    async ready() {
      await evaluatePanel(`document.querySelector('[data-panel-toggle=terminal]').click()`);
      await waitFor(`!!document.querySelector('[data-terminal-panel] .xterm') && !document.querySelector('[data-terminal-slot][data-sliding]')`);
      await waitFor(
        `(() => { const t = window.__gallery.terminal(); return !!t && t.buffer.active.getLine(t.buffer.active.length - 1 - 0) !== undefined && [...Array(t.buffer.active.length).keys()].some((r) => t.buffer.active.getLine(r)?.translateToString(true).includes('Tests 2 passed')); })()`,
      );
      await delay(600);
    },
    async check(p, label) {
      assert.equal(
        await style("[data-terminal-panel]", "backgroundColor"),
        await css("backgroundColor", p.surface),
        `${label}: the panel is the theme's surface`,
      );
      const xterm = JSON.parse(await evaluate(`JSON.stringify(window.__gallery.terminal().options.theme)`));
      const names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
      names.forEach((name, i) => {
        assert.equal(xterm[name], p.ansi[i], `${label}: xterm ${name} is ANSI ${i}`);
        assert.equal(xterm["bright" + name[0].toUpperCase() + name.slice(1)], p.ansi[i + 8], `${label}: xterm bright ${name} is ANSI ${i + 8}`);
      });
      assert.equal(xterm.foreground, p.ink, `${label}: terminal text is the theme's ink`);
      assert.equal(xterm.cursor, p.cursor);
      assert.equal(xterm.selectionBackground, p.selection);
      // The buffer holds every one of the sixteen colors, so the strip below really exercises the palette.
      const used = await evaluate(
        `(() => { const t = window.__gallery.terminal(), b = t.buffer.active, seen = new Set(); for (let r = 0; r < b.length; r++) { const line = b.getLine(r); for (let c = 0; c < t.cols; c++) { const cell = line.getCell(c); if (cell.isFgPalette()) seen.add(cell.getFgColor()); if (cell.isBgPalette()) seen.add(cell.getBgColor()); } } return [...seen].sort((a, b) => a - b); })()`,
      );
      assert.deepEqual(
        used.filter((i) => i < 16),
        [...Array(16).keys()],
        `${label}: the output uses all sixteen ANSI colors`,
      );
      // And the terminal paints them: each background swatch's center pixel, read from the window's own capture, is the palette's color.
      // Only on macOS: Linux CI runners capture the terminal before its GPU layer composites, so the pixels read as background.
      if (process.platform !== "darwin") return;
      const geometry = await evaluate(
        `(() => { const t = window.__gallery.terminal(), b = t.buffer.active, box = t.element.querySelector('.xterm-screen').getBoundingClientRect(); let row = -1; for (let r = b.viewportY; r < b.viewportY + t.rows; r++) { const cell = b.getLine(r)?.getCell(0); if (cell?.isBgPalette() && cell.getBgColor() === 0) row = r - b.viewportY; } return { row, left: box.left, top: box.top, cw: box.width / t.cols, ch: box.height / t.rows, width: innerWidth }; })()`,
      );
      assert.ok(geometry.row >= 0, `${label}: the swatch row is on screen`);
      for (let i = 0; i < 16; i++) {
        const x = geometry.left + ((i < 8 ? i * 3 : 26 + (i - 8) * 3) + 1) * geometry.cw;
        const y = geometry.top + (geometry.row + 0.5) * geometry.ch;
        let seen;
        for (let attempt = 0; attempt < 40; attempt++) {
          seen = pixelAt(await window.webContents.capturePage(), x, y, geometry.width);
          if (close(seen, p.ansi[i])) break;
          await delay(100);
        }
        assert.ok(close(seen, p.ansi[i]), `${label}: swatch ${i} paints ${p.ansi[i]}, got rgb(${seen})`);
      }
    },
  };
  surfaces.design = {
    title: CHAT_TITLES.design,
    async ready() {
      await waitFor(`document.querySelectorAll('[data-slot=artifact-thumb] iframe').length === 2`);
      await evaluate(`document.querySelector('[data-slot=artifact-thumb]').click()`);
      await waitFor(`document.querySelectorAll('[data-slot=artifact-frame] iframe').length === 2`);
      await evaluate(`document.querySelector('[data-slot=artifact-dock] [aria-label="Fit every design"]').click()`);
      await delay(1200);
    },
    async check(p, label) {
      assert.equal(
        await style("[data-slot=artifact-canvas]", "backgroundColor"),
        await css("backgroundColor", p.canvas),
        `${label}: the canvas is the theme's canvas`,
      );
      assert.equal(await style("body", "backgroundColor"), await css("backgroundColor", p.page), `${label}: the window is the theme's page`);
      assert.equal(
        await style("[data-slot=artifact-dock] header [aria-label='Close designs']", "color"),
        await css("color", p.ink2),
        `${label}: toolbar icons use the secondary ink`,
      );
    },
  };
  try {
    for (const [name, surface] of Object.entries(surfaces)) {
      await open(surface.title);
      await surface.ready();
      for (const [label, colorTheme, mode] of THEMES) {
        const palette = await applyTheme(colorTheme, mode);
        await surface.check(palette, `${label} ${name}`);
        await shot(`${label}-${name}`);
      }
    }
    assert.deepEqual(errors, []);
    console.log(
      `PASS: ${THEMES.length} themes x ${Object.keys(surfaces).length} surfaces (chat with code, diff, terminal, design canvas) take the theme's page, surface, canvas, diff tints, syntax and all sixteen ANSI colors`,
    );
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(errors);
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: path.resolve(__dirname, "../apps/desktop/vite.config.ts"),
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-theming-gallery"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "theming-gallery-fixture",
        resolveId: (id) => (id === "/__gallery-app.tsx" ? id : undefined),
        load: (id) => (id === "/__gallery-app.tsx" ? fixture : undefined),
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__gallery/app") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__gallery-app.tsx"></script></body></html>',
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
    const child = require("node:child_process").spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__gallery/`], {
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
  if (process.versions.electron) require("electron").app.exit(1);
  else process.exitCode = 1;
});
