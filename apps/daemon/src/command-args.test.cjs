const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCommandArgs } = require("./command-args.cjs");
test("global selectors and typed command flags remain separate", () => {
  const parsed = parseCommandArgs(["tasks", "set", "--chat", "/p#1", '--tasks=[{"title":"T"}]', "--json"]);
  assert.deepEqual(parsed, { positionals: ["tasks", "set"], values: { chat: "/p#1", json: true }, flags: [["tasks", '[{"title":"T"}]']] });
  assert.deepEqual(parseCommandArgs(["serve", "--project", "/a", "--project", "/b"]).values.project, ["/a", "/b"]);
  assert.deepEqual(parseCommandArgs(["desktop", "update", "set-channel", "--arg-channel", "beta"]).flags, [["arg-channel", "beta"]]);
  assert.deepEqual(parseCommandArgs(["x", "y", "--enabled", "--count", "-2"]).flags, [
    ["enabled", true],
    ["count", "-2"],
  ]);
  assert.throws(() => parseCommandArgs(["serve", "--typo"]), /serve option/);
  assert.throws(() => parseCommandArgs(["x", "--chat"]), /requires a value/);
  assert.throws(() => parseCommandArgs(["x", "--chat", "a", "--chat", "b"]), /Repeated flag/);
});
