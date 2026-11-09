// Design council phone fixture: a real Milagre daemon + mobile bridge on loopback, seeded with a fixed demo Project
// whose Chats come from a scripted agent. No provider account, network call or personal data is used.
//
//   node scripts/design-council/fixture.cjs            # bridge on 127.0.0.1:8901, data under /tmp/council/fixture
//
// Env: COUNCIL_FIXTURE_PORT (8901), COUNCIL_FIXTURE_ROOT (/tmp/council/fixture), COUNCIL_FIXTURE_TOKEN (fixed demo token).
// The root is wiped and rebuilt on every start, so every round sees the same Project, Chats and uncommitted diff.
// It writes <root>/connection.json ({ url, token, project, chats }) for capture-phone.sh and stays up until SIGINT/SIGTERM.
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const zlib = require("node:zlib");
const repo = path.resolve(__dirname, "../..");
const { startDaemon } = require(path.join(repo, "apps/daemon/src/server.cjs"));
const { startMobileBridge } = require(path.join(repo, "apps/daemon/src/mobile-bridge.cjs"));
const { connect } = require(path.join(repo, "apps/daemon/src/client.cjs"));
const { demoRuntimeOptions } = require(path.join(repo, "apps/daemon/src/demo-agent.cjs"));

const PORT = Number(process.env.COUNCIL_FIXTURE_PORT || 8901);
const ROOT = path.resolve(process.env.COUNCIL_FIXTURE_ROOT || "/tmp/council/fixture");
// Public demo token: the bridge only listens on loopback and serves throwaway data.
const TOKEN = process.env.COUNCIL_FIXTURE_TOKEN || "c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf";

// Static model lists so the model picker has realistic content. Nothing calls a provider.
const effortsClaude = ["low", "medium", "high", "max"];
const effortsCodex = ["low", "medium", "high"];
// Ids from the app's own catalog (packages/shared/src/model-options.ts), so the picker shows them by name.
const model = (id, name, description, efforts, more = {}) => ({ id, name, description, efforts, ultracode: false, fastMode: false, ...more });
const MODELS = {
  claude: [
    model("claude-opus-5-5", "Opus 5.5", "For complex work and everyday tasks", effortsClaude, {
      recommended: true,
      defaultEffort: "high",
      ultracode: true,
      fastMode: true,
    }),
    model("claude-fable-5-1", "Fable 5.1", "For your toughest challenges", effortsClaude, { defaultEffort: "high", ultracode: true }),
    model("claude-sonnet-5-5", "Sonnet 5.5", "Most efficient for simpler tasks", effortsClaude, { defaultEffort: "medium" }),
    model("claude-haiku-4-5", "Haiku 4.5", "Fastest for quick answers", []),
  ],
  codex: [
    model("gpt-6.1-sol", "GPT-6.1-Sol", "Latest generation workhorse model", effortsCodex, { recommended: true, defaultEffort: "medium", fastMode: true }),
    model("gpt-6-astra", "GPT-6-Astra", "Frontier intelligence for the most demanding work", effortsCodex, { defaultEffort: "high" }),
    model("gpt-6-luna", "GPT-6-Luna", "Fast and affordable model for easier tasks", effortsCodex, { defaultEffort: "low" }),
  ],
  antigravity: null,
  kiro: null,
};

const FILES = {
  "README.md": "# Fieldnotes\n\nA small notes app used as a design-review fixture.\n",
  "package.json": JSON.stringify({ name: "fieldnotes", version: "2.3.0", private: true, scripts: { test: "vitest run" } }, null, 2) + "\n",
  "src/auth/session.ts": [
    'import { readCookie } from "../lib/cookies";',
    "",
    "export type Session = { userId: string; expiresAt: number };",
    "",
    "export function currentSession(): Session | null {",
    '  const raw = readCookie("fn_session");',
    "  if (!raw) return null;",
    "  return JSON.parse(raw) as Session;",
    "}",
    "",
    "export function loginRedirect(path: string): string {",
    '  return "/login";',
    "}",
    "",
  ].join("\n"),
  "src/lib/cookies.ts":
    "export function readCookie(name: string): string | null {\n  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));\n  return match ? decodeURIComponent(match[1]) : null;\n}\n",
  "src/screens/Settings.tsx": 'export function Settings() {\n  return <main className="settings">Settings</main>;\n}\n',
};

