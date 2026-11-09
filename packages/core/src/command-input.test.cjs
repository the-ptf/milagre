const test = require("node:test");
const assert = require("node:assert/strict");
const { contractFor, argumentsFor, inputForFlags } = require("./command-input.cjs");
test("artifact transport accepts held font keys and rejects malformed font inventories", () => {
  const contract = contractFor("artifact:get");
  const request = { chatId: "/p#1", id: "home", fonts: { have: ["a".repeat(64)] } };
  assert.deepEqual(argumentsFor(contract, [request]), [request]);
  assert.deepEqual(argumentsFor(contract, [{ chatId: "/p#1", id: "home" }]), [{ chatId: "/p#1", id: "home" }]);
  assert.throws(() => argumentsFor(contract, [{ ...request, fonts: { have: [1] } }]), /Invalid arguments/);
  assert.throws(() => argumentsFor(contract, [{ ...request, fonts: { typo: [] } }]), /Invalid arguments/);
});
test("UI object inputs produce named flags with required fields, unions and nested JSON", () => {
  const contract = contractFor("terminal:open");
  assert.ok(contract.inputSchema.properties.chatId);
  const input = inputForFlags(contract.inputSchema, [
    ["chat-id", "p#1"],
    ["cols", "100"],
  ]);
  assert.deepEqual(argumentsFor(contract, input), [{ chatId: "p#1", cols: 100 }]);
  assert.throws(
    () =>
      inputForFlags(contract.inputSchema, [
        ["chat-id", "p#1"],
        ["cols", "oops"],
      ]),
    /cols/,
  );
  assert.throws(() => argumentsFor(contract, { cols: 100 }), /chatId/);
  assert.throws(() => inputForFlags(contract.inputSchema, [["unknown", "x"]]), /Unknown flag/);
});
test("positional RPC and named inputs use the same typed contract without shifting optional arguments", () => {
  const contract = contractFor("chat:patch");
  assert.deepEqual(argumentsFor(contract, { projectPath: "/p", sessionId: 3, patch: { title: "Renamed" } }), ["/p", 3, { title: "Renamed" }]);
  assert.throws(() => argumentsFor(contract, { projectPath: "/p", sessionId: "3", patch: {} }), /sessionId/);
  assert.throws(() => argumentsFor(contract, { projectPath: "/p", sessionId: 3, patch: {}, typo: 1 }), /typo/);
});
test("desktop dialog inputs and owner project inputs retain distinct signatures", () => {
  assert.deepEqual(argumentsFor(contractFor("project:open", { desktop: true }), {}), []);
  assert.deepEqual(argumentsFor(contractFor("project:open"), { folder: "/p" }), ["/p"]);
});
test("nullable fields retain explicit null and reserved names do not change CLI scope", () => {
  const contract = contractFor("accounts:assign");
  const input = inputForFlags(contract.inputSchema, [
    ["scope-key", "/p"],
    ["provider", "claude"],
    ["account-id", "null"],
  ]);
  assert.deepEqual(argumentsFor(contract, input), ["/p", "claude", null]);
  const channel = contractFor("update:set-channel", { desktop: true });
  assert.deepEqual(argumentsFor(channel, inputForFlags(channel.inputSchema, [["arg-channel", "beta"]])), ["beta"]);
});

test("Git diff contracts accept a null commit as an omitted selection", () => {
  for (const channel of ["git:diff-files", "git:diff-file"]) {
    const request = { cwd: "/project", mode: "uncommitted", commit: null, ...(channel === "git:diff-file" ? { path: "file.txt" } : {}) };
    assert.deepEqual(argumentsFor(contractFor(channel), request), [request]);
  }
});
