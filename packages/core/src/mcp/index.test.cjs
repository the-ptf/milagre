const test = require("node:test");
const assert = require("node:assert/strict");
const { createMcp } = require("./index.cjs");

const snapshot = {
  providers: [
    {
      provider: "claude",
      accounts: [
        { id: "default", label: "Connected CLI account", email: "me@example.test", state: "ready" },
        { id: "work", label: "Work", state: "signed-out" },
      ],
    },
    { provider: "codex", accounts: [{ id: "default", label: "Connected CLI account", state: "ready" }] },
    { provider: "antigravity", accounts: [{ id: "default", label: "Default account", state: "ready" }] },
  ],
};
let listCalls = 0;
const accounts = {
  snapshot: () => snapshot,
  list: async () => {
    listCalls++;
    return snapshot;
  },
};
const routing = { forAccount: async (provider, accountId) => ({ command: `/bin/${provider}`, env: { ACCOUNT: accountId }, accountId }) };
const noStore = { offFor: () => [], read: () => ({ everywhere: [] }) };
const report = { name: "pencil", transport: "command", scope: "user", state: "connected", tools: 5, error: null };

test("accounts lists Claude, Codex and Antigravity accounts", async () => {
  const mcp = createMcp({ store: noStore, accounts, routing, cwd: "/home" });
  assert.deepEqual(await mcp.accounts(), [
    { provider: "claude", accountId: "default", label: "me@example.test" },
    { provider: "claude", accountId: "work", label: "Work" },
    { provider: "codex", accountId: "default", label: "Connected CLI account" },
    { provider: "antigravity", accountId: "default", label: "Default account" },
  ]);
});

test("accounts and check never inspect identities", async () => {
  const mcp = createMcp({ store: noStore, accounts, routing, cwd: "/", checkers: { claude: async () => [] } });
  await mcp.accounts();
  await mcp.check("claude", "default");
  assert.equal(listCalls, 0);
});

test("an unknown state still reaches the CLI check", async () => {
  const unknown = { snapshot: () => ({ providers: [{ provider: "codex", accounts: [{ id: "default", label: "CLI", state: "unknown" }] }] }) };
  let called = false;
  const mcp = createMcp({ store: noStore, accounts: unknown, routing, cwd: "/", checkers: { codex: async () => ((called = true), []) } });
  assert.equal((await mcp.check("codex", "default")).problem, null);
  assert.equal(called, true);
});

test("a hanging account or CLI lookup still ends at the cap", async () => {
  const hang = () => new Promise(() => {});
  for (const mcp of [
    createMcp({ store: noStore, accounts: { snapshot: hang }, routing, cwd: "/", timeoutMs: 20 }),
    createMcp({ store: noStore, accounts, routing: { forAccount: hang }, cwd: "/", timeoutMs: 20 }),
  ]) {
    const result = await mcp.check("claude", "default");
    assert.equal(result.problem, "Timed out after 30 s. Check the servers in a terminal.");
    assert.equal(result.provider, "claude");
  }
});

test("check runs the provider's checker with the account's command and environment", async () => {
  let seen = null;
  const mcp = createMcp({
    store: noStore,
    accounts,
    routing,
    cwd: "/home",
    checkers: {
      claude: async (options) => {
        seen = options;
        return [report];
      },
    },
  });
  assert.deepEqual(await mcp.check("claude", "default"), {
    provider: "claude",
    accountId: "default",
    label: "me@example.test",
    problem: null,
    servers: [report],
  });
  assert.equal(seen.command, "/bin/claude");
  assert.deepEqual(seen.env, { ACCOUNT: "default" });
  assert.equal(seen.cwd, "/home");
  assert.equal(seen.signal.aborted, false);
});

test("a signed-out account is not checked", async () => {
  let called = false;
  const mcp = createMcp({ store: noStore, accounts, routing, cwd: "/", checkers: { claude: async () => ((called = true), []) } });
  const result = await mcp.check("claude", "work");
  assert.equal(result.problem, "Not signed in. Sign in from Accounts.");
  assert.deepEqual(result.servers, []);
  assert.equal(called, false);
});

test("a missing CLI reports the CLI's problem", async () => {
  const mcp = createMcp({ store: noStore, accounts, routing: { forAccount: async () => ({ command: null, problem: "Install Codex first." }) }, cwd: "/" });
  assert.equal((await mcp.check("codex", "default")).problem, "Install Codex first.");
});