// What the working tree looks like after the agent's "fix": shown on the Changes screen.
const CHANGED = {
  "src/auth/session.ts": [
    'import { readCookie } from "../lib/cookies";',
    "",
    "export type Session = { userId: string; expiresAt: number };",
    "",
    "export function currentSession(now = Date.now()): Session | null {",
    '  const raw = readCookie("fn_session");',
    "  if (!raw) return null;",
    "  const session = JSON.parse(raw) as Session;",
    "  // An expired cookie is no session: callers send the user to sign in again.",
    "  return session.expiresAt > now ? session : null;",
    "}",
    "",
    "export function loginRedirect(path: string): string {",
    '  const next = path.startsWith("/") && !path.startsWith("//") ? path : "/";',
    "  return `/login?next=${encodeURIComponent(next)}`;",
    "}",
    "",
  ].join("\n"),
  "src/auth/session.test.ts": [
    'import { describe, expect, it } from "vitest";',
    'import { loginRedirect } from "./session";',
    "",
    'describe("loginRedirect", () => {',
    '  it("keeps the page the user was on", () => {',
    '    expect(loginRedirect("/notes/42")).toBe("/login?next=%2Fnotes%2F42");',
    "  });",
    "",
    '  it("drops off-site targets", () => {',
    '    expect(loginRedirect("//evil.example")).toBe("/login?next=%2F");',
    "  });",
    "});",
    "",
  ].join("\n"),
  "README.md":
    "# Fieldnotes\n\nA small notes app used as a design-review fixture.\n\nSigned-out visitors return to the page they asked for after signing in.\n",
};

const MAIN_REPLY = [
  "Found it: `currentSession()` never checked `expiresAt`, and the redirect dropped the page.",
  "",
  "## What changed",
  "",
  "- **Expired sessions** now return `null`.",
  "- **Redirects** keep the page in `?next=`.",
  "",
  "```ts",
  "const next = safePath(path);",
  "return `/login?next=${next}`;",
  "```",
  "",
  "All 14 tests pass.",
].join("\n");

