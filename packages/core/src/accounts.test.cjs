const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createAccounts } = require("./accounts.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-accounts-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const children = [],
    seen = [],
    changed = [];
  const env = { HOME: home, ANTHROPIC_API_KEY: "secret-claude", OPENAI_API_KEY: "secret-codex", CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1" };
  const options = {
    dataDir: path.join(root, "profile"),
    home,
    env,
    cli: async (p) => ({ command: `/cli/${p}` }),
    changed: (p) => changed.push(p),
    inspect: async (p, opts) => {
      seen.push({ p, ...opts });
      return { state: "ready", email: `${p}@example.test`, plan: "pro" };
    },
    spawn: (command, args, opts) => {
      const child = new EventEmitter();
      children.push({ child, command, args, opts });
      return child;
    },
  };
  const accounts = createAccounts(options);
  t.after(() => {
    accounts.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { accounts, root, home, children, seen, changed, options, env };
}
const group = (snapshot, provider) => snapshot.providers.find((p) => p.provider === provider);
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("new profiles isolate credentials, preserve connected CLI auth and resume history", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.home, ".codex"));
  fs.writeFileSync(path.join(f.home, ".codex", "auth.json"), "terminal-credential");
  fs.writeFileSync(path.join(f.home, ".codex", "config.toml"), 'cli_auth_credentials_store = "keyring"\nmodel = "test"\n[features]\nexample = true\n');
  await f.accounts.list();
  const added = group(await f.accounts.add("codex", "Work"), "codex").accounts[1];
  assert.equal(added.state, "signing-in");
  const env = f.children[0].opts.env;
  assert.equal(env.OPENAI_API_KEY, "");
  assert.equal(f.env.OPENAI_API_KEY, "secret-codex");
  assert.notEqual(env.CODEX_HOME, path.join(f.home, ".codex"));
  assert.equal(fs.existsSync(path.join(env.CODEX_HOME, "auth.json")), false);
  assert.equal(fs.readFileSync(path.join(f.home, ".codex", "auth.json"), "utf8"), "terminal-credential");
  assert.equal(fs.realpathSync(path.join(env.CODEX_HOME, "sessions")), fs.realpathSync(path.join(f.home, ".codex", "sessions")));
  const config = fs.readFileSync(path.join(env.CODEX_HOME, "config.toml"), "utf8");
  assert.match(config, /cli_auth_credentials_store = "file"/);
  assert.doesNotMatch(config, /"keyring"/);
  assert.match(config, /\[features\]\nexample = true/);
  assert.throws(() => f.accounts.select("codex", added.id), /Finish signing/);
  f.children[0].child.emit("close", 0);
  await tick();
  f.accounts.select("codex", added.id);
  assert.equal(f.accounts.environment("codex").CODEX_HOME, env.CODEX_HOME);
  assert.equal(createAccounts(f.options).selected("codex"), added.id);
  assert.equal(fs.statSync(path.join(f.root, "profile/accounts/accounts.json")).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(await f.accounts.list()), /secret|accessToken|refreshToken|CODEX_HOME/);
});

test("Claude uses its own config directory; cancelling and retrying never selects an unfinished account", async (t) => {
  const f = fixture(t);
  await f.accounts.list();
  const added = group(await f.accounts.add("claude", "Personal"), "claude").accounts[1];
  const env = f.children[0].opts.env;
  assert.equal(env.ANTHROPIC_API_KEY, "");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "");
  assert.equal(env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, "");
  assert.equal(f.accounts.environment("claude", "default").CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, "1");
  assert.ok(env.CLAUDE_CONFIG_DIR);
  assert.deepEqual(f.children[0].args, ["auth", "login", "--claudeai"]);
  assert.equal(f.accounts.selected("claude"), "default");
  f.accounts.cancel("claude", added.id);
  f.children[0].child.emit("close", 0);
  await tick();
  assert.equal(group(await f.accounts.list(), "claude").accounts[1].state, "signed-out");
  await f.accounts.login("claude", added.id);
  f.children[1].child.emit("close", 0);
  await tick();
  f.accounts.select("claude", added.id);
  assert.equal(f.accounts.environment("claude").CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, "");
  assert.equal(f.seen.find((s) => s.env.CLAUDE_CONFIG_DIR === env.CLAUDE_CONFIG_DIR).env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST, "");
  const snapshot = f.accounts.remove("claude", added.id);
  assert.equal(group(snapshot, "claude").accounts.length, 1);
  assert.equal(group(snapshot, "claude").selectedId, "default");
  assert.equal(f.changed.at(-1), "claude");
  assert.equal(createAccounts(f.options).selected("claude"), "default");
  assert.ok(fs.existsSync(env.CLAUDE_CONFIG_DIR), "A running reply can still use its private profile");
});

