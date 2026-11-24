const test = require("node:test");
const assert = require("node:assert/strict");
const { createCommandDispatcher } = require("../command-dispatcher.cjs");
const { connectorToolDefinitions, milagreToolName, serverToolName, toolResult } = require("./tools.cjs");

const SEARCH = {
  name: "slack_search_public_and_private",
  description: "Search messages",
  inputSchema: { type: "object", properties: { query: { type: "string", description: "What to find" }, limit: { type: "integer" } }, required: ["query"] },
  annotations: { readOnlyHint: true },
};
const SEND = { name: "slack_send_message", description: "Send a message", inputSchema: { type: "object", properties: { text: { type: "string" } } } };

function fakeConnectors(off = []) {
  const calls = [];
  return {
    calls,
    ready: (provider, accountId) =>
      off.includes(`${provider}:${accountId}`) ? [] : [{ connector: { id: "slack_company_a", name: "Slack company A" }, tools: [SEARCH, SEND] }],
    call: async (id, name, args) => {
      calls.push({ id, name, args });
      return { content: [{ type: "text", text: `${name} ok` }] };
    },
  };
}

test("connector tools reach a Chat through milagre with the upstream schema and annotations", async () => {
  const connectors = fakeConnectors();
  const definitions = connectorToolDefinitions(connectors, { provider: "codex", accountId: "a1" });
  assert.deepEqual(
    definitions.map((definition) => [definition.name, definition.readOnly, definition.connector]),
    [
      ["slack_company_a__slack_search_public_and_private", true, "slack_company_a"],
      ["slack_company_a__slack_send_message", false, "slack_company_a"],
    ],
  );
  const dispatcher = createCommandDispatcher({ definitions: () => definitions });
  const listed = dispatcher.list();
  assert.equal(listed[0].description, "Slack company A: Search messages");
  assert.deepEqual(listed[0].inputSchema.required, ["query"]);
  assert.equal(listed[0].inputSchema.properties.query.description, "What to find");
  assert.equal(listed[0].annotations.readOnlyHint, true);

  const result = await dispatcher.run(null, listed[0].name, { query: "launch", limit: 5 });
  assert.deepEqual(result, { text: "slack_search_public_and_private ok", images: [], isError: false });
  assert.deepEqual(connectors.calls, [{ id: "slack_company_a", name: "slack_search_public_and_private", args: { query: "launch", limit: 5 } }]);
  assert.equal((await dispatcher.run(null, listed[0].name, { limit: 5 })).isError, true, "upstream required fields are enforced");
});

test("an Account the connector is turned off for gets none of its tools", () => {
  const connectors = fakeConnectors(["claude:work"]);
  assert.deepEqual(connectorToolDefinitions(connectors, { provider: "claude", accountId: "work" }), []);
  assert.equal(connectorToolDefinitions(connectors, { provider: "claude", accountId: "home" }).length, 2);
  assert.deepEqual(connectorToolDefinitions(connectors, undefined), [], "a Chat without a running agent gets no connector tools");
});

test("tool names fit the 64-character limit with their prefixes", () => {
  const long = "x".repeat(80);
  assert.equal(`mcp__milagre__${milagreToolName("slack_company_a", long)}`.length, 64);
  assert.equal(`mcp__slack_company_a__${serverToolName("slack_company_a", long)}`.length, 64);
  assert.notEqual(milagreToolName("a", `${long}1`), milagreToolName("a", `${long}2`));
  assert.equal(milagreToolName("linear", "get issue"), "linear__get_issue");
});

test("upstream content flattens to text and images; an error result fails the call", () => {
  assert.deepEqual(
    toolResult({
      content: [
        { type: "text", text: "one" },
        { type: "image", data: "AAA", mimeType: "image/png" },
        { type: "resource", resource: { uri: "file:///a", text: "inline" } },
        { type: "resource_link", uri: "https://x/y", name: "Doc" },
      ],
    }),
    { text: "one\n\ninline\n\nDoc: https://x/y", images: [{ base64: "AAA", mime: "image/png" }] },
  );
  assert.deepEqual(toolResult({ content: [], structuredContent: { ok: true } }).text, '{"ok":true}');
  assert.throws(() => toolResult({ content: [{ type: "text", text: "channel_not_found" }], isError: true }), /channel_not_found/);
});

test("a schema zod can't read falls back to one arguments object", async () => {
  const connectors = {
    ready: () => [{ connector: { id: "odd", name: "Odd" }, tools: [{ name: "t", inputSchema: { type: "string" } }] }],
    call: async (_id, _name, args) => ({ content: [{ type: "text", text: JSON.stringify(args) }] }),
  };
  const [definition] = connectorToolDefinitions(connectors, { provider: "pi", accountId: "x" });
  assert.deepEqual(Object.keys(definition.input), ["arguments"]);
  assert.equal((await definition.run({ arguments: { a: 1 } })).text, '{"a":1}');
});
