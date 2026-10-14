const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CANCELLED_MESSAGE,
  DENIED_MESSAGE,
  PendingPermissions,
  capText,
  claudeRequest,
  insideRoot,
  claudeResult,
  codexChangesDiff,
  codexCommandRequest,
  codexDecision,
  codexFileRequest,
  codexMcpRequest,
  codexMcpResponse,
  isAcpPlanToolPermission,
  isCodexPlanToolApproval,
  unwrapShell,
} = require("./permissions.cjs");
const { PLAN_TOOL_NAMES } = require("../chat-plan-tools.cjs");

test("Codex: MCP approvals show the exact call without offering permanent grants", () => {
  const params = {
    serverName: "milagre",
    mode: "form",
    message: 'Allow the milagre MCP server to run tool "design_show"?',
    requestedSchema: { type: "object", properties: {} },
    _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"], tool_description: "Create a design", tool_params: { id: "screen" } },
  };
  assert.deepEqual(codexMcpRequest("mcp-1", params), {
    requestId: "mcp-1",
    kind: "other",
    tool: "MCP: milagre",
    title: params.message,
    description: "Create a design",
    detail: '{\n  "id": "screen"\n}',
    allowForChat: false,
  });
  assert.equal(codexMcpRequest("mcp-1", { ...params, mode: "url", url: "https://example.com/login" }), null);
  assert.equal(codexMcpRequest("mcp-1", { ...params, _meta: {} }), null);
  assert.equal(codexMcpRequest("mcp-1", { ...params, requestedSchema: { type: "object", properties: { name: { type: "string" } } } }), null);
  assert.equal(codexMcpRequest("mcp-1", { ...params, requestedSchema: { type: "object", properties: {}, required: ["name"] } }), null);
  assert.deepEqual(codexMcpResponse("allow"), { action: "accept", content: {} });
  assert.deepEqual(codexMcpResponse("deny"), { action: "decline", content: null });
  assert.deepEqual(codexMcpResponse("cancelled"), { action: "cancel", content: null });
});

test("Codex: only Milagre's own plan tools are auto-approved", () => {
  const params = (tool, extra = {}) => ({
    serverName: "milagre",
    mode: "form",
    message: `Allow the milagre MCP server to run tool "${tool}"?`,
    requestedSchema: { type: "object", properties: {} },
    _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"], tool_params: {} },
    ...extra,
  });
  assert.deepEqual(PLAN_TOOL_NAMES, ["tasks_set", "task_update", "tasks_read", "phase_set"]);
  for (const name of PLAN_TOOL_NAMES) assert.equal(isCodexPlanToolApproval(params(name)), true, name);
  assert.equal(isCodexPlanToolApproval(params("design_show")), false);
  assert.equal(isCodexPlanToolApproval(params("tasks_set", { serverName: "other" })), false);
  assert.equal(isCodexPlanToolApproval(params("tasks_set", { _meta: { codex_approval_kind: "other" } })), false);
  assert.equal(isCodexPlanToolApproval(params("tasks_set", { requestedSchema: { type: "object", properties: { name: { type: "string" } } } })), false);
  assert.equal(isCodexPlanToolApproval(params("tasks_set", { message: "Allow the milagre MCP server to run a tool?" })), false);
  assert.equal(isCodexPlanToolApproval({}), false);
});

test("ACP: only Milagre's own plan tools are auto-approved", () => {
  const call = (server, tool) => ({
    toolCall: { toolCallId: "c1", kind: "other", status: "pending", title: `${server}_${tool}`, _meta: { mcp: { server, tool }, is_mcp_tool_call: true } },
  });
  for (const name of PLAN_TOOL_NAMES) assert.equal(isAcpPlanToolPermission(call("milagre", name)), true, name);
  assert.equal(isAcpPlanToolPermission(call("milagre", "design_show")), false);
  assert.equal(isAcpPlanToolPermission(call("other", "tasks_set")), false);
  assert.equal(isAcpPlanToolPermission({ toolCall: { title: "milagre_tasks_set", kind: "other" } }), false);
  assert.equal(isAcpPlanToolPermission({}), false);
});

function pending() {
  const events = [];
  const answers = [];
  const permissions = new PendingPermissions((event) => events.push(event));
  const ask = (requestId) =>
    permissions.add({ requestId, kind: "other", tool: "T", title: "Allow?", allowForChat: false }, (decision) => answers.push({ requestId, decision }));
  return { permissions, events, answers, ask };
}