// Token usage: a fixed, made-up report. Core's own reader would scan ~/.claude and ~/.codex on this Mac (the owner's
// real spend) and fetch a price list, so the fixture answers instead. The shape repeats every round.
const PATTERN = [0, 0, 0, 0, 0, 0, 0, 0, 2, 5, 9, 6, 3, 8, 12, 7, 4, 6, 3, 1, 0, 0, 0, 0];
function totals(tokens, costUsd) {
  const input = Math.round(tokens * 0.2),
    cacheRead = Math.round(tokens * 0.7),
    output = tokens - input - cacheRead;
  return {
    input,
    cacheRead,
    cacheWrite: 0,
    output,
    reasoning: 0,
    requests: Math.round(tokens / 40000),
    costUsd,
    cost: { input: costUsd * 0.4, cacheRead: costUsd * 0.2, cacheWrite: 0, output: costUsd * 0.4 },
    cacheSavingsUsd: costUsd * 0.6,
    unpricedTokens: 0,
  };
}
function fakeTokenUsage(project, chats) {
  return {
    async read(request = {}) {
      const range = ["24h", "7d", "30d", "90d"].includes(request.range) ? request.range : "24h";
      const hour = 3600e3,
        day = 24 * hour;
      // Hours are laid on the local day (the requested one, else today) so each bar lands on the same hour every round.
      const midnight = request.days?.from ? new Date(`${request.days.from}T00:00:00`) : new Date(new Date().setHours(0, 0, 0, 0));
      const until = range === "24h" ? midnight.getTime() + day : Math.ceil(Date.now() / day) * day;
      const hourly = range === "24h";
      const count = hourly ? 24 : Number(range.replace("d", ""));
      const step = hourly ? hour : day;
      const series = Array.from({ length: count }, (_, i) => {
        const weight = hourly ? PATTERN[i] : PATTERN[(i * 5) % 24] + 2;
        const start = until - (count - i) * step;
        return {
          start,
          key: new Date(start).toISOString(),
          providers: weight ? { claude: { tokens: weight * 180000, costUsd: weight * 0.21 }, codex: { tokens: weight * 60000, costUsd: weight * 0.04 } } : {},
        };
      });
      const tokens = series.reduce((sum, b) => sum + Object.values(b.providers).reduce((a, p) => a + p.tokens, 0), 0);
      const cost = Math.round(series.reduce((sum, b) => sum + Object.values(b.providers).reduce((a, p) => a + p.costUsd, 0), 0) * 100) / 100;
      const calendar = Array.from({ length: 90 }, (_, i) => {
        const start = Math.floor(Date.now() / day) * day - (89 - i) * day;
        const weight = PATTERN[(i * 7) % 24];
        return { key: new Date(start).toISOString().slice(0, 10), start, tokens: weight * 900000, costUsd: weight * 1.1 };
      });
      const all = totals(tokens, cost);
      return {
        range,
        timeZone: request.timeZone || "UTC",
        resolution: hourly ? "hour" : "day",
        since: until - count * step,
        until,
        generatedAt: until,
        refreshing: false,
        firstScan: false,
        pricing: { status: "ok" },
        totals: all,
        series,
        calendar,
        providers: [
          { provider: "claude", totals: totals(Math.round(tokens * 0.75), Math.round(cost * 84) / 100) },
          { provider: "codex", totals: totals(Math.round(tokens * 0.25), Math.round(cost * 16) / 100) },
        ],
        models: [{ provider: "claude", model: "claude-opus-5-5", priced: true, totals: totals(Math.round(tokens * 0.75), Math.round(cost * 84) / 100) }],
        projects: [
          {
            path: project,
            name: "Fieldnotes",
            milagre: true,
            totals: all,
            providers: { claude: { tokens, costUsd: cost } },
            count: chats.length,
            chats: chats.map((chat) => ({
              sessionId: chat.id,
              kind: "chat",
              title: chat.title,
              providers: ["claude"],
              totals: totals(Math.round(tokens / chats.length), Math.round((cost / chats.length) * 100) / 100),
              lastAt: until - hour,
            })),
          },
        ],
      };
    },
  };
}

// Each prompt (matched by a keyword) plays a fixed script of steps and text.
function script(prompt, cwd) {
  const file = (rel) => path.join(cwd, rel);
  if (/redirect/i.test(prompt))
    return [
      { text: "I'll trace how the app decides a session is still valid, then fix the redirect.\n\n" },
      { step: { kind: "read", title: "Read `session.ts`", file: file("src/auth/session.ts") }, ms: 120 },
      { step: { kind: "search", title: "Searched for `loginRedirect` in `src`" }, ms: 340, note: "3 results" },
      { step: { kind: "read", title: "Read `cookies.ts`", file: file("src/lib/cookies.ts") }, ms: 90 },
      {
        step: {
          kind: "edit",
          title: "Edited `session.ts`",
          file: file("src/auth/session.ts"),
          detail:
            '--- a/src/auth/session.ts\n+++ b/src/auth/session.ts\n@@ -5,9 +5,13 @@\n-export function currentSession(): Session | null {\n+export function currentSession(now = Date.now()): Session | null {\n   const raw = readCookie("fn_session");\n   if (!raw) return null;\n-  return JSON.parse(raw) as Session;\n+  const session = JSON.parse(raw) as Session;\n+  return session.expiresAt > now ? session : null;\n }\n',
        },
        ms: 210,
      },
      { step: { kind: "edit", title: "Wrote `session.test.ts`", file: file("src/auth/session.test.ts") }, ms: 160 },
      {
        step: {
          kind: "shell",
          title: "Ran `npm test`",
          detail: "$ npm test\n\n ✓ src/auth/session.test.ts (2)\n ✓ src/notes/store.test.ts (12)\n\n Test Files  2 passed (2)\n      Tests  14 passed (14)\n",
        },
        ms: 4200,
        note: "14 passed",
      },
      { text: MAIN_REPLY },
    ];
  if (/dark mode/i.test(prompt))
    return [
      { step: { kind: "read", title: "Read `Settings.tsx`", file: file("src/screens/Settings.tsx") }, ms: 80 },
      {
        text: "Settings has no theme control yet. I'd add a **System / Light / Dark** picker that writes to `localStorage` and sets `data-theme` on `<html>`. Shall I go ahead?",
      },
    ];
  if (/release notes/i.test(prompt))
    return [
      {
        step: {
          kind: "shell",
          title: "Ran `git log --oneline v2.2.0..HEAD`",
          detail: "$ git log --oneline v2.2.0..HEAD\n9f1c2ab Faster note search\n41d0e7e Offline drafts\n",
        },
        ms: 300,
        note: "2 commits",
      },
      {
        text: "### Fieldnotes 2.3\n\n- Search is about twice as fast on large notebooks.\n- Drafts are kept while you're offline and sync when you reconnect.",
      },
    ];
  return [{ text: "Done. The onboarding copy now fits on one screen at the smallest text size." }];
}

