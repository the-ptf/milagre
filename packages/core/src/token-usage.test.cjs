const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createTokenUsageScan } = require("./token-usage-scan.cjs");
const { createTokenPricing, priceOf, slimPrices } = require("./token-usage-pricing.cjs");
const { buildReport, createTokenUsage } = require("./token-usage.cjs");

const HOUR = 3_600_000;
// Noon UTC on 2026-10-30, 9 AM in São Paulo.
const NOW = Date.parse("2026-10-30T12:00:00Z");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "token-usage-"));
}

const line = (value) => `${JSON.stringify(value)}\n`;
const claudeAssistant = ({
  id,
  request = "req_1",
  session = "s1",
  at = "2026-10-30T11:00:00Z",
  model = "claude-opus-5-5",
  cwd = "/repo",
  usage,
  entrypoint = "sdk-ts",
}) =>
  line({
    type: "assistant",
    sessionId: session,
    requestId: request,
    timestamp: at,
    cwd,
    entrypoint,
    message: { id, model, usage: usage ?? { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 50 } },
  });

function scanOf(dir) {
  return createTokenUsageScan({
    cacheFile: path.join(dir, "cache.json"),
    roots: async () => [
      { provider: "claude", dir: path.join(dir, "claude") },
      { provider: "codex", dir: path.join(dir, "codex") },
      { provider: "codex", dir: path.join(dir, "codex-archived") },
    ],
  });
}

test("a Claude message counts once though every content block repeats its usage", async () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, "claude", "-repo"), { recursive: true });
  const file = path.join(dir, "claude", "-repo", "s1.jsonl");
  fs.writeFileSync(
    file,
    claudeAssistant({ id: "msg_1" }) +
      claudeAssistant({ id: "msg_1" }) +
      line({ type: "user", message: { content: '{"type":"assistant"} quoted in a tool result' } }) +
      line({ type: "ai-title", sessionId: "s1", aiTitle: "Fix the login form" }) +
      claudeAssistant({ id: "msg_2", request: "req_2", model: "<synthetic>" }),
  );
  const scan = scanOf(dir);
  assert.equal(await scan.scan(), true);
  const rows = scan.rows();
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { ...rows[0] },
    {
      provider: "claude",
      hour: Math.floor(Date.parse("2026-10-30T11:00:00Z") / HOUR),
      model: "claude-opus-5-5",
      session: "s1",
      cwd: "/repo",
      title: "Fix the login form",
      milagre: true,
      input: 10,
      cacheRead: 1000,
      cacheWrite: 100,
      output: 50,
      reasoning: 0,
      requests: 1,
    },
  );
});

test("a later scan reads only what the transcript gained, and the cache carries it to a new run", async () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, "claude", "-repo"), { recursive: true });
  const file = path.join(dir, "claude", "-repo", "s1.jsonl");
  fs.writeFileSync(file, claudeAssistant({ id: "msg_1" }));
  const scan = scanOf(dir);
  await scan.scan();
  assert.equal(await scan.scan(), false);
  // A line half written when the scan runs waits for its newline.
  const next = claudeAssistant({ id: "msg_2", request: "req_2" });
  fs.appendFileSync(file, next.slice(0, 40));
  await scan.scan();
  assert.equal(scan.rows()[0].requests, 1);
  fs.appendFileSync(file, next.slice(40));
  await scan.scan();
  assert.equal(scan.rows()[0].requests, 2);
  await scan.idle();
  const reopened = scanOf(dir);
  assert.equal(reopened.finished(), true);
  assert.equal(reopened.rows()[0].requests, 2);
  assert.equal(await reopened.scan(), false);
});

