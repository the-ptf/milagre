const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createConnectors, connectorUrl, idFor } = require("./index.cjs");
const { startFakeMcp, followInBrowser } = require("./test-helpers.cjs");

function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "connectors-"));
  const connectors = createConnectors({ dataDir, port: 0, openBrowser: followInBrowser, timeoutMs: 10_000, ...options });
  t.after(async () => {
    await connectors.dispose();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { dataDir, connectors };
}

async function fake(t, options) {
  const server = await startFakeMcp(options);
  t.after(() => server.close());
  return server;
}

test("a server with dynamic registration signs in once and serves its tools", async (t) => {
  const server = await fake(t);
  const { dataDir, connectors } = fixture(t);
  const added = await connectors.add({ name: "Notion work", url: server.url });
  assert.equal(added.id, "notion_work");
  assert.equal(added.state, "needs-sign-in");

  const signedIn = await connectors.signIn("notion_work");
  assert.equal(signedIn.state, "connected");
  assert.equal(signedIn.tools, 2);
  assert.equal(server.state.registered.length, 1);
  assert.deepEqual(server.state.registered[0].redirect_uris.length, 1);
  assert.match(server.state.registered[0].redirect_uris[0], /^http:\/\/localhost:\d+\/connectors\/callback$/);

  const tools = await connectors.tools("notion_work");
  assert.deepEqual(
    tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint ?? false]),
    [
      ["echo", true],
      ["post", false],
    ],
  );
  const result = await connectors.call("notion_work", "echo", { text: "hi" });
  assert.deepEqual(result.content, [{ type: "text", text: "echo: hi" }]);

  const file = path.join(dataDir, "connectors", "secrets", "notion_work.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(connectors.list()).includes(server.state.registered[0].client_id), false);
});

test("a server without dynamic registration uses the pre-registered client id and secret", async (t) => {
  const server = await fake(t, { registration: false, clientSecret: "shh" });
  const { connectors } = fixture(t);
  await assert.rejects(async () => {
    await connectors.add({ name: "No client", url: server.url });
    await connectors.signIn("no_client");
  }, /registration/i);

  const added = await connectors.add({ name: "Slack company A", url: server.url, clientId: "preset-client", clientSecret: "shh" });
  assert.equal(added.id, "slack_company_a");
  assert.equal(added.hasClientSecret, true);
  assert.equal(JSON.stringify(added).includes("shh"), false);
  const signedIn = await connectors.signIn("slack_company_a");
  assert.equal(signedIn.state, "connected");
  assert.equal(server.state.registered.length, 0);
  const exchange = server.state.tokenRequests.find((request) => request.grant_type === "authorization_code");
  assert.equal(exchange.client_id, "preset-client");
  assert.equal(exchange.client_secret, "shh");
  assert.ok(exchange.code_verifier);
});

test("an expired access token refreshes without opening a browser", async (t) => {
  const server = await fake(t);
  let opened = 0;
  const { connectors } = fixture(t, {
    openBrowser: (url) => {
      opened += 1;
      followInBrowser(url);
    },
  });
  await connectors.add({ name: "Linear", url: server.url });
  await connectors.signIn("linear");
  assert.equal(opened, 1);
  server.expire();
  await connectors.update("linear", { name: "Linear" });
  const result = await connectors.call("linear", "echo", { text: "again" });
  assert.equal(result.content[0].text, "echo: again");
  assert.equal(opened, 1);
  assert.ok(server.state.tokenRequests.some((request) => request.grant_type === "refresh_token"));
});

test("a refused refresh asks for sign-in instead of opening a browser", async (t) => {
  const server = await fake(t);
  let opened = 0;
  const { connectors } = fixture(t, {
    openBrowser: (url) => {
      opened += 1;
      followInBrowser(url);
    },
  });
  await connectors.add({ name: "Mobbin", url: server.url });
  await connectors.signIn("mobbin");
  server.expire();
  server.state.refreshes.clear();
  await connectors.update("mobbin", {});
  await assert.rejects(connectors.call("mobbin", "echo", {}));
  assert.equal(connectors.get("mobbin").state, "needs-sign-in");
  assert.equal(opened, 1);
});

test("account routing and sign-out", async (t) => {
  const server = await fake(t);
  const { connectors } = fixture(t);
  await connectors.add({ name: "Slack", url: server.url });
  await connectors.signIn("slack");
  assert.equal(connectors.allows("slack", "claude", "acct-1"), true);
  connectors.setAccess("slack", "claude", "acct-1", false);
  assert.equal(connectors.allows("slack", "claude", "acct-1"), false);
  assert.equal(connectors.allows("slack", "codex", "acct-1"), true);
  assert.deepEqual(connectors.get("slack").off, ["claude:acct-1"]);
  assert.deepEqual(connectors.ready("claude", "acct-1"), []);
  assert.deepEqual(
    connectors.ready("codex", "acct-1").map(({ connector, tools }) => [connector.id, tools.map((tool) => tool.name)]),
    [["slack", ["echo", "post"]]],
  );
  connectors.setAccess("slack", "claude", "acct-1", true);
  assert.deepEqual(connectors.get("slack").off, []);

  const signedOut = await connectors.signOut("slack");
  assert.equal(signedOut.state, "needs-sign-in");
  assert.equal(server.state.revoked.length, 1);
  await connectors.remove("slack");
  assert.deepEqual(connectors.list(), []);
});

test("a server that needs no sign-in connects on add", async (t) => {
  const server = await fake(t, { requireAuth: false });
  const { connectors } = fixture(t);
  const added = await connectors.add({ name: "Docs", url: server.url });
  assert.equal(added.state, "connected");
});

test("an API-key server connects with its headers, which never leave the computer", async (t) => {
  const server = await fake(t, { requireAuth: false, apiKey: "k-123" });
  const { connectors } = fixture(t);
  const added = await connectors.add({ name: "GitHub", url: server.url, headers: { "X-Api-Key": "k-123" } });
  assert.equal(added.state, "connected");
  assert.deepEqual(added.headers, ["X-Api-Key"]);
  assert.equal(JSON.stringify(connectors.list()).includes("k-123"), false);
  const kept = await connectors.update("github", { headers: { "X-Api-Key": "••••••" } });
  assert.deepEqual(kept.headers, ["X-Api-Key"]);
  assert.equal((await connectors.check("github")).state, "connected", "a masked value keeps the stored key");
  await connectors.update("github", { headers: { "X-Api-Key": "wrong" } });
  assert.equal((await connectors.check("github")).state, "failed");
  await assert.rejects(connectors.add({ name: "Bad", url: server.url, headers: { "Bad Header": "x" } }), /header name/);
});

test("names, ids and addresses", () => {
  assert.equal(idFor("Slack company A", new Set()), "slack_company_a");
  assert.equal(idFor("Slack company A", new Set(["slack_company_a"])), "slack_company_2");
  assert.equal(idFor("Ação Café", new Set()), "acao_cafe");
  assert.equal(idFor("42", new Set()), "connector");
  assert.equal(connectorUrl("https://mcp.slack.com/mcp#x"), "https://mcp.slack.com/mcp");
  assert.equal(connectorUrl("http://127.0.0.1:3000/mcp"), "http://127.0.0.1:3000/mcp");
  assert.throws(() => connectorUrl("http://example.com/mcp"), /https/);
  assert.throws(() => connectorUrl("https://user:pw@example.com/mcp"), /password/);
});