test("a checker that never answers is cut off at the cap and told to stop", async () => {
  let signal = null;
  const mcp = createMcp({
    store: noStore,
    accounts,
    routing,
    cwd: "/",
    timeoutMs: 20,
    checkers: {
      codex: (options) => {
        signal = options.signal;
        return new Promise(() => {});
      },
    },
  });
  const result = await mcp.check("codex", "default");
  assert.equal(result.problem, "Timed out after 30 s. Check the servers in a terminal.");
  assert.equal(signal.aborted, true);
});

test("a checker that throws reports its message", async () => {
  const mcp = createMcp({
    store: noStore,
    accounts,
    routing,
    cwd: "/",
    checkers: {
      codex: async () => {
        throw new Error("app-server exited");
      },
    },
  });
  assert.equal((await mcp.check("codex", "default")).problem, "app-server exited");
});

test("an unknown account or provider is a problem, not a throw", async () => {
  const mcp = createMcp({ store: noStore, accounts, routing, cwd: "/" });
  assert.equal((await mcp.check("codex", "nope")).problem, "Account not found. Refresh and try again.");
  assert.equal((await mcp.check("antigravity", "nope")).problem, "Account not found. Refresh and try again.");
});

test("the checker gets a deadline 5 s inside the cap", async () => {
  let seen = null;
  const mcp = createMcp({
    store: noStore,
    accounts,
    routing,
    cwd: "/",
    checkers: {
      claude: async (options) => {
        seen = options;
        return [];
      },
    },
  });
  await mcp.check("claude", "default");
  assert.equal(seen.timeoutMs, 25_000);
});

test("a checker that answers just under the cap keeps its server list", async () => {
  const mcp = createMcp({
    store: noStore,
    accounts,
    routing,
    cwd: "/",
    timeoutMs: 100,
    checkers: { claude: () => new Promise((resolve) => setTimeout(() => resolve([report]), 50)) },
  });
  const result = await mcp.check("claude", "default");
  assert.equal(result.problem, null);
  assert.deepEqual(result.servers, [report]);
});

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMcpStore } = require("./store.cjs");

function harness(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-mcp-index-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(dir, ".claude.json"),
    JSON.stringify({ mcpServers: { figma: { type: "http", url: "https://figma", headers: { Authorization: "Bearer s" } } } }),
  );
  const events = [];
  const calls = [];
  const store = createMcpStore(path.join(dir, "mcp.json"));
  const mcp = createMcp({
    accounts,
    routing: { forAccount: async (provider, accountId) => ({ command: `/bin/${provider}`, env: {}, accountId }) },
    cwd: "/",
    home: dir,
    store,
    emit: (channel, payload) => events.push([channel, payload]),
    openUrl: (url) => calls.push(["open", url]),
    writers: {
      claude: { add: async (o) => calls.push(["claude.add", o.def.name]), remove: async (o) => calls.push(["claude.remove", o.name]) },
      codex: { add: async (o) => calls.push(["codex.add", o.def.name]), remove: async (o) => calls.push(["codex.remove", o.name]), read: async () => null },
    },
    ...overrides,
  });
  return { mcp, store, events, calls, dir };
}
const linear = { name: "linear", type: "http", url: "https://mcp.linear.app/mcp", headers: {} };

test("saving Everywhere writes the store and announces it", async (t) => {
  const { mcp, store, events } = harness(t);
  await mcp.save(linear, "everywhere");
  assert.deepEqual(store.read().everywhere, [linear]);
  assert.deepEqual(events, [["mcp:changed", { name: "linear" }]]);
});

test("saving to Claude or Codex calls the default account's writer", async (t) => {
  const { mcp, calls } = harness(t);
  await mcp.save(linear, "claude");
  await mcp.save(linear, "codex");
  assert.deepEqual(calls, [
    ["claude.add", "linear"],
    ["codex.add", "linear"],
  ]);
});

test("an edit removes the previous server first, and a masked header keeps its value", async (t) => {
  const { mcp, calls } = harness(t);
  const masked = await mcp.definition("figma", "claude");
  assert.deepEqual(masked.headers, { Authorization: "••••••" });
  let saved;
  const { mcp: editing } = harness(t, {
    writers: { claude: { add: async (o) => (saved = o.def), remove: async (o) => calls.push(["claude.remove", o.name]) }, codex: {} },
  });
  await editing.save({ ...masked, name: "figma2" }, "claude", { name: "figma", target: "claude" });
  assert.deepEqual(saved.headers, { Authorization: "Bearer s" });
  assert.deepEqual(calls.at(-1), ["claude.remove", "figma"]);
});

