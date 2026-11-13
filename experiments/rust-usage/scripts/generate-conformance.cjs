#!/usr/bin/env node
// Executes original pure Node functions in a sandbox. All scanner input is synthetic and under a fresh temp dir.
// No credential reader, child process or network transport is available in the sandbox.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../../..");
const base = path.join(root, "packages/core/src");
const shared = (name) => require(path.join(root, "packages/shared/src", name + ".mjs"));
const loaded = new Map();
const extras = {
  "usage.cjs": "claudeWindows, codexWindows, retryAfterMs, withLastGood, providerResult, bankedResetsOf",
  "token-usage-scan.cjs": "claudeLine, codexLine, readLines, promptTitle, pruneRows",
};
function load(name) {
  if (loaded.has(name)) return loaded.get(name);
  const module = { exports: {} };
  const localRequire = (id) => {
    if (id === "node:fs") return fs;
    if (id === "node:fs/promises") return fs.promises;
    if (id === "node:path") return path;
    if (id === "node:os") return { homedir: () => "/fixture/home" };
    if (id === "node:child_process" || id.startsWith("./agents/")) return {};
    if (id.startsWith("@milagre/shared/")) return shared(id.slice("@milagre/shared/".length));
    if (id.startsWith("./")) return load(id.slice(2));
    throw new Error("Blocked module: " + id);
  };
  const source = fs.readFileSync(path.join(base, name), "utf8") + (extras[name] ? `\nObject.assign(module.exports, {${extras[name]}});` : "");
  vm.runInNewContext(
    source,
    { module, require: localRequire, Buffer, console, setImmediate, setTimeout, clearTimeout, process: { platform: "fixture", env: {} }, AbortSignal },
    { filename: name },
  );
  loaded.set(name, module.exports);
  return module.exports;
}
const zones = Object.fromEntries(
  require("./timezone-names.json").map((zone) => {
    try {
      return [zone.toLowerCase(), new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone];
    } catch {
      return [zone.toLowerCase(), null];
    }
  }),
);
fs.writeFileSync(path.join(__dirname, "../src/timezones.json"), JSON.stringify(zones, null, 2) + "\n");
const clone = (value) => JSON.parse(JSON.stringify(value));
const now = Date.parse("2026-10-30T12:00:00Z");
const out = { now, limits: [], pricing: [], transcripts: [], stores: [], reader: [], reports: [], scans: [], codex: [], claudeResponses: [], priceState: [] };
const usage = load("usage.cjs"),
  cache = load("usage-cache.cjs"),
  scanner = load("token-usage-scan.cjs"),
  price = load("token-usage-pricing.cjs");
