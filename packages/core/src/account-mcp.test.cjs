const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { inheritClaudeMcp, inheritCodexMcp } = require("./account-mcp.cjs");

function folder(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-account-mcp-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("Claude: the connected account's user and project servers reach the Account; its own servers stay", (t) => {
  const root = folder(t);
  const source = path.join(root, "source.json");
  const target = path.join(root, "target.json");
  fs.writeFileSync(
    source,
    JSON.stringify({
      mcpServers: { pencil: { command: "/Applications/Pen.app/mcp" }, shared: { command: "new" } },
      projects: { "/repo": { mcpServers: { local: { command: "local" } } }, "/other": { mcpServers: {} } },
      oauthAccount: { emailAddress: "terminal@example.test" },
    }),
  );
  fs.writeFileSync(
    target,
    JSON.stringify({ oauthAccount: { emailAddress: "work@example.test" }, mcpServers: { mine: { command: "mine" }, shared: { command: "old" } } }),
  );
  inheritClaudeMcp(source, target);
  const merged = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.deepEqual(Object.keys(merged.mcpServers).toSorted(), ["mine", "pencil", "shared"]);
  assert.equal(merged.mcpServers.shared.command, "new");
  assert.deepEqual(merged.projects, { "/repo": { mcpServers: { local: { command: "local" } } } });
  assert.equal(merged.oauthAccount.emailAddress, "work@example.test", "only servers are inherited, never the sign-in");
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  const mtime = fs.statSync(target).mtimeMs;
  inheritClaudeMcp(source, target);
  assert.equal(fs.statSync(target).mtimeMs, mtime, "nothing new leaves the file untouched");
});

test("Claude: an Account that hasn't signed in yet, or a missing source, is left alone", (t) => {
  const root = folder(t);
  const source = path.join(root, "source.json");
  const target = path.join(root, "target.json");
  inheritClaudeMcp(source, target);
  fs.writeFileSync(source, JSON.stringify({ mcpServers: { pencil: { command: "x" } } }));
  inheritClaudeMcp(source, target);
  assert.equal(fs.existsSync(target), false);
});

test("Codex: server tables are replaced or added, everything else in the Account's config stays", (t) => {
  const root = folder(t);
  const source = path.join(root, "source.toml");
  const target = path.join(root, "target.toml");
  fs.writeFileSync(
    source,
    [
      'model = "gpt-terminal"',
      "",
      "[mcp_servers.linear]",
      'url = "https://mcp.linear.app/mcp"',
      "",
      "[mcp_servers.pencil]",
      'command = "/Applications/Pen.app/mcp"',
      "",
      "[mcp_servers.pencil.env]",
      'A = "1"',
      "",
      "[features]",
      "x = true",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    target,
    [
      'sqlite_home = "/home/.codex"',
      'cli_auth_credentials_store = "file"',
      'model = "gpt-work"',
      "",
      "[mcp_servers.linear]",
      'url = "https://old.example/mcp"',
      "",
      '[mcp_servers."mine"]',
      'command = "mine"',
      "",
    ].join("\n"),
  );
  inheritCodexMcp(source, target);
  const merged = fs.readFileSync(target, "utf8");
  assert.match(merged, /^sqlite_home = "\/home\/\.codex"\ncli_auth_credentials_store = "file"\nmodel = "gpt-work"\n/);
  assert.doesNotMatch(merged, /old\.example|gpt-terminal|\[features\]/);
  assert.match(merged, /\[mcp_servers\."mine"\]\ncommand = "mine"/);
  assert.match(merged, /\[mcp_servers\.linear\]\nurl = "https:\/\/mcp\.linear\.app\/mcp"/);
  assert.match(merged, /\[mcp_servers\.pencil\]\ncommand = "\/Applications\/Pen\.app\/mcp"\n\n\[mcp_servers\.pencil\.env\]\nA = "1"/);
  assert.equal(merged.match(/\[mcp_servers\.linear\]/g).length, 1);
  inheritCodexMcp(source, target);
  assert.equal(fs.readFileSync(target, "utf8"), merged, "a second session start changes nothing");
});

function account(t) {
  const root = folder(t);
  const targetDir = path.join(root, "account");
  fs.mkdirSync(targetDir);
  return { root, targetDir, record: path.join(targetDir, "milagre-inherited-mcp.json") };
}

test("a Claude server removed from the source leaves the added account", (t) => {
  const { root, targetDir } = account(t);
  const source = path.join(root, "source.json");
  const target = path.join(targetDir, ".claude.json");
  fs.writeFileSync(source, JSON.stringify({ mcpServers: { a: { command: "a" }, b: { command: "b" } } }));
  fs.writeFileSync(target, JSON.stringify({ mcpServers: { own: { command: "own" } } }));
  inheritClaudeMcp(source, target);
  fs.writeFileSync(source, JSON.stringify({ mcpServers: { a: { command: "a" } } }));
  inheritClaudeMcp(source, target);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(target, "utf8")).mcpServers).toSorted(), ["a", "own"]);
});

