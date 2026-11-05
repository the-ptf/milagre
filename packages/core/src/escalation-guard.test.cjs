const assert = require("node:assert/strict");
const test = require("node:test");
const { ESCALATION_TOOL_CALLS, ESCALATION_TOOL_GRACE } = require("@milagre/shared/subchat-escalation");
const { EscalationTurn, ONLY_READS, acpCall, canEscalate, claudeCall, codexMcpCall, turnGuards } = require("./escalation-guard.cjs");

const GUARD = { level: "escalation", requests: [{ chatId: "/p#2", requestId: "r1" }] };
const tools = [
  { name: "chat_read", readOnly: true },
  { name: "chat_respond", readOnly: false },
  { name: "tasks_set", readOnly: false },
];

test("an escalation turn allows reads and chat_respond on its own requests, and refuses the rest", () => {
  const turn = new EscalationTurn(GUARD, () => {});
  assert.equal(turn.denial({ name: "Read", readOnly: true }), null);
  assert.equal(turn.denial({ name: "chat_respond", input: { chatId: "/p#2", requestId: "r1" } }), null);
  assert.equal(turn.denial({ name: "chat_respond", input: { chatId: "/p#2", requestId: "other" } }), ONLY_READS);
  assert.equal(turn.denial({ name: "chat_respond", input: { chatId: "/p#3", requestId: "r1" } }), ONLY_READS);
  for (const name of ["Bash", "Write", "tasks_set", "chat_stop", "delegate", "request_secret", "AskUserQuestion"])
    assert.equal(turn.denial({ name }), ONLY_READS, name);
});

test("past its tool calls a turn is told to reply, and stopped only if it keeps trying after the grace", () => {
  let stops = 0;
  const turn = new EscalationTurn(GUARD, () => (stops += 1));
  const read = () => {
    turn.called();
    return turn.denial({ name: "Read", readOnly: true });
  };
  for (let call = 0; call < ESCALATION_TOOL_CALLS; call++) assert.equal(read(), null);
  for (let call = 0; call < ESCALATION_TOOL_GRACE; call++) assert.match(read(), /reply to the human now/);
  assert.equal(stops, 0);
  assert.match(read(), /reply to the human now/);
  assert.equal(stops, 1);
  read();
  assert.equal(stops, 1, "stopped once");
});

test("each provider's call says what the tool is", () => {
  assert.deepEqual(claudeCall("Read", { file_path: "/a" }, tools), { name: "Read", input: { file_path: "/a" }, readOnly: true });
  assert.equal(claudeCall("Bash", { command: "ls" }, tools).readOnly, false);
  assert.equal(claudeCall("mcp__milagre__chat_read", {}, tools).readOnly, true);
  assert.equal(claudeCall("mcp__milagre__chat_respond", {}, tools).name, "chat_respond");
  assert.equal(claudeCall("mcp__notion__search", {}, tools).readOnly, false, "another server's tool can't be known to be a read");

  const codex = (serverName, tool, args) => ({
    serverName,
    message: `Allow the ${serverName} MCP server to run tool "${tool}"?`,
    _meta: { tool_params: args },
  });
  assert.deepEqual(codexMcpCall(codex("milagre", "chat_respond", { chatId: "/p#2" }), tools), {
    name: "chat_respond",
    input: { chatId: "/p#2" },
    readOnly: false,
  });
  assert.equal(codexMcpCall(codex("milagre", "chat_read", {}), tools).readOnly, true);
  assert.deepEqual(codexMcpCall(codex("notion", "chat_read", {}), tools), { name: "" });

  const mcp = (server, tool) => ({ kind: "other", rawInput: { arguments: { chatId: "/p#2" } }, _meta: { mcp: { server, tool } } });
  assert.deepEqual(acpCall(mcp("milagre", "chat_respond"), tools), { name: "chat_respond", input: { chatId: "/p#2" }, readOnly: false });
  assert.equal(acpCall(mcp("notion", "read"), tools).readOnly, false);
  assert.equal(acpCall({ kind: "read", title: "view_file" }, tools).readOnly, true);
  assert.equal(acpCall({ kind: "search", title: "grep" }, tools).readOnly, true);
  for (const kind of ["edit", "execute", "fetch", "delete", "other"]) assert.equal(acpCall({ kind, title: "t" }, tools).readOnly, false, kind);
});

test("a babysit guard stays the session's own, and a wake's never reaches babysitDenial", () => {
  const stop = () => {};
  assert.deepEqual(turnGuards({ level: 2, resolveThreads: false }, stop), { guard: { level: 2, resolveThreads: false }, escalation: null });
  assert.deepEqual(turnGuards(undefined, stop), { guard: null, escalation: null });
  const { guard, escalation } = turnGuards(GUARD, stop);
  assert.equal(guard, null);
  assert.ok(escalation instanceof EscalationTurn);
});

test("only a provider with a gate over every tool can be woken", () => {
  for (const provider of ["claude", "codex", "antigravity", "kiro"]) assert.equal(canEscalate(provider), true, provider);
  assert.equal(canEscalate("something-new"), false);
});