function capture(kind, input, result) {
  out[kind].push({ input: clone(input), expected: clone(result) });
}
async function main() {
  for (const body of [
    null,
    {},
    { five_hour: { utilization: 150, resets_at: "bad" }, seven_day: { utilization: -3 } },
    { limits: [] },
    {
      limits: [
        { kind: "weekly_scoped", percent: 66, scope: { model: { display_name: "Fable" } } },
        { kind: "weekly_all", percent: 25, resets_at: "2026-11-01T00:00:00Z" },
        { kind: "session", percent: 2.5 },
        { kind: "weekly_scoped", percent: "2", scope: { model: { display_name: "Skip" } } },
      ],
    },
  ])
    capture("limits", { fn: "claude", body }, usage.claudeWindows(body));
  for (const body of [
    {},
    { primary: { usedPercent: 2, windowDurationMins: 300, resetsAt: 1793365200 }, secondary: { usedPercent: 30, windowDurationMins: 10080 } },
    { primary: { usedPercent: 101, windowDurationMins: 1440 }, secondary: { usedPercent: -2, windowDurationMins: 45, resetsAt: 0 } },
    { primary: { usedPercent: "4", windowDurationMins: 5 }, secondary: { usedPercent: 4, windowDurationMins: 2.5 } },
  ])
    capture("limits", { fn: "codex", body }, usage.codexWindows(body));
  for (const header of [null, "", "0", "120", "999999", "junk", " Fri, 30 Oct 2026 12:01:30 GMT ", "Fri, 30 Oct 2026 11:00:00 GMT"])
    capture("limits", { fn: "retry", header, now }, usage.retryAfterMs(header, now));
  for (const body of [
    {},
    {
      groups: [
        {
          displayName: "Gemini models",
          buckets: [
            { bucketId: "gemini-weekly", remainingFraction: 0.4, resetTime: "2026-11-01T00:00:00Z" },
            { bucketId: "gemini-5h", remainingFraction: 1.2 },
            { bucketId: "gemini-5h", remainingFraction: 0.5, disabled: true },
          ],
        },
      ],
    },
    {
      summary: {
        groups: [
          { name: "Other", buckets: [{ bucketId: "gemini-5h", remainingFraction: -1, resetTime: "junk" }] },
          { name: "GPT", buckets: [{ bucketId: "gpt-5h", remainingFraction: 0.2 }] },
        ],
      },
    },
  ])
    capture("limits", { fn: "gemini", body }, load("antigravity-usage.cjs").geminiWindows(body));
  for (const text of [
    "",
    "Estimated Usage | resets on 2026-11-01 | KIRO POWER\nCredits (452.97 of 10000 covered in plan), 4.5%",
    "\x1b[31mCredits (1,234.56 of 2,000), 62%\x1b[0m",
    "Credits (0 of 0), 9.25%",
  ])
    capture("limits", { fn: "kiro", text }, load("kiro-usage.cjs").parseKiroUsage(text));
  for (const status of [200, 401, 429, 500]) {
    for (const body of [{ five_hour: { utilization: 42, resets_at: "2026-11-01T00:00:00Z" } }, {}]) {
      const result = await usage.readClaudeUsage({
        platform: "fixture",
        home: "/fixture",
        now: () => now,
        readFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: "fixture-only", expiresAt: now + 1000 } }),
        fetchImpl: async () => ({ status, ok: status >= 200 && status < 300, headers: { get: () => "120" }, json: async () => body }),
      });
      capture("claudeResponses", { status, body, retry: "120", now }, result);
    }
  }
  const { EventEmitter } = require("node:events");
  for (const account of [null, { type: "apiKey" }, { type: "chatgpt" }]) {
    const sent = [],
      chunks = [],
      kills = [];
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin = new EventEmitter();
    child.kill = (s) => kills.push(s);
    child.stdin.write = (raw) => {
      const msg = JSON.parse(raw);
      sent.push(msg);
      let answer;
      if (msg.id === 1) answer = { id: 1, result: {} };
      if (msg.id === 2) answer = { id: 2, result: { account } };
      if (msg.id === 3)
        answer = {
          id: 3,
          result: { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1793365200 } }, rateLimitResetCredits: { availableCount: 3 } },
        };
      if (answer)
        setImmediate(() => {
          const text = "junk\n" + JSON.stringify(answer) + "\n";
          for (const chunk of [text.slice(0, 8), text.slice(8)]) {
            chunks.push(chunk);
            child.stdout.emit("data", Buffer.from(chunk));
          }
        });
    };
    const result = await usage.readCodexUsage({ command: "fixture-codex", spawnCommandImpl: () => child, now: () => now });
    capture("codex", { chunks, now }, { sent, kills, result });
  }
  let pricingClock = now;
  let catalogAnswer = { model: { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } };
  let downloads = 0;
  const pricingState = price.createTokenPricing({
    now: () => pricingClock,
    fetchCatalog: async () => {
      downloads++;
      if (catalogAnswer === null) throw Error("fixture");
      return catalogAnswer;
    },
  });
  for (const step of [
    { at: now, ok: true },
    { at: now + 86400000, ok: true },
    { at: now + 86400001, ok: false },
    { at: now + 86400002, ok: true },
    { at: now + 87300001, ok: true },
  ]) {
    pricingClock = step.at;
    catalogAnswer = step.ok ? { model: { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } } : null;
    const current = pricingState.current();
    const during = pricingState.status();
    await pricingState.idle();
    capture("priceState", step, { current, during, status: pricingState.status(), downloads });
  }
  const catalog = {
    "claude-haiku-4-5": { input_cost_per_token: 0.000001, output_cost_per_token: 0.000005, cache_read_input_token_cost: 0.0000001 },
    "gpt-6-astra": { input_cost_per_token: 0.00001, output_cost_per_token: 0.00005 },
    bad: { input_cost_per_token: -1, output_cost_per_token: 1 },
    "bedrock/claude-haiku-4-5": { input_cost_per_token: 9, output_cost_per_token: 9 },
  };
  const models = price.slimPrices(catalog);
  capture("pricing", { fn: "slim", catalog }, models);
  for (const model of ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "us.anthropic.claude-haiku-4-5", "openai/gpt-6-astra-2026-10-01", "sonnet", ""])
    capture("pricing", { fn: "lookup", models, model }, price.priceOf(models, model));
  const assistant = (patch = {}) => ({
    type: "assistant",
    timestamp: "2026-10-30T11:00:00Z",
    sessionId: "s1",
    requestId: "r1",
    cwd: "/repo",
    entrypoint: "sdk-ts",
    message: {
      id: "m1",
      model: "claude-haiku-4-5",
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 5,
        output_tokens: 20,
        output_tokens_details: { thinking_tokens: 7 },
      },
    },
    ...patch,
  });
  const token = (total, patch = {}) => ({
    type: "event_msg",
    timestamp: "2026-10-30T11:00:00Z",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { total_tokens: total },
        last_token_usage: { input_tokens: 1000, cached_input_tokens: 800, cache_write_input_tokens: 50, output_tokens: 30, reasoning_output_tokens: 10 },
      },
    },
    ...patch,
  });
  const cLines = [
    assistant(),
    assistant(),
    { type: "ai-title", sessionId: "s1", aiTitle: "<system>omit</system> Fix   the login" },
    { type: "custom-title", sessionId: "s1", customTitle: "Mine" },
    { type: "ai-title", sessionId: "s1", aiTitle: "Ignored" },
    assistant({ requestId: "r2" }),
    assistant({ message: { id: "zero", model: "<synthetic>", usage: { input_tokens: 50 } } }),
    assistant({ requestId: "r3", message: { model: "x", usage: { input_tokens: -1, cache_read_input_tokens: "4", output_tokens: 2.5 } } }),
  ];
  const xLines = [
    {
      type: "session_meta",
      timestamp: "2026-10-30T10:00:00Z",
      payload: { id: "child", cwd: "/repo", originator: "milagre", source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } } },
    },
    { type: "session_meta", payload: { id: "copied" } },
    token(1, { timestamp: "2026-10-30T09:00:00Z" }),
    { type: "turn_context", payload: { model: "gpt-6-astra" } },
    token(1030),
    token(1030),
    token(2060),
    token(0),
    token(1),
  ];
  for (const [provider, lines] of [
    ["claude", cLines],
    ["codex", xLines],
  ]) {
    const entry = { provider, offset: 0, carry: {}, sessions: {}, rows: {} };
    for (const line of lines) {
      const raw = JSON.stringify(line);
      scanner.readLines(Buffer.from(raw + "\n"), provider, entry);
      capture("transcripts", { provider, line: raw }, entry);
    }
  }
  // New parser entry for each sequence, with malformed JSON and exact marker filtering.
  const entry = { provider: "claude", offset: 0, carry: {}, sessions: {}, rows: {} };
  for (const raw of [
    '{"type":"assistant",bad',
    '{"type": "assistant","message":{"usage":{"input_tokens":100}}}',
    JSON.stringify({ type: "custom-title", sessionId: "unicode", customTitle: "é".repeat(81) }),
  ]) {
    scanner.readLines(Buffer.from(raw + "\n"), "claude", entry);
    capture("transcripts", { provider: "claude", line: raw, sequence: "malformed" }, entry);
  }
  const good = {
    provider: "claude",
    status: "ok",
    updatedAt: new Date(now).toISOString(),
    windows: [
      { id: "session", label: "Session", shortLabel: "5h", usedPercent: 25, resetsAt: new Date(now + 60_000).toISOString(), secret: "never-save" },
      { id: "weekly", label: "Weekly", shortLabel: "wk", usedPercent: 30, resetsAt: null },
    ],
    bankedResets: 2,
    accessToken: "never-save",
  };
  const store = cache.createUsageStore();
  for (const step of [
    { op: "last", provider: "claude", value: good },
    { op: "blocked", provider: "claude", value: { until: now + 120000, message: "wait", secret: "drop" } },
    { op: "last", provider: "codex", value: { ...good, windows: [] } },
    { op: "last", provider: "kiro", value: { ...good, bankedResets: 0 } },
    { op: "snapshot", now: now + 60000 },
    { op: "blocked", provider: "claude", value: null },
  ]) {
    if (step.op === "last") store.setLast(step.provider, step.value);
    if (step.op === "blocked") store.setBlocked(step.provider, step.value);
    capture("stores", step, {
      state: Object.fromEntries(["kiro", "antigravity", "claude", "codex"].map((p) => [p, store.get(p)])),
      snapshot: cache.cachedSnapshot(store, step.now ?? now),
    });
  }
  let clock = now,
    calls = 0,
    answer = good;
  const reader = usage.createUsageReader({
    store: cache.createUsageStore(),
    now: () => clock,
    readClaude: async () => {
      calls++;
      return answer;
    },
    readCodex: async () => usage.providerResult("codex", () => clock, "unavailable"),
    readAntigravity: async () => usage.providerResult("antigravity", () => clock, "unavailable"),
    readKiro: async () => usage.providerResult("kiro", () => clock, "unavailable"),
  });
  for (const step of [
    { at: now, result: good },
    { at: now + 1000, result: usage.providerResult("claude", () => now + 1000, "error", [], "limited", { retryAfterMs: 120000 }) },
    { at: now + 61000, result: good },
    { at: now + 122000, result: usage.providerResult("claude", () => now + 122000, "unavailable", [], "signed out") },
  ]) {
    clock = step.at;
    answer = step.result;
    const result = await reader.provider("claude");
    capture("reader", step, { result, cached: reader.cached("claude"), checkedAt: reader.checkedAt("claude"), calls });
  }
  // Capture real buildReport calls from the existing deterministic report tests, including assertions.
  const tasks = [];
  const report = load("token-usage.cjs");
  const pureNames = /^(Chats home and named Link usage|the report prices|two clones|picked days|folder attribution)/;
  const source = fs.readFileSync(path.join(base, "token-usage.test.cjs"), "utf8");
  vm.runInNewContext(
    source,
    {
      require: (id) => {
        if (id === "node:assert/strict") return { ...require(id), deepEqual: (a, b) => require(id).deepEqual(clone(a), clone(b)) };
        if (id === "node:test")
          return (name, fn) => {
            if (pureNames.test(name)) tasks.push(fn);
          };
        if (id === "./token-usage.cjs")
          return {
            ...report,
            buildReport: (args) => {
              const result = report.buildReport(args);
              capture("reports", { ...args, home: "/fixture/home" }, result);
              return result;
            },
          };
        if (id.startsWith("./")) return load(id.slice(2));
        return require(id);
      },
      console,
      process: { env: {} },
      setImmediate,
    },
    { filename: "token-usage.test.cjs" },
  );
  for (const task of tasks) await task();
  const titleSample = out.reports[1].input;
  for (const session of [
    { id: 7, native_session_id: "native-1", summary: { titleLine: "[Image #1] [Image #2]", titleImages: 2 } },
    { id: 7, native_session_id: "native-1", generatedTitle: " Generated " },
    { id: 7, native_session_id: "native-1", summary: { titleLine: "a".repeat(70) } },
  ]) {
    const args = { ...titleSample, projects: [{ path: "/code/app", name: "App", state: { sessions: { 7: session } } }] };
    capture("reports", args, report.buildReport(args));
  }
  // DST, half-hour offsets, overflow groups and limits all use the original report builder.
  const sample = out.reports[1].input;
  for (const timeZone of ["America/New_York", "Asia/Kathmandu", "Australia/Lord_Howe"]) {
    const args = { ...sample, timeZone, now: Date.parse("2026-11-02T12:00:00Z"), days: { from: "2026-11-01", to: "2026-11-01" } };
    capture("reports", args, report.buildReport(args));
  }
  const overflow = {
    ...sample,
    rows: Array.from({ length: 30 }, (_, i) => ({ ...sample.rows[0], session: "overflow" + i, cwd: "/p" + i })),
    projects: Array.from({ length: 30 }, (_, i) => ({ path: "/p" + i, name: "p" + i, state: {} })),
  };
  capture("reports", overflow, report.buildReport(overflow));
  const chats = { ...sample, rows: Array.from({ length: 25 }, (_, i) => ({ ...sample.rows[0], session: "s" + i })) };
  capture("reports", chats, report.buildReport(chats));
  // Real Node scan trace. All profile files are created here, never copied from a live account.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rust-usage-fixture-"));
  try {
    const roots = [
      { provider: "claude", dir: path.join(dir, "claude") },
      { provider: "codex", dir: path.join(dir, "codex") },
      { provider: "codex", dir: path.join(dir, "archive") },
    ];
    const cacheFile = path.join(dir, "cache.json");
    let scan = scanner.createTokenUsageScan({ roots: async () => roots, cacheFile, now: () => now });
    const c = cLines.map((l) => JSON.stringify(l) + "\n").join(""),
      x = xLines.map((l) => JSON.stringify(l) + "\n").join("");
    const tail = JSON.stringify(assistant({ requestId: "appended" })) + "\n";
    const steps = [
      { op: "write", file: "claude/p/s.jsonl", text: c },
      { op: "write", file: "codex/day/rollout.jsonl", text: x },
      { op: "scan" },
      { op: "scan" },
      { op: "append", file: "claude/p/s.jsonl", text: tail.slice(0, 40) },
      { op: "scan" },
      { op: "append", file: "claude/p/s.jsonl", text: tail.slice(40) },
      { op: "scan" },
      { op: "reopen" },
      { op: "scan" },
      { op: "move", file: "codex/day/rollout.jsonl", to: "archive/rollout.jsonl" },
      { op: "scan" },
      { op: "remove", file: "claude/p/s.jsonl" },
      { op: "scan" },
      {
        op: "write",
        file: "archive/rollout.jsonl",
        text: xLines
          .slice(0, 4)
          .map((l) => JSON.stringify(l) + "\n")
          .join(""),
      },
      { op: "scan" },
    ];
    for (const step of steps) {
      const file = step.file && path.join(dir, step.file);
      if (step.op === "write") {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, step.text);
      }
      if (step.op === "append") fs.appendFileSync(file, step.text);
      if (step.op === "move") {
        fs.mkdirSync(path.dirname(path.join(dir, step.to)), { recursive: true });
        fs.renameSync(file, path.join(dir, step.to));
      }
      if (step.op === "remove") fs.unlinkSync(file);
      if (step.op === "reopen") scan = scanner.createTokenUsageScan({ roots: async () => roots, cacheFile, now: () => now });
      const changed = step.op === "scan" ? await scan.scan() : null;
      capture("scans", step, { changed, rows: scan.rows(), finished: scan.finished(), scannedAt: scan.scannedAt() });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(__dirname, "../tests/fixtures/conformance.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(
    Object.fromEntries(
      Object.entries(out)
        .filter(([, v]) => Array.isArray(v))
        .map(([k, v]) => [k, v.length]),
    ),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
