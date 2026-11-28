const test = require("node:test");
const assert = require("node:assert/strict");
const { connectorHeaders, connectorEnv } = require("./input.cjs");

const MASK = "••••••";

test("a masked header keeps the stored value under the same name", () => {
  assert.deepEqual(connectorHeaders({ "X-Api-Key": MASK }, { "X-Api-Key": "secret" }), { "X-Api-Key": "secret" });
});

test("a masked header under a new name is refused instead of saved as the mask", () => {
  assert.throws(() => connectorHeaders({ "X-Api-Key": MASK }, { Authorization: "secret" }), /X-Api-Key/);
  assert.throws(() => connectorHeaders({ Authorization: MASK }), /Authorization/);
});

test("a masked env var keeps the stored value under the same name", () => {
  assert.deepEqual(connectorEnv({ TOKEN: MASK }, { TOKEN: "secret" }), { TOKEN: "secret" });
});

test("a masked env var under a new name is refused instead of saved as the mask", () => {
  assert.throws(() => connectorEnv({ NEW_TOKEN: MASK }, { TOKEN: "secret" }), /NEW_TOKEN/);
  assert.throws(() => connectorEnv({ NEW_TOKEN: MASK }), /NEW_TOKEN/);
});