test("a Codex server removed from the source leaves the added account", (t) => {
  const { root, targetDir } = account(t);
  const source = path.join(root, "source.toml");
  const target = path.join(targetDir, "config.toml");
  fs.writeFileSync(source, '[mcp_servers.a]\ncommand = "a"\n\n[mcp_servers.b]\ncommand = "b"\n');
  fs.writeFileSync(target, '[mcp_servers.own]\ncommand = "own"\n');
  inheritCodexMcp(source, target);
  fs.writeFileSync(source, '[mcp_servers.a]\ncommand = "a"\n');
  inheritCodexMcp(source, target);
  const text = fs.readFileSync(target, "utf8");
  assert.match(text, /\[mcp_servers\.a\]/);
  assert.match(text, /\[mcp_servers\.own\]/);
  assert.doesNotMatch(text, /\[mcp_servers\.b\]/);
});

test("a Codex server's sub-tables go with it, and an emptied source removes every recorded server", (t) => {
  const { root, targetDir } = account(t);
  const source = path.join(root, "source.toml");
  const target = path.join(targetDir, "config.toml");
  fs.writeFileSync(source, '[mcp_servers.a]\ncommand = "a"\n\n[mcp_servers.b]\ncommand = "b"\n\n[mcp_servers.b.env]\nK = "1"\n');
  fs.writeFileSync(target, 'model = "m"\n\n[mcp_servers.own]\ncommand = "own"\n');
  inheritCodexMcp(source, target);
  assert.match(fs.readFileSync(target, "utf8"), /\[mcp_servers\.b\.env\]/);
  fs.writeFileSync(source, '[mcp_servers.a]\ncommand = "a"\n');
  inheritCodexMcp(source, target);
  const text = fs.readFileSync(target, "utf8");
  assert.doesNotMatch(text, /mcp_servers\.b|K = "1"/);
  assert.match(text, /^model = "m"\n/);
  fs.writeFileSync(source, 'model = "m"\n');
  inheritCodexMcp(source, target);
  const emptied = fs.readFileSync(target, "utf8");
  assert.doesNotMatch(emptied, /mcp_servers\.a/);
  assert.match(emptied, /\[mcp_servers\.own\]/);
});

test("the first run has no record, so a server the Account already has is not removed", (t) => {
  const { root, targetDir, record } = account(t);
  const claudeSource = path.join(root, "source.json");
  const claudeTarget = path.join(targetDir, ".claude.json");
  fs.writeFileSync(claudeSource, JSON.stringify({ mcpServers: { a: { command: "a" } } }));
  fs.writeFileSync(claudeTarget, JSON.stringify({ mcpServers: { b: { command: "b" } } }));
  inheritClaudeMcp(claudeSource, claudeTarget);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(claudeTarget, "utf8")).mcpServers).toSorted(), ["a", "b"]);
  fs.rmSync(record);

  const codexSource = path.join(root, "source.toml");
  const codexTarget = path.join(targetDir, "config.toml");
  fs.writeFileSync(codexSource, '[mcp_servers.a]\ncommand = "a"\n');
  fs.writeFileSync(codexTarget, '[mcp_servers.b]\ncommand = "b"\n');
  inheritCodexMcp(codexSource, codexTarget);
  const text = fs.readFileSync(codexTarget, "utf8");
  assert.match(text, /\[mcp_servers\.a\]/);
  assert.match(text, /\[mcp_servers\.b\]/);
});

test("the record of copied names is written with mode 0600", (t) => {
  const { root, targetDir, record } = account(t);
  const source = path.join(root, "source.json");
  const target = path.join(targetDir, ".claude.json");
  fs.writeFileSync(source, JSON.stringify({ mcpServers: { b: { command: "b" }, a: { command: "a" } } }));
  fs.writeFileSync(target, "{}");
  inheritClaudeMcp(source, target);
  assert.deepEqual(JSON.parse(fs.readFileSync(record, "utf8")), { names: ["a", "b"] });
  assert.equal(fs.statSync(record).mode & 0o777, 0o600);
});