test("invalid input never becomes a path or a shell command", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.accounts.add("../codex", "Work"), /Unknown/);
  await assert.rejects(f.accounts.add("codex", ""), /account name/);
  assert.throws(() => f.accounts.select("codex", "../../auth.json"), /not found/);
  await assert.rejects(f.accounts.login("codex", "default"), /Add account/);
  assert.equal(f.children.length, 0);
});

test("a failed sign-in is visible and does not change the selected account", async (t) => {
  const f = fixture(t);
  const added = group(await f.accounts.add("codex", "Work"), "codex").accounts[1];
  f.children[0].child.emit("error", new Error("sensitive stderr must not be returned"));
  await tick();
  const snapshot = await f.accounts.list();
  assert.equal(group(snapshot, "codex").accounts[1].state, "signed-out");
  assert.equal(f.accounts.selected("codex"), "default");
  assert.doesNotMatch(JSON.stringify(snapshot), /sensitive/);
  assert.throws(() => f.accounts.select("codex", added.id), /Sign in/);
});

test("cancelling during the identity check ignores its late result", async (t) => {
  const f = fixture(t);
  let resolveIdentity;
  const accounts = createAccounts({
    ...f.options,
    inspect: () =>
      new Promise((resolve) => {
        resolveIdentity = resolve;
      }),
  });
  t.after(() => accounts.close());
  const added = group(await accounts.add("claude", "Work"), "claude").accounts[1];
  f.children[0].child.emit("close", 0);
  await tick();
  accounts.cancel("claude", added.id);
  resolveIdentity({ state: "ready" });
  await tick();
  assert.equal(group(await accounts.list(), "claude").accounts[1].state, "signed-out");
  assert.deepEqual(f.changed, []);
});

test("Project and Link overrides are independent, inherit dynamically and survive restart", async (t) => {
  const f = fixture(t);
  await f.accounts.list();
  const a = group(await f.accounts.add("claude", "Personal"), "claude").accounts[1];
  f.children[0].child.emit("close", 0);
  await tick();
  const b = group(await f.accounts.add("claude", "Business"), "claude").accounts[2];
  f.children[1].child.emit("close", 0);
  await tick();
  const project = "/projects/milagre";
  const link = "milagre-link:11111111-1111-4111-8111-111111111111";
  f.accounts.assign(project, "claude", a.id);
  f.accounts.assign(link, "claude", b.id);
  assert.equal(f.accounts.selected("claude", project), a.id);
  assert.equal(f.accounts.selected("claude", link), b.id);
  f.accounts.select("claude", b.id);
  assert.equal(f.accounts.selected("claude", project), a.id);
  assert.equal(f.accounts.selected("claude", "/projects/other"), b.id);
  assert.equal(createAccounts(f.options).selected("claude", link), b.id);
  f.accounts.assign(project, "claude", null);
  assert.equal(f.accounts.selected("claude", project), b.id);
  const scope = await f.accounts.scope(project);
  assert.equal(scope.scopeKey, project);
  assert.equal(group(scope, "claude").accountId, null);
  assert.equal(group(scope, "claude").effectiveId, b.id);
  f.accounts.assign(project, "claude", "default");
  assert.equal(f.accounts.selected("claude", project), "default");
  assert.equal(f.accounts.selected("codex", link), "default");
});

test("removing an explicitly assigned account never falls back to computer defaults", async (t) => {
  const f = fixture(t);
  await f.accounts.list();
  const a = group(await f.accounts.add("claude", "Work"), "claude").accounts[1];
  f.children[0].child.emit("close", 0);
  await tick();
  f.accounts.assign("/projects/work", "claude", a.id);
  f.changed.length = 0;
  f.accounts.remove("claude", a.id);
  assert.deepEqual(f.changed, ["claude"], "Removing a scope-pinned account must notify all clients and invalidate discovery");
  assert.equal(f.accounts.selected("claude", "/projects/work"), a.id);
  assert.throws(() => f.accounts.environment("claude", a.id), /not found/);
  const snapshot = await f.accounts.scope("/projects/work");
  const missing = group(snapshot, "claude").accounts.find((item) => item.id === a.id);
  assert.equal(missing.state, "error");
  assert.match(missing.message, /removed/i);
  assert.equal(createAccounts(f.options).selected("claude", "/projects/work"), a.id);
});

test("scope assignment rejects invalid keys and unfinished or foreign-provider accounts", async (t) => {
  const f = fixture(t);
  await f.accounts.list();
  const a = group(await f.accounts.add("claude", "Work"), "claude").accounts[1];
  assert.throws(() => f.accounts.assign("/projects/work", "claude", a.id), /Finish signing/);
  assert.throws(() => f.accounts.assign("/projects/work", "codex", a.id), /not found/);
  assert.throws(() => f.accounts.assign("__proto__", "claude", null), /valid Project or Link/);
  assert.throws(() => f.accounts.assign("milagre-link:invalid", "claude", null), /valid Project or Link/);
  f.accounts.cancel("claude", a.id);
  assert.throws(() => f.accounts.assign("/projects/work", "claude", a.id), /Sign in/);
});