test("each request is announced, then answered exactly once", () => {
  const { permissions, events, answers, ask } = pending();
  ask("a");
  assert.equal(permissions.size, 1);
  assert.equal(permissions.resolve("a", "allow"), true);
  assert.equal(permissions.resolve("a", "deny"), false);
  assert.equal(permissions.resolve("missing", "allow"), false);
  assert.deepEqual(answers, [{ requestId: "a", decision: "allow" }]);
  assert.deepEqual(events, [
    { type: "permission-request", requestId: "a", kind: "other", tool: "T", title: "Allow?", allowForChat: false },
    { type: "permission-resolved", requestId: "a", decision: "allow" },
  ]);
  assert.equal(permissions.size, 0);
});

test("cancelAll answers every waiting request as cancelled", () => {
  const { permissions, events, answers, ask } = pending();
  ask("a");
  ask("b");
  permissions.cancelAll();
  assert.deepEqual(
    answers.map((answer) => answer.decision),
    ["cancelled", "cancelled"],
  );
  assert.deepEqual(
    events.filter((event) => event.type === "permission-resolved").map((event) => event.requestId),
    ["a", "b"],
  );
  assert.equal(permissions.size, 0);
});

test("always allowing in this chat can't exceed what the request offered", () => {
  const { permissions, events, answers, ask } = pending();
  ask("a");
  permissions.add({ requestId: "b", kind: "other", tool: "T", title: "Allow?", allowForChat: true }, (decision) => answers.push({ requestId: "b", decision }));
  permissions.resolve("a", "allow-for-chat");
  permissions.resolve("b", "allow-for-chat");
  assert.deepEqual(answers, [
    { requestId: "a", decision: "allow" },
    { requestId: "b", decision: "allow-for-chat" },
  ]);
  assert.deepEqual(
    events.filter((event) => event.type === "permission-resolved").map((event) => event.decision),
    ["allow", "allow-for-chat"],
  );
});

test("switching to Auto answers waiting edits inside the worktree; Full answers everything", () => {
  const { permissions, events, answers } = pending();
  const add = (requestId, kind, inWorkspace) =>
    permissions.add({ requestId, kind, tool: "T", title: "Allow?", allowForChat: false }, (decision) => answers.push({ requestId, decision }), { inWorkspace });
  add("edit", "edit", true);
  add("outside", "edit", false);
  add("command", "command", true);
  permissions.setMode("auto");
  assert.deepEqual(answers, [{ requestId: "edit", decision: "allow" }]);
  permissions.setMode("full");
  assert.deepEqual(
    answers.map((answer) => answer.requestId),
    ["edit", "outside", "command"],
  );
  assert.deepEqual(
    events.filter((event) => event.type === "permission-resolved").map((event) => event.requestId),
    ["edit", "outside", "command"],
  );
  assert.equal(permissions.size, 0);
});

test("in Full a request is answered without a card; in Auto the agent's own rules still ask", () => {
  const { permissions, events, answers } = pending();
  const add = (requestId, kind) =>
    permissions.add({ requestId, kind, tool: "T", title: "Allow?", allowForChat: false }, (decision) => answers.push({ requestId, decision }), {
      inWorkspace: true,
    });
  permissions.setMode("full");
  add("command", "command");
  assert.deepEqual(answers, [{ requestId: "command", decision: "allow" }]);
  assert.equal(events.length, 0);
  permissions.setMode("auto");
  add("edit", "edit");
  assert.equal(permissions.size, 1);
});

test("insideRoot", () => {
  assert.equal(insideRoot("/repo", ["/repo/a.txt", "src/b.ts"]), true);
  assert.equal(insideRoot("/repo", ["/repo/a.txt", "/etc/hosts"]), false);
  assert.equal(insideRoot("/repo", ["/repo-other/a.txt"]), false);
  assert.equal(insideRoot("/repo", ["/repo"]), false);
});

test("forget drops a withdrawn request without answering it", () => {
  const { permissions, events, answers, ask } = pending();
  ask("a");
  assert.equal(permissions.forget("a"), true);
  assert.equal(permissions.forget("a"), false);
  assert.deepEqual(answers, []);
  assert.deepEqual(events.at(-1), { type: "permission-resolved", requestId: "a", decision: "cancelled" });
});