test("Codex usage leaves cached input out of input, skips repeats and a fork's copied history, and survives archiving", async () => {
  const dir = tempDir();
  const day = path.join(dir, "codex", "2026", "10", "30");
  fs.mkdirSync(day, { recursive: true });
  const name = "rollout-2026-10-30T10-00-00-thread-1.jsonl";
  const tokenCount = (at, total, last) =>
    line({ timestamp: at, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: total }, last_token_usage: last } } });
  const last = { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 30, reasoning_output_tokens: 10, total_tokens: 1030 };
  fs.writeFileSync(
    path.join(day, name),
    line({ timestamp: "2026-10-30T10:00:00Z", type: "session_meta", payload: { id: "thread-1", cwd: "/repo", originator: "milagre" } }) +
      line({ timestamp: "2026-10-30T10:00:00Z", type: "session_meta", payload: { id: "parent" } }) +
      // Copied from the thread it forked from, before this one started.
      tokenCount("2026-10-30T09:00:00Z", 500, last) +
      line({ timestamp: "2026-10-30T10:00:01Z", type: "turn_context", payload: { model: "gpt-6-astra" } }) +
      tokenCount("2026-10-30T10:01:00Z", 1030, last) +
      tokenCount("2026-10-30T10:01:01Z", 1030, last) +
      tokenCount("2026-10-30T10:02:00Z", 2060, last),
  );
  const scan = scanOf(dir);
  await scan.scan();
  const [row] = scan.rows();
  assert.equal(scan.rows().length, 1);
  assert.equal(row.model, "gpt-6-astra");
  assert.equal(row.session, "thread-1");
  assert.equal(row.milagre, true);
  assert.equal(row.requests, 2);
  assert.equal(row.input, 400);
  assert.equal(row.cacheRead, 1600);
  assert.equal(row.reasoning, 20);
  // Codex moves an archived session's file; its rows aren't counted twice.
  fs.mkdirSync(path.join(dir, "codex-archived"), { recursive: true });
  fs.renameSync(path.join(day, name), path.join(dir, "codex-archived", name));
  await scan.scan();
  assert.equal(scan.rows().length, 1);
  assert.equal(scan.rows()[0].requests, 2);
});

test("prices match transcript model names with a date suffix or a provider prefix", () => {
  const models = slimPrices({
    "claude-haiku-4-5": { input_cost_per_token: 1e-6, output_cost_per_token: 5e-6, cache_read_input_token_cost: 1e-7 },
    "bedrock/claude-haiku-4-5": { input_cost_per_token: 9, output_cost_per_token: 9 },
    "no-output-price": { input_cost_per_token: 1e-6 },
  });
  assert.deepEqual(Object.keys(models), ["claude-haiku-4-5"]);
  assert.equal(models["claude-haiku-4-5"].cacheWrite, 1e-6);
  assert.equal(priceOf(models, "claude-haiku-4-5-20251001"), models["claude-haiku-4-5"]);
  assert.equal(priceOf(models, "us.anthropic.claude-haiku-4-5"), models["claude-haiku-4-5"]);
  assert.equal(priceOf(models, "sonnet"), null);
});

test("pricing never waits on the network and refreshes a missing list once", async () => {
  let fetches = 0;
  const pricing = createTokenPricing({
    fetchCatalog: async () => {
      fetches++;
      return { "gpt-6-astra": { input_cost_per_token: 1e-5, output_cost_per_token: 5e-5 } };
    },
    now: () => NOW,
  });
  assert.equal(pricing.current(), null);
  assert.equal(pricing.status().status, "loading");
  await pricing.idle();
  assert.equal(pricing.current().models["gpt-6-astra"].input, 1e-5);
  pricing.current();
  assert.equal(fetches, 1);
  assert.equal(pricing.status().status, "ok");
});

const prices = {
  "claude-opus-5-5": { input: 4e-6, cacheRead: 2e-7, cacheWrite: 5e-6, output: 2e-5 },
  "gpt-6-astra": { input: 1e-5, cacheRead: 1e-6, cacheWrite: 1e-5, output: 5e-5 },
};
const row = (patch) => ({
  provider: "claude",
  hour: Math.floor(NOW / HOUR) - 1,
  model: "claude-opus-5-5",
  session: "native-1",
  cwd: "/code/app",
  title: "",
  milagre: true,
  input: 1_000_000,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  requests: 1,
  ...patch,
});
const projects = [
  {
    path: "/code/app",
    name: "app",
    state: {
      worktrees: { 1: { path: "/code/app" }, 2: { path: "/home/.milagre/worktrees/app/fix-login-ab12" } },
      sessions: { 7: { id: 7, title: "Fix login", native_session_id: "native-1", native_sessions: { codex: "native-codex" } } },
    },
  },
];

