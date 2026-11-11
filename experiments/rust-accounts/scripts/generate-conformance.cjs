// Calls the real accounts/routing implementations using disposable synthetic profiles only.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createAccounts } = require("../../../packages/core/src/accounts.cjs");
const { createAccountRouting } = require("../../../packages/core/src/account-routing.cjs");
const { AMBIENT_ENV } = require("../../../packages/core/src/agents/antigravity-install.cjs");
const providers = ["codex", "claude", "antigravity", "kiro"];
const root = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-accounts-port-"));
const id = (n) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const selected = Object.fromEntries(providers.map((p) => [p, "default"]));
const entries = providers.slice(0, 3).map((p, i) => ({ id: id(i + 1), provider: p, label: `${p} saved`, ignored: "not forwarded" }));
const saved = { accounts: entries, selected, scopes: { "/project/a": { claude: id(2) }, "/project/removed": { codex: id(9) } } };
const fixtures = [];
function replace(value, from, to) {
  if (typeof value === "string") return value.replaceAll(from, to);
  if (Array.isArray(value)) return value.map((v) => replace(v, from, to));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [replace(k, from, to), replace(v, from, to)]));
  return value;
}
async function record(name, body, operations, envOverrides = {}) {
  const dir = path.join(root, name);
  const home = path.join(dir, "home");
  const dataDir = path.join(dir, "profile");
  fs.mkdirSync(home, { recursive: true });
  if (body !== null) {
    fs.mkdirSync(path.join(dataDir, "accounts"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dataDir, "accounts/accounts.json"), body, { mode: 0o600 });
  }
  const env = {
    HOME: home,
    KEEP: "synthetic-value",
    ANTHROPIC_API_KEY: "dummy-claude",
    OPENAI_API_KEY: "dummy-codex",
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
    ...Object.fromEntries(AMBIENT_ENV.map((k) => [k, `dummy-${k}`])),
    ...envOverrides,
  };
  const context = replace({ dataDir, home, cwd: process.cwd(), env }, dir, "/fixture");
  let accounts;
  const out = { name, body, context, operations: [] };
  try {
    accounts = createAccounts({
      dataDir,
      home,
      env,
      cli: async () => ({ command: "/synthetic-cli" }),
      inspect: async () => ({ state: "unknown" }),
      spawn: () => {
        throw Error("No process may start in account fixtures");
      },
    });
    out.initial = accounts.snapshot();
    const routing = createAccountRouting({ accounts, cli: async () => ({}) });
    for (const operation of operations) {
      let result;
      try {
        const [method, ...args] = operation;
        result = { ok: method === "pin" ? routing.selection(...args) : await accounts[method](...args) };
      } catch (error) {
        result = { error: error.message };
      }
      out.operations.push({ call: operation, result: replace(result, dir, "/fixture") });
    }
  } catch (error) {
    out.error = error.message;
  } finally {
    accounts?.close();
  }
  fixtures.push(out);
}
async function main() {
  const scopes = [
    null,
    "",
    "/project/a",
    "/project/removed",
    "/other",
    "remote|/other",
    "C:\\work",
    "milagre-link:11111111-1111-4111-8111-111111111111",
    "milagre-link:peer|11111111-1111-4111-8111-111111111111",
    "local|/a",
    "__proto__",
    "milagre-link:invalid",
    "../relative",
    "peer_name|/a",
  ];
  const calls = [
    ...scopes.map((scope) => ["pin", scope]),
    ...providers.flatMap((p) => scopes.map((scope) => ["selected", p, scope])),
    ...providers.flatMap((p) => [
      ["environment", p],
      ["environment", p, "default"],
      ["environment", p, id(9)],
    ]),
    ...entries.map((a) => ["environment", a.provider, a.id]),
    ["selected", "bad", null],
    ["environment", "../codex"],
    ...scopes.filter(Boolean).map((scope) => ["scope", scope]),
  ];
  await record("missing", null, calls);
  await record("saved", JSON.stringify(saved), calls);
  await record("selected", JSON.stringify({ ...saved, selected: { claude: id(2), codex: id(1), antigravity: id(3) } }), calls);
  await record(
    "relative-env",
    JSON.stringify(saved),
    entries.map((a) => ["environment", a.provider, a.id]),
    { CODEX_HOME: "../synthetic-codex", CLAUDE_CONFIG_DIR: "../synthetic-claude" },
  );
  const invalid = [
    "{",
    "null",
    "[]",
    "{}",
    { ...saved, accounts: {} },
    { ...saved, selected: { claude: id(9) } },
    { ...saved, scopes: [] },
    { ...saved, scopes: { bad: {} } },
    { ...saved, scopes: { "/a": { codex: "../../x" } } },
    { ...saved, accounts: [{ ...entries[0], id: "UPPERCASE-1111-4111-8111-111111111111" }] },
    { ...saved, accounts: [{ ...entries[0], provider: "unknown" }] },
  ];
  for (const [i, raw] of invalid.entries()) await record(`invalid-${i}`, typeof raw === "string" ? raw : JSON.stringify(raw), []);
  const dest = path.join(__dirname, "../fixtures/accounts.json");
  const value = { ambientEnv: AMBIENT_ENV, cases: fixtures };
  // cwd is intentionally explicit for path.resolve of relative CLI config directories.
  const normalized = replace(value, process.cwd(), "/working-directory");
  if (process.argv.includes("--check")) assert.deepEqual(JSON.parse(fs.readFileSync(dest, "utf8")), normalized);
  else fs.writeFileSync(dest, JSON.stringify(normalized, null, 2) + "\n");
  console.log(`${fixtures.length} account fixture profiles, ${fixtures.reduce((n, f) => n + f.operations.length, 0)} calls`);
}
main()
  .finally(() => fs.rmSync(root, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
