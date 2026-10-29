const test = require("node:test");
const assert = require("node:assert/strict");
const { generate } = require("./generate-command-contracts.cjs");

test("command contracts omit non-JSON symbol keys and stay stable across TypeScript programs", () => {
  const first = generate();
  const second = generate();
  assert.deepEqual(first, second);
  for (const definition of Object.values(first.$defs)) {
    assert.ok(Object.keys(definition.properties ?? {}).every((key) => !key.startsWith("__@")));
    assert.ok((definition.required ?? []).every((key) => !key.startsWith("__@")));
  }
});