test("the report prices rows and credits them to Chats, archived sessions, Worktrees and outside folders", () => {
  const report = buildReport({
    rows: [
      row({}),
      row({ provider: "codex", model: "gpt-6-astra", session: "native-codex", input: 0, output: 1_000_000 }),
      row({ session: "gone", cwd: "/home/.milagre/worktrees/app/let-s-design-a-pr-7tea", title: "T3-style PR visualizer" }),
      row({ session: "terminal", milagre: false }),
      row({ session: "x", cwd: "/elsewhere/tools", model: "mystery-model" }),
      row({ hour: Math.floor(NOW / HOUR) - 24 * 200 }),
    ],
    prices,
    projects,
    range: "7d",
    timeZone: "UTC",
    now: NOW,
    worktreeRoot: "/home/.milagre/worktrees",
  });
  assert.equal(report.totals.requests, 5);
  assert.equal(Math.round(report.totals.costUsd), 4 + 50 + 4 + 4);
  assert.equal(report.totals.unpricedTokens, 1_000_000);
  const [app, outside] = report.projects;
  assert.equal(app.name, "app");
  assert.equal(app.providers.codex.costUsd, 50);
  assert.deepEqual(
    app.chats.map((chat) => [chat.kind, chat.title, chat.sessionId]),
    [
      ["chat", "Fix login", 7],
      ["archived", "T3-style PR visualizer", undefined],
      ["outside", "Untitled session", undefined],
    ],
  );
  assert.deepEqual(app.chats[0].providers, ["claude", "codex"]);
  assert.equal(outside.name, "Outside Milagre");
  assert.equal(outside.milagre, false);
  assert.deepEqual([outside.chats[0].kind, outside.chats[0].title, outside.chats[0].detail], ["folder", "tools", "/elsewhere/tools"]);
  assert.equal(report.models.find((model) => model.model === "mystery-model").priced, false);
  assert.equal(report.calendar.length, 90);
  assert.equal(report.calendar.at(-1).key, "2026-10-30");
  assert.equal(report.series.length, 7);
});

test("two clones of one repository say which folder each sits in", () => {
  const clones = [
    { path: "/code/work/app", name: "app", state: null },
    { path: "/code/home/app", name: "app", state: null },
  ];
  const report = buildReport({
    rows: [row({ cwd: "/code/work/app" }), row({ cwd: "/code/home/app" })],
    prices,
    projects: clones,
    range: "7d",
    timeZone: "UTC",
    now: NOW,
  });
  assert.deepEqual(report.projects.map((project) => project.name).sort(), ["app · home", "app · work"]);
});

test("picked days replace the range, a single day reads by the hour, and the calendar keeps all 90 days", () => {
  const rows = [row({}), row({ hour: Math.floor(Date.parse("2026-10-16T15:00:00Z") / HOUR) })];
  const day = buildReport({ rows, prices, projects, range: "7d", days: { from: "2026-10-16", to: "2026-10-16" }, timeZone: "UTC", now: NOW });
  assert.deepEqual(day.days, { from: "2026-10-16", to: "2026-10-16" });
  assert.equal(day.resolution, "hour");
  assert.equal(day.series.length, 24);
  assert.equal(day.totals.requests, 1);
  assert.equal(day.calendar.filter((entry) => entry.tokens > 0).length, 2);
  const span = buildReport({ rows, prices, projects, range: "24h", days: { from: "2026-10-30", to: "2026-10-12" }, timeZone: "UTC", now: NOW });
  assert.deepEqual(span.days, { from: "2026-10-12", to: "2026-10-30" });
  assert.equal(span.series.length, 19);
  assert.equal(span.totals.requests, 2);
  const junk = buildReport({ rows, prices, projects, range: "30d", days: { from: "yesterday", to: "today" }, timeZone: "Not/AZone", now: NOW });
  assert.equal(junk.days, undefined);
  assert.equal(junk.series.length, 30);
});

test("a read answers from the cache, starts one scan and says when it changed something", async () => {
  const events = [];
  let scans = 0;
  let release;
  const scan = {
    scanning: () => Boolean(release),
    scannedAt: () => 0,
    finished: () => false,
    rows: () => [row({})],
    scan: () => {
      scans++;
      return new Promise((resolve) => {
        release = () => resolve(true);
      });
    },
  };
  const usage = createTokenUsage({
    scan,
    pricing: { current: () => ({ models: prices }), status: () => ({ status: "ok" }) },
    projects: async () => projects,
    emit: (channel) => events.push(channel),
    now: () => NOW,
  });
  const first = await usage.read({ range: "24h", timeZone: "UTC" });
  assert.equal(first.refreshing, true);
  assert.equal(first.firstScan, true);
  assert.equal(first.projects[0].chats[0].title, "Fix login");
  await usage.read({ range: "24h" });
  assert.equal(scans, 1);
  const done = release;
  release = null;
  done();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["token-usage:changed"]);
});
