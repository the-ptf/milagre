const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const d = require("./definitions.cjs");

const url = { name: "linear", type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer abc" } };
const cmd = { name: "pencil", type: "stdio", command: "pencil", args: ["mcp", "--stdio"], env: { TOKEN: "t" } };

test("converts to each provider's shape", () => {
  assert.deepEqual(d.toClaudeConfig(url), { type: "http", url: url.url, headers: url.headers });
  assert.deepEqual(d.toClaudeConfig(cmd), { type: "stdio", command: "pencil", args: ["mcp", "--stdio"], env: { TOKEN: "t" } });
  assert.deepEqual(d.toCodexConfig(url), { url: url.url, http_headers: url.headers });
  assert.deepEqual(d.toCodexConfig({ ...cmd, env: {} }), { command: "pencil", args: ["mcp", "--stdio"] });
  assert.deepEqual(d.toAcpServer(url), { type: "http", name: "linear", url: url.url, headers: [{ name: "Authorization", value: "Bearer abc" }] });
  assert.deepEqual(d.toAcpServer(cmd), { name: "pencil", command: "pencil", args: ["mcp", "--stdio"], env: [{ name: "TOKEN", value: "t" }] });
});

test("reads back from provider configs", () => {
  assert.deepEqual(d.fromClaudeConfig("linear", { type: "http", url: url.url, headers: url.headers }), url);
  assert.deepEqual(d.fromClaudeConfig("pencil", { command: "pencil", args: ["mcp", "--stdio"], env: { TOKEN: "t" } }), cmd);
  assert.deepEqual(d.fromCodexConfig("linear", { url: url.url, http_headers: url.headers }), url);
  assert.equal(d.fromClaudeConfig("x", { type: "claudeai-proxy" }), null);
});

test("masking hides values and unmasking keeps untouched ones", () => {
  const masked = d.maskDefinition(url);
  assert.deepEqual(masked.headers, { Authorization: "••••••" });
  assert.deepEqual(d.unmaskDefinition(masked, url).headers, { Authorization: "Bearer abc" });
  assert.deepEqual(d.unmaskDefinition({ ...masked, headers: { Authorization: "Bearer new" } }, url).headers, { Authorization: "Bearer new" });
  assert.deepEqual(d.unmaskDefinition({ ...masked, headers: { "X-New": "••••••" } }, url).headers, {}, "a masked value with no stored value is dropped");
  assert.deepEqual(d.maskDefinition(cmd).env, { TOKEN: "••••••" });
});

test("reads server names from Claude and Codex configs", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-mcp-names-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ mcpServers: { pencil: {}, linear: {} } }));
  fs.writeFileSync(
    path.join(dir, "config.toml"),
    '[mcp_servers.pencil]\ncommand = "p"\n\n[mcp_servers."my-x"]\nurl = "u"\n[mcp_servers.pencil.env]\nA = "1"\n',
  );
  assert.deepEqual([...d.claudeConfigNames(path.join(dir, ".claude.json"))].sort(), ["linear", "pencil"]);
  assert.deepEqual([...d.codexConfigNames(path.join(dir, "config.toml"))].sort(), ["my-x", "pencil"]);
  assert.equal(d.claudeConfigNames(path.join(dir, "missing.json")).size, 0);
});

test("detail is the URL or the command line", () => {
  assert.equal(d.detailOf(url), url.url);
  assert.equal(d.detailOf(cmd), "pencil mcp --stdio");
});

test("reads every Codex server header, including quoted names, comments and sub-table-only servers", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milagre-mcp-codex-headers-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config.toml");
  fs.writeFileSync(
    file,
    [
      "[mcp_servers.pencil] # the design server",
      'command = "p"',
      "",
      "[mcp_servers.'single-q']",
      'url = "u"',
      "",
      "[mcp_servers.solo.env]",
      'A = "1"',
      "",
      '[mcp_servers."my-x".env]',
      'B = "2"',
    ].join("\n"),
  );
  assert.deepEqual([...d.codexConfigNames(file)].sort(), ["my-x", "pencil", "single-q", "solo"]);
});