const FAKE_AGY = path.join(__dirname, "agents", "fixtures", "fake-agy-sign-in.cjs");
const callback = (url) => void fetch(`${new URL(url).searchParams.get("redirect_uri")}?code=fake`);

function antigravityFixture(t, openUrl = callback) {
  const f = fixture(t);
  f.env.GEMINI_API_KEY = "secret-gemini";
  f.env.GEMINI_HOME = path.join(f.home, ".gemini");
  const options = {
    ...f.options,
    cli: async (p) => (p === "antigravity" ? { command: process.execPath, args: [FAKE_AGY], harness: "/nonexistent" } : { command: `/cli/${p}` }),
    signInAntigravity: (spec) => require("./antigravity-account.cjs").signInAntigravity({ ...spec, openUrl }),
  };
  delete options.inspect;
  const accounts = createAccounts(options);
  t.after(() => accounts.close());
  return { ...f, accounts, options };
}
const settled = async (accounts, provider, id) => {
  for (let i = 0; i < 300; i++) {
    const found = group(await accounts.list(), provider).accounts.find((a) => a.id === id);
    if (found.state !== "signing-in") return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Sign-in did not settle");
};

test("Antigravity's default is a Milagre-owned private profile that signs in from Milagre, never ~/.gemini", async (t) => {
  const f = antigravityFixture(t);
  const env = f.accounts.environment("antigravity", "default");
  const dir = path.join(f.root, "profile", "accounts", "antigravity-default");
  assert.equal(env.GEMINI_HOME, dir);
  assert.equal(env.AGY_ACP_FORCE_FILE_STORAGE, "1");
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.equal(f.env.GEMINI_API_KEY, "secret-gemini");
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(path.join(f.home, ".gemini")), false);
  const before = group(await f.accounts.list(), "antigravity");
  assert.equal(before.accounts[0].label, "Default account");
  assert.equal(before.accounts[0].state, "signed-out");
  assert.equal(group(await f.accounts.login("antigravity", "default"), "antigravity").accounts[0].state, "signing-in");
  const done = await settled(f.accounts, "antigravity", "default");
  assert.equal(done.state, "ready");
  assert.equal(done.email, "person@example.test");
  assert.deepEqual(f.changed, ["antigravity"]);
  assert.doesNotMatch(JSON.stringify(await f.accounts.list()), /secret|GEMINI_HOME|token/);
  assert.throws(() => f.accounts.remove("antigravity", "default"), /cannot be removed/);
});

test("an added Antigravity account gets its own profile, shares history and keeps its directory on remove", async (t) => {
  const f = antigravityFixture(t);
  const added = group(await f.accounts.add("antigravity", "Work"), "antigravity").accounts[1];
  assert.equal(added.state, "signing-in");
  assert.equal((await settled(f.accounts, "antigravity", added.id)).state, "ready");
  const dir = f.accounts.environment("antigravity", added.id).GEMINI_HOME;
  assert.equal(dir, path.join(f.root, "profile", "accounts", added.id));
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const shared = path.join(f.root, "profile", "accounts", "antigravity-default", "antigravity-acp", "conversations");
  assert.equal(fs.realpathSync(path.join(dir, "antigravity-acp", "conversations")), fs.realpathSync(shared));
  f.accounts.select("antigravity", added.id);
  assert.equal(createAccounts(f.options).selected("antigravity"), added.id);
  f.accounts.remove("antigravity", added.id);
  assert.equal(f.accounts.selected("antigravity"), "default");
  assert.ok(fs.existsSync(path.join(dir, "antigravity-acp", "acp_token.json")), "Remove forgets the account without deleting its profile");
});

test("an Antigravity sign-in can be cancelled, and a subscription failure is explained", async (t) => {
  let captured;
  const f = antigravityFixture(t, (url) => captured?.(url));
  const opened = new Promise((resolve) => {
    captured = resolve;
  });
  await f.accounts.login("antigravity", "default");
  await opened;
  const snapshot = f.accounts.cancel("antigravity", "default");
  assert.equal(group(snapshot, "antigravity").accounts[0].state, "signed-out");
  assert.match(group(snapshot, "antigravity").accounts[0].message, /cancelled/);
  f.env.FAKE_AGY_SCENARIO = "subscription";
  captured = callback;
  const sub = createAccounts(f.options);
  t.after(() => sub.close());
  await sub.login("antigravity", "default");
  const failed = await settled(sub, "antigravity", "default");
  assert.equal(failed.state, "error");
  assert.equal(failed.message, "This Google account needs an eligible Antigravity subscription.");
});