test("invalid servers and stdio over saveUrl are refused before any write", async (t) => {
  const { mcp, calls } = harness(t);
  await assert.rejects(mcp.save({ ...linear, name: "a b" }, "everywhere"), /letters, numbers/);
  await assert.rejects(mcp.saveUrl({ name: "p", type: "stdio", command: "p", args: [], env: {} }, "everywhere"), /Add command servers on the Mac/);
  assert.equal(calls.length, 0);
});

test("toggle writes the off list and check reports it", async (t) => {
  const { mcp } = harness(t, { checkers: { claude: async () => [report] } });
  await mcp.toggle("claude", "default", "pencil", false);
  assert.equal((await mcp.check("claude", "default")).servers[0].state, "disabled");
});

test("forSession skips Everywhere names the provider already has and returns the off list", async (t) => {
  const { mcp, store } = harness(t);
  store.setEverywhere([linear, { ...linear, name: "figma" }]);
  store.setOff("claude", "default", "pencil", true);
  assert.deepEqual(await mcp.forSession("claude", "default"), { servers: [linear], off: ["pencil"] });
});

test("forSession leaves Everywhere servers that are off out of servers", async (t) => {
  const { mcp, store } = harness(t);
  store.setEverywhere([linear, { ...linear, name: "notion" }]);
  store.setOff("claude", "default", "notion", true);
  assert.deepEqual(await mcp.forSession("claude", "default"), { servers: [linear], off: ["notion"] });
});

test("forSession gives Codex only off names that are in its config.toml", async (t) => {
  const { mcp, store, dir } = harness(t);
  fs.mkdirSync(path.join(dir, ".codex"));
  fs.writeFileSync(path.join(dir, ".codex", "config.toml"), '[mcp_servers.pencil]\ncommand = "pencil"\n');
  store.setEverywhere([linear]);
  store.setOff("codex", "default", "pencil", true);
  store.setOff("codex", "default", "gone", true);
  assert.deepEqual(await mcp.forSession("codex", "default"), { servers: [linear], off: ["pencil"] });
  store.setOff("claude", "default", "gone", true);
  assert.deepEqual((await mcp.forSession("claude", "default")).off, ["gone"]);
});

test("check marks a provider's own server that shadows an Everywhere one", async (t) => {
  const { mcp, store } = harness(t, { checkers: { claude: async () => [{ ...report, name: "figma", transport: "url" }] } });
  store.setEverywhere([{ ...linear, name: "figma" }]);
  assert.equal((await mcp.check("claude", "default")).servers[0].shadowedBy, "claude");
});

test("antigravity lists Everywhere servers as unchecked or off", async (t) => {
  const { mcp, store } = harness(t);
  store.setEverywhere([linear]);
  assert.ok((await mcp.accounts()).some((account) => account.provider === "antigravity"));
  assert.deepEqual((await mcp.check("antigravity", "default")).servers, [
    { name: "linear", transport: "url", scope: "everywhere", state: "unchecked", tools: 0, error: null, detail: "https://mcp.linear.app/mcp" },
  ]);
  await mcp.toggle("antigravity", "default", "linear", false);
  assert.equal((await mcp.check("antigravity", "default")).servers[0].state, "disabled");
});

test("signIn runs each account in turn and announces each result", async (t) => {
  const order = [];
  const { mcp, events } = harness(t, {
    signers: {
      claude: async ({ name, openUrl }) => (order.push(`claude:${name}`), openUrl("https://a"), { ok: true }),
      codex: async () => (order.push("codex"), { ok: false, error: "denied" }),
    },
  });
  await mcp.signIn("linear", [
    { provider: "claude", accountId: "default" },
    { provider: "codex", accountId: "default" },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["claude:linear", "codex"]);
  assert.deepEqual(
    events.map(([, payload]) => payload.signIn),
    ["done", "failed"],
  );
  assert.deepEqual(
    events.map(([, payload]) => payload.last),
    [false, true],
  );
  assert.equal(events[1][1].error, "denied");
});

test("cancelSignIn aborts the running account and skips the rest", async (t) => {
  let started = 0;
  const { mcp, events } = harness(t, {
    signers: {
      claude: ({ signal, openUrl }) => (
        started++,
        openUrl("https://a"),
        new Promise((resolve) => signal.addEventListener("abort", () => resolve({ cancelled: true })))
      ),
      codex: async () => (started++, { ok: true }),
    },
  });
  await mcp.signIn("linear", [
    { provider: "claude", accountId: "default" },
    { provider: "codex", accountId: "default" },
  ]);
  mcp.cancelSignIn("linear");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0][1].signIn, "cancelled");
  assert.equal(events[0][1].last, true);
});