function scriptedSession(cwd) {
  return function createSession(_provider, { emit }) {
    let sequence = 0;
    const session = {
      closed: false,
      turnActive: false,
      nativeId: "design-council-fixture",
      async startTurn({ prompt }) {
        const turnId = `council-${++sequence}`;
        session.turnActive = true;
        emit({ type: "session-started", nativeId: session.nativeId });
        emit({ type: "turn-started", turnId });
        void (async () => {
          let n = 0;
          for (const part of script(String(prompt), cwd)) {
            if (part.text) emit({ type: "text-delta", text: part.text });
            if (part.step) {
              const id = `${turnId}-step-${++n}`;
              emit({ type: "step-started", step: { id, ...part.step } });
              await delay(20);
              emit({ type: "step-completed", id, status: "done", durationMs: part.ms, ...(part.note ? { note: part.note } : {}) });
            }
            await delay(20);
          }
          session.turnActive = false;
          emit({ type: "turn-completed" });
        })();
        return { turnId };
      },
      async interrupt() {
        if (session.turnActive) emit({ type: "turn-cancelled" });
        session.turnActive = false;
      },
      async close() {
        session.turnActive = false;
        session.closed = true;
      },
    };
    return session;
  };
}

// The Project's own icon (public/logo.png), so Milagre never falls back to the signed-in GitHub user's avatar.
// A 128 px amber tile with a white notebook mark, drawn here so the fixture carries no image asset.
function logoPng(size = 128) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const inPage = x >= 38 && x < 92 && y >= 28 && y < 100;
      const line = inPage && x >= 48 && x < 84 && [46, 60, 74].some((top) => y >= top && y < top + 6);
      const [r, g, b] = inPage && !line ? [255, 255, 255] : [232, 145, 46];
      row.set([r, g, b, 255], 1 + x * 4);
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body) >>> 0, 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function writeFiles(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), body);
  }
}

async function waitIdle(client, project, sessionId) {
  const key = `${project}#${sessionId}`;
  for (let i = 0; i < 300; i++) {
    const runs = await client.call("chat:runs", []).catch(() => null);
    if (runs && !runs.runs?.[key]) return;
    await delay(50);
  }
  throw new Error(`Chat ${key} did not finish`);
}

