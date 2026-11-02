const test = require("node:test");
const assert = require("node:assert/strict");
const { createAccountRouting } = require("./account-routing.cjs");

test("provider services are pinned to effective accounts and never mix scopes", async () => {
  const overrides = { "/a": "a", "/b": "b" };
  let current = "a";
  const accounts = {
    selected: (_p, scope) => overrides[scope] ?? current,
    environment: (_p, id) => {
      if (id === "removed") throw new Error("Account not found.");
      return { PROFILE: id };
    },
  };
  const seen = [];
  const factory =
    ({ cli }) =>
    async () => {
      const result = await cli("claude");
      seen.push(result);
      return result.env?.PROFILE ?? result.problem;
    };
  const routing = createAccountRouting({ accounts, cli: async () => ({ command: "/cli" }), statusFactory: factory, modelsFactory: factory });
  const a = routing.services("/a");
  const b = routing.services("/b");
  current = "b";
  assert.equal(await a.status(), "a");
  assert.equal(await b.models(), "b");
  assert.equal(await routing.services().models(), "b");
  assert.equal(await routing.services("/a").models(), "a");
  overrides["/a"] = "removed";
  const missing = await routing.cli("claude", "/a");
  assert.match(missing.problem, /not found/);
  assert.equal(missing.env, undefined);
  assert.equal(seen[0].accountId, "a");
});

test("the selection covers every provider, Antigravity included", () => {
  const accounts = { selected: (provider) => `${provider}-id`, environment: () => ({}) };
  const routing = createAccountRouting({ accounts, cli: async () => ({}), statusFactory: () => () => {}, modelsFactory: () => () => {} });
  assert.deepEqual(routing.selection(), { codex: "codex-id", claude: "claude-id", antigravity: "antigravity-id", kiro: "kiro-id" });
});