test("Claude: a shell command shows the command", () => {
  const request = claudeRequest(
    "Bash",
    { command: "npm test", description: "Run tests" },
    { requestId: "r1", toolUseID: "t1", suggestions: [{ type: "addRules" }] },
  );
  assert.deepEqual(request, {
    requestId: "r1",
    kind: "command",
    tool: "Bash",
    title: "Run this command?",
    command: "npm test",
    allowForChat: true,
    stepId: "t1",
  });
});

test("Claude: edits show the file and a diff", () => {
  const write = claudeRequest("Write", { file_path: "/repo/hello.txt", content: "hi\nthere" }, { requestId: "r1" });
  assert.deepEqual(write, {
    requestId: "r1",
    kind: "edit",
    tool: "Write",
    title: "Write hello.txt?",
    files: ["/repo/hello.txt"],
    diff: "+hi\n+there",
    allowForChat: false,
  });
  const edit = claudeRequest("Edit", { file_path: "/repo/a.ts", old_string: "let a", new_string: "const a" }, { requestId: "r2" });
  assert.equal(edit.title, "Edit a.ts?");
  assert.equal(edit.diff, "-let a\n+const a");
  const multi = claudeRequest(
    "MultiEdit",
    {
      file_path: "/repo/a.ts",
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "c", new_string: "d" },
      ],
    },
    { requestId: "r3" },
  );
  assert.equal(multi.diff, "-a\n+b\n@@\n-c\n+d");
});

test("Claude: other tools show their input, and the SDK's own wording wins", () => {
  const fetch = claudeRequest("WebFetch", { url: "https://example.com" }, { requestId: "r1" });
  assert.equal(fetch.kind, "other");
  assert.equal(fetch.title, "Use WebFetch?");
  assert.equal(fetch.detail, JSON.stringify({ url: "https://example.com" }, null, 2));
  const worded = claudeRequest(
    "Read",
    { file_path: "/etc/hosts" },
    {
      requestId: "r2",
      title: "Claude wants to read hosts",
      displayName: "Read file",
      description: "Outside the project",
      decisionReason: "Not in the allow list",
    },
  );
  assert.equal(worded.title, "Claude wants to read hosts");
  assert.equal(worded.tool, "Read file");
  assert.equal(worded.description, "Outside the project");
  assert.equal(worded.reason, "Not in the allow list");
  const blocked = claudeRequest("Bash", { command: "cat ~/x" }, { requestId: "r3", blockedPath: "/Users/me/x" });
  assert.equal(blocked.reason, "Reaches outside this chat's folder: /Users/me/x");
});

test("Claude: always-allow is offered only with suggestions the SDK lets us keep", () => {
  const suggestions = [{ type: "setMode", mode: "acceptEdits", destination: "session" }];
  assert.equal(claudeRequest("Write", { file_path: "/a" }, { requestId: "r", suggestions }).allowForChat, true);
  assert.equal(claudeRequest("Write", { file_path: "/a" }, { requestId: "r", suggestions: [] }).allowForChat, false);
  assert.equal(claudeRequest("Write", { file_path: "/a" }, { requestId: "r", suggestions, suppressAlwaysAllowRule: true }).allowForChat, false);
});

test("Claude: answers become SDK permission results, and chat-wide rules stay in the session", () => {
  const input = { command: "npm test" };
  const suggestions = [
    { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "localSettings" },
    { type: "setMode", mode: "acceptEdits", destination: "userSettings" },
  ];
  assert.deepEqual(claudeResult("allow", input, suggestions), { behavior: "allow", updatedInput: input });
  assert.deepEqual(claudeResult("allow-for-chat", input, suggestions), {
    behavior: "allow",
    updatedInput: input,
    updatedPermissions: [
      { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "session" },
      { type: "setMode", mode: "acceptEdits", destination: "session" },
    ],
  });
  assert.deepEqual(claudeResult("deny", input, suggestions), { behavior: "deny", message: DENIED_MESSAGE });
  assert.deepEqual(claudeResult("cancelled", input, suggestions), { behavior: "deny", message: CANCELLED_MESSAGE, interrupt: true });
  assert.equal(DENIED_MESSAGE, "Denied in Milagre");
});

test("Codex: the shell wrapper is removed from commands", () => {
  assert.equal(unwrapShell("/bin/zsh -lc 'ls -la'"), "ls -la");
  assert.equal(unwrapShell("/bin/bash -lc 'echo '\\''hi'\\'''"), "echo 'hi'");
  assert.equal(unwrapShell("git status"), "git status");
  assert.equal(unwrapShell("/bin/zsh -lc ls"), "ls");
  assert.equal(unwrapShell("/usr/bin/bash -lc pwd"), "pwd");
  assert.equal(unwrapShell("/bin/zsh -lc ls -la"), "/bin/zsh -lc ls -la");
});