async function main() {
  if (!/council/.test(ROOT)) throw new Error("COUNCIL_FIXTURE_ROOT must contain 'council' (it is wiped on start).");
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(ROOT, { recursive: true });
  const root = await fs.realpath(ROOT);
  const project = path.join(root, "Fieldnotes");
  const dataDir = path.join(root, "profile");
  await fs.mkdir(project);
  const git = (...args) =>
    execFileSync("git", ["-C", project, "-c", "user.name=Fieldnotes Demo", "-c", "user.email=demo@example.invalid", ...args], { stdio: "ignore" });
  execFileSync("git", ["init", "-qb", "main", project]);
  await writeFiles(project, { ...FILES, "public/logo.png": logoPng(), ".gitignore": ".milagre/\nnode_modules/\n" });
  git("add", "-A");
  git("commit", "-qm", "Fieldnotes 2.3");

  // Filled in once the Chats exist; the token usage report reads it lazily.
  const chatList = [];
  const runtimeOptions = {
    ...demoRuntimeOptions({ cwd: project, worktreeRoot: path.join(root, "worktrees") }),
    createSession: scriptedSession(project),
    agentModels: async () => MODELS,
    tokenUsage: fakeTokenUsage(project, chatList),
    agentCliStatus: Object.assign(
      async () => ({ claude: { state: "ready" }, codex: { state: "ready" }, antigravity: { state: "missing" }, kiro: { state: "missing" } }),
      { invalidate() {} },
    ),
  };
  // "Keep the Mac awake" already on, so opening a Chat doesn't ask (the fixture's keepAwake is core's no-op stub).
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, "keep-awake.json"), JSON.stringify({ enabled: true }));
  const daemon = await startDaemon({ dataDir, version: "0.1.0-council", runtimeOptions });
  const client = await connect({ dataDir });
  const opened = await client.call("project:open", [project]);
  const first = Object.values(opened.state.sessions)[0];
  const worktreeId = first.worktree_id;

  // Oldest first, so the main Chat is the most recent row in the list.
  const chats = [
    { title: "Polish onboarding copy", body: "Tighten the onboarding copy so it fits one screen.", provider: "codex", model: "gpt-6.1-sol" },
    { title: "Release notes for 2.3", body: "Draft release notes for 2.3 from the git log.", provider: "codex", model: "gpt-6.1-sol" },
    // The one Chat left unread: the capture never opens it, so the list looks the same every round.
    { title: "Dark mode in Settings", body: "Can we add dark mode to the settings page?", provider: "claude", model: "claude-sonnet-5-5", unread: true },
    {
      title: "Fix the expired-session redirect",
      body: "Expired sessions land on a blank page, and signing in loses the page you were on. Can you fix the redirect?",
      provider: "claude",
      model: "claude-opus-5-5",
    },
  ];
  const ids = {};
  for (const [i, chat] of chats.entries()) {
    const request = { projectPath: project, body: chat.body, provider: chat.provider, model: chat.model, permissionMode: "auto" };
    const { sessionId } = await client.call("chat:send", [i === 0 ? { ...request, sessionId: first.id } : { ...request, worktreeId }]);
    await waitIdle(client, project, sessionId);
    await client.call("chat:patch", [project, sessionId, { title: chat.title, unread: chat.unread === true }]);
    ids[chat.title] = sessionId;
    chatList.push({ id: sessionId, title: chat.title });
  }
  // The "fix" the main Chat describes, left uncommitted for the Changes screen.
  await writeFiles(project, CHANGED);

  const bridge = await startMobileBridge({ dataDir, port: PORT, token: TOKEN });
  const mainChatId = ids["Fix the expired-session redirect"];
  const details = {
    url: bridge.url,
    token: TOKEN,
    project,
    worktreeId,
    mainChatId,
    mainProvider: "claude",
    mainModel: "claude-opus-5-5",
    chats: ids,
    pid: process.pid,
    pair: `milagre://pair?address=${encodeURIComponent(bridge.url)}&token=${TOKEN}&name=${encodeURIComponent("Design Council Mac")}`,
  };
  await fs.writeFile(path.join(root, "connection.json"), JSON.stringify(details, null, 2) + "\n");
  console.log(`Design council fixture ready on ${bridge.url}\n${path.join(root, "connection.json")}`);
  let closing;
  const close = () =>
    (closing ??= (async () => {
      await bridge.close();
      client.close();
      await daemon.close();
      process.exit(0);
    })());
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