test("unmasking restores only keys the previous definition owns", () => {
  const previous = { name: "linear", type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer abc" } };
  const masked = { ...previous, headers: { constructor: "••••••", toString: "••••••" } };
  assert.deepEqual(d.unmaskDefinition(masked, previous).headers, {}, "inherited prototype keys are not restored");
});

test("safeDetail drops URL secrets and masks secret flag values", () => {
  assert.equal(d.safeDetail({ url: "https://u:p@x.dev/mcp?key=1#f" }), "https://x.dev/mcp");
  assert.equal(d.safeDetail({ type: "http", url: "https://x.dev/mcp" }), "https://x.dev/mcp");
  assert.equal(d.safeDetail({ url: "not a url?token=1" }), "not a url");
  assert.equal(d.safeDetail({ command: "npx", args: ["srv", "--api-key", "abc", "--port", "3"] }), "npx srv --api-key •••••• --port 3");
  assert.equal(d.safeDetail({ command: "npx", args: ["srv", "--token=abc", "--port=3"] }), "npx srv --token=•••••• --port=3");
  assert.equal(d.safeDetail({ command: "p" }), "p");
  assert.equal(d.safeDetail(undefined), null);
  assert.equal(d.detailOf({ type: "stdio", command: "p", args: ["--password", "x"], env: {} }), "p --password ••••••");
});

test("safeDetail hides userinfo in scheme-less URLs and matches secret flags as whole words", () => {
  assert.equal(d.safeDetail({ url: "user:pass@host/mcp" }), "host/mcp");
  assert.equal(d.safeDetail({ url: "//u:p@host/x#f" }), "host/x");
  assert.equal(d.safeDetail({ url: "u@host" }), "host");
  assert.equal(d.safeDetail({ url: "foo://h/x?s=1" }), "foo://h/x");
  assert.equal(d.safeDetail({ url: "foo://u:p@h/x?s=1#f" }), "h/x");
  assert.equal(d.safeDetail({ url: "wss://u:p@h/x?s=1" }), "wss://h/x");
  assert.equal(d.safeDetail({ command: "p", args: ["--keyboard", "us", "--author", "me"] }), "p --keyboard us --author me");
  assert.equal(d.safeDetail({ command: "p", args: ["--auth-header", "x", "--api_key=y"] }), "p --auth-header •••••• --api_key=••••••");
});

test("safeDetail masks compact secret flag names", () => {
  for (const flag of ["--apikey", "--clientsecret", "--secretkey", "--githubtoken", "--auth-header", "--key"])
    assert.equal(d.safeDetail({ command: "p", args: [flag, "v"] }), `p ${flag} ••••••`, flag);
  assert.equal(d.safeDetail({ command: "p", args: ["--api_key=y", "--GitHubToken=z"] }), "p --api_key=•••••• --GitHubToken=••••••");
  assert.equal(d.safeDetail({ command: "p", args: ["--keyboard", "us", "--author", "me", "--port", "3"] }), "p --keyboard us --author me --port 3");
});

test("a masked header follows the URL only within the same origin", () => {
  const masked = d.maskDefinition(url);
  assert.deepEqual(d.unmaskDefinition({ ...masked, url: "https://mcp.linear.app/v2/mcp" }, url).headers, { Authorization: "Bearer abc" });
  assert.throws(() => d.unmaskDefinition({ ...masked, url: "https://evil.example/mcp" }, url), /Enter the header values again for the new address\./);
  assert.throws(() => d.unmaskDefinition({ ...masked, url: "http://mcp.linear.app/mcp" }, url), /Enter the header values again/);
  // A new value typed for the new host is fine.
  assert.deepEqual(d.unmaskDefinition({ ...masked, url: "https://other.example/mcp", headers: { Authorization: "Bearer new" } }, url).headers, {
    Authorization: "Bearer new",
  });
});

test("a masked environment value is kept only while the command is unchanged", () => {
  const masked = d.maskDefinition(cmd);
  assert.deepEqual(d.unmaskDefinition({ ...masked, args: ["mcp"] }, cmd).env, { TOKEN: "t" });
  assert.throws(() => d.unmaskDefinition({ ...masked, command: "other" }, cmd), /Enter the variable values again for the new command\./);
});

test("safeDetail masks secret header values passed as arguments", () => {
  assert.equal(
    d.safeDetail({ command: "npx", args: ["mcp-remote", "https://x.dev", "--header", "Authorization: Bearer abc"] }),
    "npx mcp-remote https://x.dev --header Authorization: ••••••",
  );
  assert.equal(d.safeDetail({ command: "npx", args: ["-H", "X-Api-Key:abc", "-H", "Accept: json"] }), "npx -H X-Api-Key: •••••• -H Accept: json");
  assert.equal(d.safeDetail({ command: "npx", args: ["--header=Cookie: s=1", "--header=X-Team: a"] }), "npx --header=Cookie: •••••• --header=X-Team: a");
  assert.equal(d.safeDetail({ command: "npx", args: ["-H", "x-github-token: t", "-H", "My-Secret:s"] }), "npx -H x-github-token: •••••• -H My-Secret: ••••••");
});

test("--authorization is secret; only --author and --authors are not", () => {
  assert.equal(d.safeDetail({ command: "p", args: ["--authorization", "Bearer x"] }), "p --authorization ••••••");
  assert.equal(d.safeDetail({ command: "p", args: ["--authorization=Bearer x"] }), "p --authorization=••••••");
  assert.equal(d.safeDetail({ command: "p", args: ["--author", "me", "--authors", "us"] }), "p --author me --authors us");
});

test("a command server's secret arguments are masked and restored by position", () => {
  const server = { name: "remote", type: "stdio", command: "npx", args: ["mcp-remote", "--header", "Authorization: Bearer abc", "--token=t1"], env: {} };
  const masked = d.maskDefinition(server);
  assert.deepEqual(masked.args, ["mcp-remote", "--header", "Authorization: ••••••", "--token=••••••"]);
  assert.deepEqual(d.unmaskDefinition(masked, server).args, server.args);
  // Adding an argument while secrets are still masked asks for them again.
  assert.throws(
    () => d.unmaskDefinition({ ...masked, args: [...masked.args, "--verbose"] }, server),
    /Enter the argument values again after changing the arguments\./,
  );
  // A new value replaces the stored one; a moved mask or a new command can't be restored.
  assert.deepEqual(d.unmaskDefinition({ ...masked, args: ["mcp-remote", "--header", "Authorization: Bearer new", "--token=••••••"] }, server).args, [
    "mcp-remote",
    "--header",
    "Authorization: Bearer new",
    "--token=t1",
  ]);
  assert.throws(() => d.unmaskDefinition({ ...masked, args: ["--token=••••••"] }, server), /Enter the argument values again after changing the arguments\./);
  assert.throws(() => d.unmaskDefinition({ ...masked, command: "bunx" }, server), /Enter the argument values again after changing the arguments\./);
});

test("a masked argument never lands under a different flag", () => {
  const change = /Enter the argument values again after changing the arguments\./;
  // A flag pair removed: K1 must not move under --github-token.
  const a = { name: "a", type: "stdio", command: "srv", args: ["--api-key", "K1", "--github-token", "K2"], env: {} };
  assert.throws(() => d.unmaskDefinition({ ...a, args: ["--github-token", "••••••"] }, a), change);
  // Flag pairs swapped: A must not move under --secret.
  const b = { name: "b", type: "stdio", command: "srv", args: ["--token", "A", "--secret", "B"], env: {} };
  assert.throws(() => d.unmaskDefinition({ ...b, args: ["--secret", "••••••", "--token", "••••••"] }, b), change);
  // --flag=•••••• forms compare the flag before "=".
  const c = { name: "c", type: "stdio", command: "srv", args: ["--token=A", "--secret=B"], env: {} };
  assert.throws(() => d.unmaskDefinition({ ...c, args: ["--secret=••••••", "--token=••••••"] }, c), change);
  // An unchanged list restores every value in place.
  for (const server of [a, b, c]) assert.deepEqual(d.unmaskDefinition(d.maskDefinition(server), server).args, server.args);
});