test("a cancel before the CLI lookup finishes never starts the runner and ends the row", async (t) => {
  let started = 0;
  const { mcp, events } = harness(t, { signers: { claude: async () => (started++, { ok: true }) } });
  const running = mcp.signIn("linear", [{ provider: "claude", accountId: "default" }]);
  mcp.cancelSignIn("linear");
  await running;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 0);
  assert.deepEqual(
    events.map(([, payload]) => [payload.signIn, payload.last]),
    [["cancelled", true]],
  );
});

test("signIn resolves once the first URL opens, while its runner is still pending", async (t) => {
  let finish;
  const { mcp, events } = harness(t, {
    signers: { claude: ({ openUrl }) => (openUrl("https://a"), new Promise((resolve) => (finish = resolve))) },
  });
  assert.deepEqual(await mcp.signIn("linear", [{ provider: "claude", accountId: "default" }]), { started: true });
  assert.equal(events.length, 0);
  finish({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events[0][1].signIn, "done");
});

test("a failed CLI lookup, a missing CLI or a throwing runner still finishes each row and moves on", async (t) => {
  const forAccount = async (provider, accountId) => {
    if (accountId === "reject") throw new Error("lookup failed");
    if (accountId === "missing") return { command: null, problem: "Install Claude first." };
    return { command: `/bin/${provider}`, env: {}, accountId };
  };
  const { mcp, events } = harness(t, {
    routing: { forAccount },
    signers: {
      claude: async () => {
        throw new Error("boom");
      },
      codex: async () => ({ ok: true }),
    },
  });
  await mcp.signIn("linear", [
    { provider: "claude", accountId: "reject" },
    { provider: "claude", accountId: "missing" },
    { provider: "claude", accountId: "default" },
    { provider: "codex", accountId: "default" },
    { provider: "antigravity", accountId: "default" },
    null,
    { provider: "nope", accountId: "x" },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    events.map(([, payload]) => [payload.provider, payload.accountId, payload.signIn, payload.error, payload.last]),
    [
      ["claude", "reject", "failed", "lookup failed", false],
      ["claude", "missing", "failed", "Install Claude first.", false],
      ["claude", "default", "failed", "boom", false],
      ["codex", "default", "done", null, true],
    ],
  );
});

test("signIn with nothing to run resolves at once and ends the row with a failure", async (t) => {
  const { mcp, events } = harness(t);
  assert.deepEqual(await mcp.signIn("linear", [{ provider: "antigravity", accountId: "default" }]), { started: true });
  assert.deepEqual(events, [["mcp:changed", { name: "linear", signIn: "failed", error: "Nothing to sign in to.", last: true }]]);
});

test("a replaced sign-in stays silent", async (t) => {
  const finishers = [];
  const { mcp, events } = harness(t, {
    signers: { claude: ({ openUrl }) => (openUrl("https://a"), new Promise((resolve) => finishers.push(resolve))) },
  });
  await mcp.signIn("linear", [{ provider: "claude", accountId: "default" }]);
  await mcp.signIn("linear", [{ provider: "claude", accountId: "default" }]);
  finishers[0]({ cancelled: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 0);
  finishers[1]({ ok: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    events.map(([, payload]) => payload.signIn),
    ["done"],
  );
});

test("a failed add during a same-name edit restores the previous server and rethrows", async (t) => {
  const calls = [];
  const { mcp } = harness(t, {
    writers: {
      claude: {
        add: async (o) => {
          calls.push(["add", o.def.url]);
          if (o.def.url === "https://figma/new") throw new Error("add failed");
        },
        remove: async (o) => calls.push(["remove", o.name]),
      },
      codex: {},
    },
  });
  const masked = await mcp.definition("figma", "claude");
  await assert.rejects(mcp.save({ ...masked, url: "https://figma/new" }, "claude", { name: "figma", target: "claude" }), /add failed/);
  assert.deepEqual(calls, [
    ["remove", "figma"],
    ["add", "https://figma/new"],
    ["add", "https://figma"],
  ]);
});

test("a rename adds the new server before removing the old one", async (t) => {
  const calls = [];
  const { mcp } = harness(t, {
    writers: {
      claude: { add: async (o) => calls.push(["add", o.def.name]), remove: async (o) => calls.push(["remove", o.name]) },
      codex: {},
    },
  });
  const masked = await mcp.definition("figma", "claude");
  await mcp.save({ ...masked, name: "figma2" }, "claude", { name: "figma", target: "claude" });
  assert.deepEqual(calls, [
    ["add", "figma2"],
    ["remove", "figma"],
  ]);
});

test("a failed add during a rename leaves the old server alone", async (t) => {
  const calls = [];
  const { mcp } = harness(t, {
    writers: {
      claude: {
        add: async () => {
          throw new Error("add failed");
        },
        remove: async (o) => calls.push(["remove", o.name]),
      },
      codex: {},
    },
  });
  const masked = await mcp.definition("figma", "claude");
  await assert.rejects(mcp.save({ ...masked, name: "figma2" }, "claude", { name: "figma", target: "claude" }), /add failed/);
  assert.deepEqual(calls, []);
});

test("an unknown target is refused before anything is removed", async (t) => {
  const { mcp, calls } = harness(t);
  await assert.rejects(mcp.saveUrl(linear, "bogus", { name: "figma", target: "claude" }), /Pick where to load it/);
  await assert.rejects(mcp.saveUrl(linear, "claude", { name: "figma", target: "bogus" }), /Pick where to load it/);
  await assert.rejects(mcp.remove("figma", "bogus"), /Pick where to load it/);
  assert.equal(calls.length, 0);
});

test("toggle refuses an unknown provider or an odd server name and stores nothing", async (t) => {
  const { mcp, store, events } = harness(t);
  await assert.rejects(mcp.toggle("bogus", "default", "pencil", false));
  await assert.rejects(mcp.toggle("claude", "default", "bad/name", false));
  await assert.rejects(mcp.toggle("claude", "default", "x".repeat(129), false));
  assert.deepEqual(store.offFor("claude", "default"), []);
  assert.equal(events.length, 0);
  await mcp.toggle("claude", "default", "claude.ai Gmail", false);
  await mcp.toggle("claude", "default", "plugin:engineering:notion", false);
  assert.deepEqual(store.offFor("claude", "default"), ["claude.ai Gmail", "plugin:engineering:notion"]);
});

test("a masked header never follows the server to a new host, and nothing is written", async (t) => {
  const { mcp, calls } = harness(t);
  const masked = await mcp.definition("figma", "claude");
  await assert.rejects(
    mcp.save({ ...masked, url: "https://attacker.example/mcp" }, "claude", { name: "figma", target: "claude" }),
    /Enter the header values again for the new address\./,
  );
  assert.deepEqual(calls, []);
});

test("check switches off only what a Chat start would switch off", async (t) => {
  const reports = [
    { ...report, name: "pencil" },
    { ...report, name: "plugin:x:docs", scope: "plugin" },
    { ...report, name: "linear", scope: "everywhere", transport: "url" },
    { ...report, name: "old", state: "disabled", disabledBy: "provider" },
  ];
  const { mcp, store, dir } = harness(t, { checkers: { codex: async () => reports, claude: async () => reports } });
  fs.mkdirSync(path.join(dir, ".codex"));
  fs.writeFileSync(path.join(dir, ".codex", "config.toml"), '[mcp_servers.pencil]\ncommand = "pencil"\n[mcp_servers.old]\ncommand = "old"\nenabled = false\n');
  store.setEverywhere([linear]);
  for (const provider of ["codex", "claude"]) for (const name of ["pencil", "plugin:x:docs", "linear", "old"]) store.setOff(provider, "default", name, true);
  const states = async (provider) => (await mcp.check(provider, "default")).servers.map((server) => [server.name, server.state, server.disabledBy ?? null]);
  assert.deepEqual(await states("codex"), [
    ["pencil", "disabled", null],
    ["plugin:x:docs", "connected", null],
    ["linear", "disabled", null],
    ["old", "disabled", "provider"],
  ]);
  assert.deepEqual(await states("claude"), [
    ["pencil", "disabled", null],
    ["plugin:x:docs", "disabled", null],
    ["linear", "disabled", null],
    ["old", "disabled", "provider"],
  ]);
});

test("a Claude edit keeps the config keys the sheet doesn't know", async (t) => {
  let added;
  const { mcp, dir } = harness(t, { writers: { claude: { add: async (o) => (added = o), remove: async () => {} }, codex: {} } });
  fs.writeFileSync(
    path.join(dir, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        figma: { type: "http", url: "https://figma", headers: { Authorization: "Bearer s" }, oauth: { clientId: "c" }, timeout: 9, headersHelper: "h" },
      },
    }),
  );
  const masked = await mcp.definition("figma", "claude");
  await mcp.save({ ...masked, url: "https://figma/v2", headers: {} }, "claude", { name: "figma", target: "claude" });
  assert.deepEqual(added.extra, { oauth: { clientId: "c" }, timeout: 9, headersHelper: "h" });
  assert.deepEqual(added.def, { name: "figma", type: "http", url: "https://figma/v2", headers: {} });
  // A server that changes type or place starts clean.
  await mcp.save({ name: "figma", type: "stdio", command: "figma", args: [], env: {} }, "claude", { name: "figma", target: "claude" });
  assert.deepEqual(added.extra, {});
});

test("a Codex edit keeps the config keys the sheet doesn't know", async (t) => {
  let added;
  const raw = { url: "https://x.dev/mcp", bearer_token_env_var: "X_TOKEN", startup_timeout_sec: 20, enabled_tools: ["a"], enabled: false };
  const { mcp } = harness(t, { writers: { claude: {}, codex: { read: async () => raw, add: async (o) => (added = o), remove: async () => {} } } });
  assert.deepEqual(await mcp.definition("x", "codex"), { name: "x", type: "http", url: "https://x.dev/mcp", headers: {} });
  await mcp.save({ name: "x", type: "http", url: "https://x.dev/v2", headers: {} }, "codex", { name: "x", target: "codex" });
  assert.deepEqual(added.extra, { bearer_token_env_var: "X_TOKEN", startup_timeout_sec: 20, enabled_tools: ["a"], enabled: false });
});

test("saved definitions keep known fields and string values only", async (t) => {
  const { mcp, store } = harness(t);
  await mcp.save({ ...linear, headers: { A: "1", B: 2, C: { x: 1 } }, extra: "dropped", __proto__: { polluted: true } }, "everywhere");
  assert.deepEqual(store.read().everywhere, [{ name: "linear", type: "http", url: "https://mcp.linear.app/mcp", headers: { A: "1" } }]);
  await mcp.save({ name: "p", type: "stdio", command: "p", args: ["a", 3, "b"], env: { K: "v", N: 1 }, cwd: "/tmp" }, "everywhere");
  assert.deepEqual(store.read().everywhere[1], { name: "p", type: "stdio", command: "p", args: ["a", "b"], env: { K: "v" } });
});

test("remote names are checked before any write", async (t) => {
  const { mcp, calls, store } = harness(t);
  await assert.rejects(mcp.remove("-rf", "claude"), /Unknown server name/);
  await assert.rejects(mcp.remove("a/b", "claude"), /Unknown server name/);
  await assert.rejects(mcp.save(linear, "claude", { name: "--scope", target: "claude" }), /Unknown server name/);
  await assert.rejects(mcp.save(linear, "claude", { name: 3, target: "claude" }), /Unknown server name/);
  await assert.rejects(mcp.save(linear, "claude", "figma"), /Pick where to load it/);
  assert.deepEqual(calls, []);
  assert.deepEqual(store.read().everywhere, []);
});

test("remove clears the server's off entries once no config holds it, and rename moves them", async (t) => {
  const { mcp, store, dir } = harness(t, {
    writers: {
      claude: {
        add: async () => {},
        remove: async () => fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ mcpServers: {} })),
      },
      codex: {},
    },
  });
  store.setEverywhere([{ ...linear, name: "figma" }, linear]);
  store.setOff("claude", "default", "figma", true);
  store.setOff("antigravity", "default", "figma", true);
  await mcp.remove("figma", "everywhere");
  // Claude's own config still holds figma, so its switch stays off; Antigravity only had the Everywhere one.
  assert.deepEqual(store.read().off, { "claude:default": ["figma"] });
  await mcp.remove("figma", "claude");
  assert.deepEqual(store.read().off, {});

  store.setOff("claude", "default", "linear", true);
  store.setOff("codex", "default", "linear", true);
  await mcp.save({ ...linear, name: "linear2" }, "everywhere", { name: "linear", target: "everywhere" });
  assert.deepEqual(store.read().off, { "claude:default": ["linear2"], "codex:default": ["linear2"] });
});
