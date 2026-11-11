#!/usr/bin/env node
// Original runtime command bodies in a VM. All accounts/readers/stores are synthetic and in memory.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../../..");
const core = path.join(root, "packages/core/src");
const runtime = fs.readFileSync(path.join(core, "runtime.cjs"), "utf8");
const slice = (start, end) => {
  const a = runtime.indexOf(start),
    b = runtime.indexOf(end, a);
  assert(a >= 0 && b > a);
  return runtime.slice(a, b);
};
const functions = slice("  function usageForAccounts(", "  async function discoverWorktrees(");
const commands = slice('  commands.handle("usage:read"', "  // Token usage page:");
const validation = slice("  async function validateAccountScope(", "  async function accountScopeForFolder(");
const clone = (v) => JSON.parse(JSON.stringify(v));
const now = 1793361600000;
const account = (provider, id, state = "ready", extra = {}) => ({ provider, id, label: `${provider}/${id}`, state, ...extra });
const initial = {
  scopes: ["/project", "milagre-link:12345678-1234-1234-1234-123456789abc"],
  selection: { claude: "work", codex: "default", antigravity: "default" },
  identities: {
    providers: [
      {
        provider: "claude",
        selectedId: "work",
        accounts: [
          account("claude", "default"),
          account("claude", "work", "ready", { email: "fixture@example.invalid" }),
          account("claude", "signed-out", "signedOut"),
          account("claude", "unknown", "unknown", { message: "Waiting for fixture sign-in" }),
        ],
      },
      { provider: "codex", selectedId: "default", accounts: [account("codex", "default"), account("codex", "spare")] },
      { provider: "antigravity", selectedId: "default", installed: false, accounts: [account("antigravity", "default")] },
      { provider: "kiro", selectedId: "default", accounts: [account("kiro", "default")] },
    ],
  },
};
let model = clone(initial),
  clock = now,
  calls = [],
  events = [];
class Clock extends Date {
  constructor(...args) {
    super(...(args.length ? args : [clock]));
  }
  static now() {
    return clock;
  }
}
const loaded = new Map();
function load(name) {
  if (loaded.has(name)) return loaded.get(name);
  const module = { exports: {} };
  const requireFixture = (id) => {
    if (id === "node:fs" || id === "node:fs/promises") throw Error("Filesystem access forbidden in fixture owner");
    if (id === "node:path") return path;
    if (id === "@milagre/shared/providers") return { PROVIDERS: ["codex", "claude", "antigravity", "kiro"] };
    if (id === "./usage-cache.cjs") return load("usage-cache.cjs");
    return {};
  };
  // usage-cache requires fs at module load; methods on this stub throw if persistence is ever attempted.
  const noDisk = new Proxy(
    {},
    {
      get() {
        throw Error("Persistence forbidden in fixture owner");
      },
    },
  );
  vm.runInNewContext(
    fs.readFileSync(path.join(core, name), "utf8"),
    { module, require: (id) => (id === "node:fs" || id === "node:fs/promises" ? noDisk : requireFixture(id)), Date: Clock, console, setTimeout, clearTimeout },
    { filename: name },
  );
  loaded.set(name, module.exports);
  return module.exports;
}
const { createUsageStore, cachedSnapshot } = load("usage-cache.cjs");
const { createUsageReader } = load("usage.cjs");
const handlers = new Map();
const reader =
  (provider) =>
  async ({ env } = {}) => {
    const id = env?.id ?? "default";
    calls.push([provider, id]);
    const status = model.status ?? "ok";
    return {
      provider,
      status,
      windows: status === "ok" ? [{ id: "session", label: "Session", shortLabel: "5h", usedPercent: id === "work" ? 22 : 11, resetsAt: null }] : [],
      updatedAt: new Clock().toISOString(),
      ...(status === "error" ? { message: "fixture failure" } : {}),
    };
  };
const context = {
  commands: { handle: (name, fn) => handlers.set(name, fn) },
  accounts: {
    selected: (provider) => model.selection[provider] ?? "default",
    environment: (provider, id) => ({ provider, id }),
    list: async () => clone(model.identities),
  },
  accountScopes: async () => model.scopes.map((key) => ({ key })),
  accountUsage: new Map(),
  usageStore: createUsageStore(),
  createUsageStore: () => createUsageStore(),
  createUsageReader,
  cachedSnapshot,
  readers: { claude: reader("claude"), codex: reader("codex"), antigravity: reader("antigravity"), kiro: reader("kiro") },
  kiroUsage: reader("kiro"),
  environmentReady: Promise.resolve(),
  options: {},
  dataDir: "/fixture/never-written",
  Date: Clock,
  path,
  emit: (name, payload) => events.push([name, clone(payload)]),
};
vm.runInNewContext(functions + validation + commands, context, { filename: "runtime-usage-extract.cjs" });
const steps = [
  { command: "usage:cached", scope: "/project" },
  { command: "usage:accounts:cached" },
  { command: "usage:read", scope: "/project" },
  { command: "usage:cached", scope: "/project" },
  { command: "usage:accounts:cached" },
  { command: "usage:accounts:read" },
  { command: "usage:accounts:cached" },
  { command: "usage:cached", scope: "/project", set: { selection: { claude: "default", codex: "spare", antigravity: "default" } } },
  { command: "usage:read", scope: null },
  { command: "usage:accounts:cached" },
  { command: "usage:read", scope: "/project", set: { status: "error" } },
  { command: "usage:cached", scope: "/project" },
  { command: "usage:accounts:read" },
  { command: "usage:cached", scope: "/deleted" },
  { command: "usage:read", scope: "" },
  { command: "usage:cached", scope: 4 },
  {
    command: "usage:read",
    scope: "milagre-link:12345678-1234-1234-1234-123456789abc",
    set: { selection: { claude: "work", codex: "default", antigravity: "gravity" } },
  },
  {
    command: "usage:accounts:cached",
    set: {
      identities: {
        providers: initial.identities.providers.map((g) =>
          g.provider === "claude" ? { ...g, selectedId: "default", accounts: g.accounts.filter((a) => a.id !== "work") } : g,
        ),
      },
    },
  },
  { command: "usage:read", scope: "/project" },
];
(async () => {
  const traces = [];
  for (const step of steps) {
    if (step.set) Object.assign(model, clone(step.set));
    calls = [];
    events = [];
    clock += 1000;
    let result = null,
      error = null;
    try {
      result = await handlers.get(step.command)(null, step.scope);
    } catch (e) {
      error = e.message;
    }
    traces.push({
      input: { ...step, now: clock },
      expected: { result: result && clone(result), error, reads: calls.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), events },
    });
  }
  fs.writeFileSync(path.join(__dirname, "../tests/fixtures/accounts.json"), JSON.stringify({ initial, traces }, null, 2) + "\n");
  console.log(`${traces.length} Node command traces`);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