test("accounts saved before Antigravity existed still load and default Antigravity", async (t) => {
  const f = fixture(t);
  const file = path.join(f.root, "profile", "accounts", "accounts.json");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ accounts: [], selected: { claude: "default", codex: "default" }, scopes: {} }));
  const accounts = createAccounts(f.options);
  t.after(() => accounts.close());
  assert.equal(accounts.selected("antigravity"), "default");
  assert.deepEqual(
    (await accounts.list()).providers.map((p) => p.provider),
    ["codex", "claude", "antigravity", "kiro"],
  );
});

test("an added Claude account picks up the connected account's MCP servers when its environment is built", async (t) => {
  const f = fixture(t);
  await f.accounts.list();
  const added = group(await f.accounts.add("claude", "Work"), "claude").accounts[1];
  const dir = f.children[0].opts.env.CLAUDE_CONFIG_DIR;
  // Claude Code writes the Account's .claude.json at sign-in.
  fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "work@example.test" } }));
  fs.writeFileSync(path.join(f.home, ".claude.json"), JSON.stringify({ mcpServers: { pencil: { command: "/Applications/Pen.app/mcp" } } }));
  f.accounts.environment("claude", added.id);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, ".claude.json"), "utf8")).mcpServers, { pencil: { command: "/Applications/Pen.app/mcp" } });
  fs.writeFileSync(path.join(f.home, ".claude.json"), "{ not json");
  assert.equal(f.accounts.environment("claude", added.id).CLAUDE_CONFIG_DIR, dir, "an unreadable config never blocks the Chat");
});

test("uninstalled providers have no account controls or project choices, and installation restores saved accounts", async (t) => {
  const f = fixture(t);
  let installed = true;
  const accounts = createAccounts({
    ...f.options,
    signInAntigravity: () => ({ cancel() {}, done: new Promise(() => {}) }),
    cli: async (provider) => ({ command: provider === "antigravity" && !installed ? null : `/cli/${provider}` }),
  });
  t.after(() => accounts.close());
  await accounts.list();
  const added = group(await accounts.add("antigravity", "Work"), "antigravity").accounts[1];
  accounts.cancel("antigravity", added.id);
  installed = false;
  assert.equal(group(await accounts.list(), "antigravity").installed, false);
  assert.equal(
    (await accounts.scope("/project")).providers.some((p) => p.provider === "antigravity"),
    false,
  );
  assert.equal(group(await accounts.list(), "claude").accounts.length, 1);
  installed = true;
  const restored = group(await accounts.list(), "antigravity");
  assert.equal(restored.installed, true);
  assert.equal(restored.accounts.length, 2);
  assert.equal(restored.accounts[1].id, added.id, "saved profiles survive an uninstall");
  assert.equal(
    (await accounts.scope("/project")).providers.some((p) => p.provider === "antigravity"),
    true,
  );
});

test("installation during an account check refreshes the newly available provider", async (t) => {
  const f = fixture(t);
  let installed = false;
  let release, started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const inspecting = new Promise((resolve) => {
    started = resolve;
  });
  const accounts = createAccounts({
    ...f.options,
    cli: async (provider) => ({ command: provider === "antigravity" && !installed ? null : `/cli/${provider}` }),
    inspect: async (provider) => {
      if (provider === "claude") {
        started();
        await gate;
      }
      return { state: "ready" };
    },
  });
  t.after(() => accounts.close());
  const first = accounts.list();
  await inspecting;
  installed = true;
  const afterInstall = accounts.list();
  await tick();
  release();
  await first;
  assert.equal(group(await afterInstall, "antigravity").accounts[0].state, "ready");
});

test("a connected CLI account that isn't signed in yet signs in where the terminal would", async (t) => {
  const f = fixture(t);
  let signedIn = false;
  f.options.inspect = async (p) => (signedIn ? { state: "ready", email: `${p}@example.test` } : { state: "signed-out" });
  const accounts = createAccounts(f.options);
  t.after(() => accounts.close());
  await accounts.list();
  assert.equal(group(await accounts.login("claude", "default"), "claude").accounts[0].state, "signing-in");
  assert.deepEqual(f.children[0].args, ["auth", "login", "--claudeai"]);
  assert.equal(f.children[0].opts.env.CLAUDE_CONFIG_DIR, undefined, "The terminal's own profile signs in");
  signedIn = true;
  f.children[0].child.emit("close", 0);
  await tick();
  assert.equal(group(accounts.snapshot(), "claude").accounts[0].state, "ready");
  await assert.rejects(accounts.login("claude", "default"), /Add account/);
});
