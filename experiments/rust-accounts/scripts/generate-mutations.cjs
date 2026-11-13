// Actual Node metadata transitions on disposable synthetic profiles. Never launch a CLI.
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createAccounts } = require("../../../packages/core/src/accounts.cjs");
const { execFileSync } = require("node:child_process");
const root = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "milagre-account-mutation-oracle-"));
const id = (n) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const initial = {
  extra: "dropped on mutation",
  accounts: [
    { id: id(1), provider: "codex", label: "Work", extra: "dropped" },
    { id: id(2), provider: "claude", label: "Personal" },
  ],
  selected: { codex: id(1), future: "ignored" },
  scopes: { "/keep": { codex: id(1) }, "/removed": { claude: id(99) }, "milagre-link:11111111-1111-4111-8111-111111111111": { claude: id(2) } },
};
const cases = [];
const project = (snapshot) => ({
  providers: snapshot.providers.map((group) => {
    const { installed: _installed, ...rest } = group;
    return {
      ...rest,
      accounts: rest.accounts.map((a) => {
        if (a.missing) return a;
        const { state: _state, email: _email, plan: _plan, message: _message, ...metadata } = a;
        return metadata;
      }),
    };
  }),
  ...(snapshot.scopeKey ? { scopeKey: snapshot.scopeKey } : {}),
});
async function record(name, seed, operations) {
  const dir = path.join(root, name),
    home = path.join(dir, "home"),
    dataDir = path.join(dir, "profile");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, "accounts/accounts.json");
  if (seed !== null) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, seed, { mode: 0o600 });
  }
  const children = [],
    events = [],
    states = new Map(),
    names = new Map(),
    replacements = new Map();
  let available = true,
    account;
  const options = {
    dataDir,
    home,
    env: { HOME: home },
    cli: async () => (available ? { command: "/synthetic-cli" } : {}),
    inspect: async (provider, { env }) => {
      const directory = env.CODEX_HOME || env.CLAUDE_CONFIG_DIR || env.GEMINI_HOME;
      const accountId = directory && /^[a-f0-9-]{36}$/.test(path.basename(directory)) ? path.basename(directory) : "default";
      return { state: states.get(`${provider}:${accountId}`) || "unknown" };
    },
    spawn: (_command, _args, opts) => {
      assert.equal(opts.cwd, home);
      const child = new EventEmitter();
      children.push(child);
      return child;
    },
    changed: (provider) => events.push(provider),
    signInAntigravity: () => ({ done: Promise.resolve(), cancel() {} }),
  };
  const normalized = (value) => {
    let text = JSON.stringify(value);
    for (const [from, to] of replacements) text = text.replaceAll(from, to);
    return JSON.parse(text);
  };
  const out = { name, seed, operations: [] };
  try {
    account = createAccounts(options);
  } catch (error) {
    out.error = error.message;
    cases.push(out);
    return;
  }
  for (const operation of operations) {
    const method = operation.method,
      provider = operation.provider,
      accountId = names.get(operation.id) || operation.id;
    available = operation.available !== false;
    if (operation.state) {
      states.set(`${provider}:${accountId}`, operation.state);
      await account.list(true);
    }
    let result,
      newId = null;
    try {
      let value;
      if (method === "create") {
        value = await account.add(provider, operation.label);
        const row = value.providers.find((p) => p.provider === provider).accounts.at(-1);
        newId = id(50 + names.size);
        names.set(operation.as, row.id);
        replacements.set(row.id, newId);
      } else if (method === "select") value = account.select(provider, accountId);
      else if (method === "assign") value = account.assign(operation.scope, provider, accountId ?? null);
      else if (method === "remove") value = account.remove(provider, accountId);
      else if (method === "scope") value = await account.scope(operation.scope);
      else if (method === "snapshot") value = account.snapshot();
      else if (method === "reopen") {
        account.close();
        account = createAccounts(options);
        value = account.snapshot();
      } else throw Error(`Unknown test operation ${method}`);
      result = { ok: project(value) };
    } catch (error) {
      result = { error: error.message };
    }
    out.operations.push(
      normalized({
        call: operation,
        newId,
        result,
        metadata: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null,
        events: events.splice(0),
        mode: fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : null,
      }),
    );
    // Finish synthetic login with an injected identity. No process was started and no credentials exist.
    for (const child of children.splice(0)) child.emit("close", 0);
    await new Promise((resolve) => setImmediate(resolve));
  }
  account.close();
  cases.push(out);
}
async function main() {
  await record("saved", JSON.stringify(initial), [
    { method: "snapshot" },
    { method: "select", provider: "codex", id: id(1), state: "unknown" },
    { method: "select", provider: "codex", id: id(1), state: "ready" },
    { method: "assign", scope: "/new", provider: "claude", id: id(2), state: "signed-out" },
    { method: "assign", scope: "/new", provider: "claude", id: id(2), state: "ready" },
    { method: "assign", scope: "/new", provider: "codex", id: "default", state: "ready" },
    { method: "assign", scope: "/new", provider: "claude", id: null },
    { method: "assign", scope: "/new", provider: "codex", id: null },
    { method: "assign", scope: "/keep", provider: "codex", id: id(1), state: "ready" },
    { method: "remove", provider: "codex", id: id(1) },
    { method: "scope", scope: "/keep" },
    { method: "reopen" },
    { method: "scope", scope: "/removed" },
    { method: "remove", provider: "claude", id: "default" },
    { method: "remove", provider: "claude", id: id(99) },
    { method: "assign", scope: "../bad", provider: "claude", id: null },
    { method: "assign", scope: "/a", provider: "unknown", id: null },
    { method: "assign", scope: "/a", provider: "claude", id: id(99) },
    { method: "select", provider: "unknown", id: "default" },
    { method: "select", provider: "claude", id: "../../auth.json" },
  ]);
  await record("created", null, [
    { method: "create", provider: "codex", label: "  Work  ", as: "one" },
    { method: "select", provider: "codex", id: "one", state: "ready" },
    { method: "assign", scope: "remote|/project", provider: "codex", id: "one", state: "ready" },
    { method: "create", provider: "claude", label: "\ufeff Personal\u00a0", as: "two" },
    { method: "select", provider: "claude", id: "two", state: "ready" },
    { method: "assign", scope: "milagre-link:peer|11111111-1111-4111-8111-111111111111", provider: "claude", id: "two", state: "ready" },
    { method: "remove", provider: "codex", id: "one" },
    { method: "scope", scope: "remote|/project" },
    { method: "reopen" },
    { method: "create", provider: "antigravity", label: "Cloud", as: "three" },
    { method: "remove", provider: "claude", id: "two" },
  ]);
  await record("validation", null, [
    { method: "create", provider: "../codex", label: "x" },
    { method: "create", provider: "kiro", label: "x" },
    ...["", "  ", "x".repeat(81), "💫".repeat(41), "\u0085", "x".repeat(80), "💫".repeat(40)].map((label, i) => ({
      method: "create",
      provider: "codex",
      label,
      as: `label${i}`,
    })),
    { method: "create", provider: "claude", label: "Missing CLI", available: false },
  ]);
  await record(
    "limit",
    JSON.stringify({ accounts: Array.from({ length: 20 }, (_, i) => ({ id: id(i + 1), provider: "codex", label: `Account ${i}` })), selected: {} }),
    [{ method: "create", provider: "codex", label: "too many" }],
  );
  for (const [name, seed] of [
    ["bad-json", "{"],
    ["bad-id", JSON.stringify({ ...initial, accounts: [{ id: "../x", provider: "codex", label: "x" }] })],
  ])
    await record(name, seed, []);
  const target = path.join(__dirname, "../fixtures/mutations.json");
  const output = execFileSync(path.resolve(__dirname, "../../../node_modules/.bin/oxfmt"), ["--stdin-filepath", target], {
    input: JSON.stringify(cases, null, 2) + "\n",
    encoding: "utf8",
  });
  if (process.argv.includes("--check")) assert.equal(fs.readFileSync(target, "utf8"), output);
  else fs.writeFileSync(target, output);
  console.log(`${cases.length} Node metadata traces, ${cases.reduce((n, c) => n + c.operations.length, 0)} steps`);
}
main()
  .finally(() => fs.rmSync(root, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
