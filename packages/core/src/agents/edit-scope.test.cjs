const test = require("node:test");
const assert = require("node:assert/strict");
const { ClaudeSession } = require("./claude-provider.cjs");
const { CodexSession } = require("./codex-provider.cjs");
const { AcpSession } = require("./acp-session.cjs");

test("Claude's PreToolUse and approval fallback deny scoped writes even in Full without replacing other permission rules", async () => {
  const session = new ClaudeSession({ cwd: "/work", emit() {}, editScopeCheck: (files) => (files.includes("/work/protected") ? "Protected by scope" : null) });
  session.turnActive = true;
  session.permissions.setMode("full");
  assert.equal(session.scopeHook({ tool_name: "Edit", tool_input: { file_path: "/work/protected" } }).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(session.scopeHook({ tool_name: "Bash", tool_input: { command: "write-anywhere" } }), null, "commands must be described as observation only");
  assert.equal((await session.askPermission("Write", { file_path: "/work/protected", content: "bad" }, { requestId: "x" })).behavior, "deny");
  assert.equal(session.scopeHook({ tool_name: "Read", tool_input: { file_path: "/work/protected" } }), null, "scope must not restrict reads");
  const allowed = await session.askPermission("Write", { file_path: "/work/allowed", content: "ok" }, { requestId: "y" });
  assert.equal(allowed.behavior, "allow");
});
test("Codex denies an intercepted out-of-scope file approval before workspace auto-allow", () => {
  const replies = [];
  const session = new CodexSession({ cwd: "/work", emit() {}, editScopeCheck: () => "Out of scope" });
  session.turnActive = true;
  session.permissions.setMode("full");
  session.reply = (id, response) => replies.push({ id, response });
  session.fileChanges.set("edit", [{ path: "/work/protected", kind: { type: "update" }, diff: "@@" }]);
  session.handleServerRequest(1, "item/fileChange/requestApproval", { itemId: "edit" });
  assert.deepEqual(replies, [{ id: 1, response: { decision: "decline" } }]);
});
test("ACP denies intercepted out-of-scope edits before Auto workspace permissions", () => {
  const replies = [];
  const session = new AcpSession({ cwd: "/work", emit() {}, editScopeCheck: () => "Out of scope" });
  session.turnActive = true;
  session.permissions.setMode("auto");
  session.reply = (id, response) => replies.push({ id, response });
  session.askPermission(1, {
    toolCall: { toolCallId: "edit", kind: "edit", title: "Edit", rawInput: { file_path: "/work/protected" } },
    options: [
      { optionId: "yes", kind: "allow_once" },
      { optionId: "no", kind: "reject_once" },
    ],
  });
  assert.deepEqual(replies, [{ id: 1, response: { outcome: { outcome: "selected", optionId: "no" } } }]);
});

test("Codex checks rename destinations and refuses session-wide roots for a scoped Chat", () => {
  const replies = [];
  const session = new CodexSession({
    cwd: "/work",
    emit() {},
    editScopeCheck: (files) => (!files.length || files.includes("/work/protected") ? "Out of scope" : null),
  });
  session.turnActive = true;
  session.permissions.setMode("full");
  session.reply = (id, response) => replies.push({ id, response });
  session.fileChanges.set("rename", [{ path: "/work/allowed", kind: { type: "update", move_path: "/work/protected" }, diff: "@@" }]);
  session.handleServerRequest(1, "item/fileChange/requestApproval", { itemId: "rename" });
  session.fileChanges.set("edit", [{ path: "/work/allowed", kind: { type: "update", move_path: null }, diff: "@@" }]);
  session.handleServerRequest(2, "item/fileChange/requestApproval", { itemId: "edit", grantRoot: "/work" });
  assert.deepEqual(replies, [
    { id: 1, response: { decision: "decline" } },
    { id: 2, response: { decision: "decline" } },
  ]);
});