test("Codex: command requests", () => {
  assert.deepEqual(codexCommandRequest("srv-1", { itemId: "c", command: "/bin/zsh -lc 'rm -rf build'", cwd: "/repo", reason: "Clean the build" }), {
    requestId: "srv-1",
    kind: "command",
    tool: "Shell",
    title: "Run this command?",
    command: "rm -rf build",
    cwd: "/repo",
    reason: "Clean the build",
    allowForChat: true,
    stepId: "c",
  });
  assert.deepEqual(codexCommandRequest(7, { command: "curl x", reason: null, networkApprovalContext: { host: "example.com", protocol: "https" } }), {
    requestId: "7",
    kind: "command",
    tool: "Shell",
    title: "Allow network access to example.com?",
    command: "curl x",
    allowForChat: true,
  });
});

test("Codex: file requests show the changes Codex reported when the edit started", () => {
  const changes = [{ path: "/repo/notes.txt", kind: { type: "add" }, diff: "hello\n" }];
  assert.deepEqual(codexFileRequest("srv-2", { itemId: "p", reason: "Write notes" }, changes), {
    requestId: "srv-2",
    kind: "edit",
    tool: "Edit files",
    title: "Edit notes.txt?",
    files: ["/repo/notes.txt"],
    diff: "--- /repo/notes.txt\n+hello\n",
    reason: "Write notes",
    allowForChat: true,
    stepId: "p",
  });
  assert.equal(codexFileRequest("s", {}, [changes[0], { path: "/repo/b", diff: "" }]).title, "Edit 2 files?");
  assert.deepEqual(codexFileRequest("s", { grantRoot: "/tmp/out" }, undefined), {
    requestId: "s",
    kind: "edit",
    tool: "Edit files",
    title: "Allow writing to /tmp/out?",
    files: [],
    allowForChat: true,
  });
});

test("Codex: added and deleted files get +/- markers, real diffs are left alone", () => {
  const diffOf = (kind, diff) => codexFileRequest("s", {}, [{ path: "/r/a", kind, diff }]).diff;
  assert.equal(diffOf({ type: "add" }, "hello\nworld\n"), "--- /r/a\n+hello\n+world\n");
  assert.equal(diffOf({ type: "add" }, "a\n\nb"), "--- /r/a\n+a\n+\n+b");
  assert.equal(diffOf({ type: "delete" }, "gone\n"), "--- /r/a\n-gone\n");
  assert.equal(diffOf({ type: "add" }, "+hello\n"), "--- /r/a\n++hello\n");
  assert.equal(diffOf({ type: "add" }, "@@ -0,0 +1 @@\n+hello\n"), "--- /r/a\n@@ -0,0 +1 @@\n+hello\n");
  const update = "@@ -1 +1 @@\n-a\n+b\n";
  assert.equal(diffOf({ type: "update", move_path: null }, update), "--- /r/a\n" + update);
  assert.equal(diffOf({ type: "add" }, ""), "--- /r/a\n");
  const big = codexFileRequest("s", {}, [{ path: "/r/a", kind: { type: "add" }, diff: "x\n".repeat(20_000) }]).diff;
  assert.ok(big.endsWith("\n… truncated") && big.startsWith("--- /r/a\n+x\n+x"));
});

test("Codex: new and deleted files are whole contents; updates are already diffs", () => {
  assert.equal(
    codexChangesDiff([
      { path: "/repo/new.txt", kind: { type: "add" }, diff: "one\ntwo\n" },
      { path: "/repo/old.txt", kind: { type: "delete" }, diff: "gone\n" },
      { path: "/repo/app.js", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-Hello\n+Hi\n" },
    ]),
    "--- /repo/new.txt\n+one\n+two\n\n--- /repo/old.txt\n-gone\n\n--- /repo/app.js\n@@ -1 +1 @@\n-Hello\n+Hi\n",
  );
});

test("Codex: decisions", () => {
  assert.deepEqual(["allow", "allow-for-chat", "deny", "cancelled"].map(codexDecision), ["accept", "acceptForSession", "decline", "cancel"]);
});

test("long diffs and details are capped", () => {
  assert.equal(capText("short"), "short");
  const long = capText("x".repeat(25_000));
  assert.equal(long.length, 20_000 + "\n… truncated".length);
  assert.ok(long.endsWith("\n… truncated"));
});
