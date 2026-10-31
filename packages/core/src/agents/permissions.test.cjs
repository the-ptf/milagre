const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CANCELLED_MESSAGE,
  DENIED_MESSAGE,
  PERMISSION_MODES,
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
  callerMode,
  isAcpPlanToolPermission,
  isBotRulesTool,
  isCodexPlanToolApproval,
  isUngatedMilagreTool,
  milagreToolOf,
  MODE_RANK,
  raisesMode,
  unwrapShell,
} = require("./permissions.cjs");
const { acpPermissionRequest } = require("./acp-session.cjs");
const { PLAN_TOOL_NAMES } = require("../chat-plan-tools.cjs");
const { ROUTINE_TOOL_NAMES } = require("../routines/tools.cjs");

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

// Codex's approval request for a milagre tool call.
const codexApproval = (tool, extra = {}) => ({
  serverName: "milagre",
  mode: "form",
  message: `Allow the milagre MCP server to run tool "${tool}"?`,
  requestedSchema: { type: "object", properties: {} },
  _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"], tool_params: {} },
  ...extra,
});

// Routine writes (heartbeat_create, routine_create, routine_update, routine_delete, routine_run_now) follow the Chat's
// permission mode like any tool that changes something; only listing Routines runs without a card.
const ROUTINE_WRITES = ROUTINE_TOOL_NAMES.filter((name) => name !== "routine_list");

test("Codex: only Milagre's own plan tools and routine_list are auto-approved; routine writes follow the mode", () => {
  const params = codexApproval;
  assert.deepEqual(PLAN_TOOL_NAMES, ["tasks_set", "task_update", "tasks_read", "phase_set"]);
  for (const name of [...PLAN_TOOL_NAMES, "routine_list"]) assert.equal(isCodexPlanToolApproval(params(name)), true, name);
  for (const name of ROUTINE_WRITES) assert.equal(isCodexPlanToolApproval(params(name)), false, name);
  for (const name of ["project_add", "worktree_link", "worktree_remove", "chat_set_mode", "chat_respond", "delegate"])
    assert.equal(isCodexPlanToolApproval(params(name)), true, `${name} asks on its own card`);
  assert.equal(isCodexPlanToolApproval(params("design_delete")), false);
  assert.equal(isCodexPlanToolApproval(params("chat_start")), false);
  assert.equal(isCodexPlanToolApproval(params("tasks_set", { serverName: "other" })), false);
  assert.equal(isCodexPlanToolApproval(params("tasks_set", { _meta: { codex_approval_kind: "other" } })), false);
  assert.equal(isCodexPlanToolApproval(params("tasks_set", { requestedSchema: { type: "object", properties: { name: { type: "string" } } } })), false);
  assert.equal(isCodexPlanToolApproval(params("tasks_set", { message: "Allow the milagre MCP server to run a tool?" })), false);
  assert.equal(isCodexPlanToolApproval({}), false);
  // The whole template must match: a name that only starts with a plan tool, two quoted names, or the name
  // appearing anywhere but the message does not count.
  assert.equal(isCodexPlanToolApproval(params("tasks_set_extra")), false);
  assert.equal(
    isCodexPlanToolApproval(params("design_delete", { message: 'Allow the milagre MCP server to run tool "design_delete" and "tasks_set"?' })),
    false,
  );
  assert.equal(
    isCodexPlanToolApproval(params("design_delete", { message: 'Allow the milagre MCP server to run tool "design_delete"? run tool "tasks_set"' })),
    false,
  );
  assert.equal(isCodexPlanToolApproval(params("x", { message: 'Run "design_delete" then run tool "tasks_set"?' })), false);
  assert.equal(
    isCodexPlanToolApproval(
      params("design_delete", {
        _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { tool: "tasks_set" }, tool_description: 'run tool "tasks_set"' },
      }),
    ),
    false,
  );
});

test("ACP: only Milagre's own plan tools and routine_list are auto-approved; routine writes follow the mode", () => {
  const call = (server, tool) => ({
    toolCall: { toolCallId: "c1", kind: "other", status: "pending", title: `${server}_${tool}`, _meta: { mcp: { server, tool }, is_mcp_tool_call: true } },
  });
  for (const name of [...PLAN_TOOL_NAMES, "routine_list"]) assert.equal(isAcpPlanToolPermission(call("milagre", name)), true, name);
  for (const name of ROUTINE_WRITES) assert.equal(isAcpPlanToolPermission(call("milagre", name)), false, name);
  assert.equal(isAcpPlanToolPermission(call("milagre", "design_delete")), false);
  assert.equal(isAcpPlanToolPermission(call("other", "tasks_set")), false);
  assert.equal(isAcpPlanToolPermission({ toolCall: { title: "milagre_tasks_set", kind: "other" } }), false);
  assert.equal(isAcpPlanToolPermission({}), false);
});

test("the Milagre tools every provider runs without its own card: reads, plan, own-canvas and self-gated tools", () => {
  const ungated = (name, readOnly = false) => isUngatedMilagreTool({ name, readOnly });
  assert.equal(ungated("linear_issue", true), true);
  const own = ["design_show", "design_apply", "artifact_show", "artifact_resolve_comment", "browser_open", "browser_resolve_comment", "conclude_negotiation"];
  for (const name of [...PLAN_TOOL_NAMES, ...own, "project_add", "worktree_link", "worktree_remove", "chat_set_mode", "chat_respond", "delegate"]) {
    assert.equal(ungated(name), true, name);
    // Codex in Ask or Auto, and Antigravity, get Milagre's answer instead of a card.
    assert.equal(isCodexPlanToolApproval(codexApproval(name)), true, name);
  }
  for (const name of [
    "linear_create_issue",
    "linear_comment",
    "chat_stop",
    "chat_update",
    "worktree_create",
    "design_delete",
    "chat_start",
    "browser_click",
    "browser_fill",
    ...ROUTINE_WRITES,
  ])
    assert.equal(ungated(name), false, name);
  assert.equal(ungated("routine_list", true), true);
  assert.ok(MODE_RANK.ask < MODE_RANK.auto && MODE_RANK.auto < MODE_RANK.full);
});

test("Bot rules keep only the Milagre tools that stay inside the Chat", () => {
  const kept = (name, readOnly = false) => isBotRulesTool({ name, readOnly });
  for (const name of ["routine_list", "chat_read", "linear_issue", "linked_overview", "memory_read"]) assert.equal(kept(name, true), true, name);
  const own = ["design_show", "design_apply", "artifact_show", "artifact_resolve_comment"];
  for (const name of [...PLAN_TOOL_NAMES, ...own, "memory_write", "chat_open", "chat_send"]) assert.equal(kept(name), true, name);
  const outside = [
    "project_add",
    "delegate",
    "conclude_negotiation",
    "worktree_create",
    "worktree_link",
    "worktree_remove",
    "worktree_unlink",
    "link_worktree_create",
  ];
  const chats = ["chat_create", "chat_start", "chat_stop", "chat_set_mode", "chat_respond", "chat_update"];
  const rest = ["linear_create_issue", "linear_update_issue", "linear_comment", "design_delete", "browser_attach", "simulator_attach", "advisor_stop"];
  for (const name of [...ROUTINE_WRITES, ...outside, ...chats, ...rest, "a_tool_added_later"]) assert.equal(kept(name), false, name);
});

test("a Milagre tool request is told apart on every provider", () => {
  assert.equal(milagreToolOf(claudeRequest("mcp__milagre__routine_create", {}, { toolUseID: "u1" })), "routine_create");
  assert.equal(milagreToolOf(claudeRequest("mcp__milagre__chat_start", {}, { toolUseID: "u1", displayName: "Start a Chat" })), "chat_start");
  assert.equal(milagreToolOf(claudeRequest("mcp__slack__send_message", {}, { toolUseID: "u1" })), null);
  assert.equal(milagreToolOf(claudeRequest("Bash", { command: "ls" }, { toolUseID: "u1" })), null);
  assert.equal(milagreToolOf(codexMcpRequest("1", codexApproval("routine_delete"))), "routine_delete");
  assert.equal(
    milagreToolOf(codexMcpRequest("1", { ...codexApproval("x"), serverName: "slack", message: 'Allow the slack MCP server to run tool "x"?' })),
    null,
  );
  // A Milagre request whose tool can't be read is still Milagre's: no Bot rules tool has an empty name.
  assert.equal(milagreToolOf({ tool: "MCP: milagre", title: "Allow?" }), "");
  const acp = (server, tool) =>
    acpPermissionRequest("1:1", { toolCallId: "c1", kind: "other", title: `${server}_${tool}`, _meta: { mcp: { server, tool } } }, []);
  assert.equal(milagreToolOf(acp("milagre", "heartbeat_create")), "heartbeat_create");
  assert.equal(milagreToolOf(acp("github", "merge_pull_request")), null);
});

test("Bot rules weigh as Ask for a caller and above Full for the Chat a message would run in", () => {
  assert.equal(callerMode("bot"), "ask");
  assert.equal(callerMode(undefined), "ask");
  assert.equal(callerMode("full"), "full");
  // A caller in Bot rules raises any Chat above Ask; nothing a caller has covers running in Bot rules.
  assert.equal(raisesMode("auto", "bot"), true);
  assert.equal(raisesMode("ask", "bot"), false);
  for (const caller of ["ask", "auto", "full", "bot"]) assert.equal(raisesMode("bot", caller), true, caller);
  assert.equal(raisesMode("auto", "full"), false);
  assert.equal(raisesMode("full", "auto"), true);
});

test("in bot mode Milagre's own approval cards are the user's, whatever the policy says", () => {
  const events = [];
  const answers = [];
  const permissions = new PendingPermissions((event) => events.push(event), { policy: () => "allow" });
  permissions.setMode("bot");
  const request = { requestId: "mcp-1", kind: "other", tool: "Milagre", title: "Allow this in another Chat?", command: "ls", allowForChat: false };
  permissions.add(request, (decision) => answers.push(decision), { fromMilagre: true });
  assert.deepEqual(answers, []);
  assert.equal(events.length, 1);
  assert.equal(events[0].gate, undefined);
  permissions.resolve("mcp-1", "deny");
  assert.deepEqual(answers, ["deny"]);
  // Full still answers them at once, as before.
  permissions.setMode("full");
  permissions.add({ ...request, requestId: "mcp-2" }, (decision) => answers.push(decision), { fromMilagre: true });
  assert.deepEqual(answers, ["deny", "allow"]);
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

test("bot is a known mode and publishes a card when no policy answers", () => {
  const { permissions, events, answers } = pending();
  assert.equal(PERMISSION_MODES.has("bot"), true);
  permissions.setMode("bot");
  permissions.add({ requestId: "command", kind: "command", tool: "T", title: "Allow?", allowForChat: false }, (decision) => answers.push(decision));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "permission-request");
  assert.deepEqual(answers, []);
});

test("in bot mode a policy allow answers without a card", () => {
  const events = [];
  const answers = [];
  const seen = [];
  const permissions = new PendingPermissions((event) => events.push(event), {
    policy: (request) => {
      seen.push(request.requestId);
      return "allow";
    },
  });
  permissions.setMode("bot");
  permissions.add({ requestId: "r1", kind: "command", tool: "Bash", command: "ls", title: "Run ls", allowForChat: true }, (decision) => answers.push(decision));
  assert.deepEqual(answers, ["allow"]);
  assert.deepEqual(seen, ["r1"]);
  assert.equal(events.length, 0);
  assert.equal(permissions.size, 0);
});

test("in bot mode a policy deny answers without a card", () => {
  const events = [];
  const answers = [];
  const permissions = new PendingPermissions((event) => events.push(event), { policy: () => "deny" });
  permissions.setMode("bot");
  permissions.add({ requestId: "r1", kind: "command", tool: "Bash", command: "ls", title: "Run ls", allowForChat: false }, (decision) =>
    answers.push(decision),
  );
  assert.deepEqual(answers, ["deny"]);
  assert.equal(events.length, 0);
});

test("in bot mode a gate is published with its meta, and can't be allowed for the whole Chat", () => {
  const events = [];
  const answers = [];
  const gate = { kind: "merge", title: "Merge PR #474" };
  const permissions = new PendingPermissions((event) => events.push(event), { policy: () => ({ gate }) });
  permissions.setMode("bot");
  permissions.add({ requestId: "r2", kind: "command", tool: "Bash", command: "gh pr merge 474", title: "x", allowForChat: true }, (decision) =>
    answers.push(decision),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "permission-request");
  assert.deepEqual(events[0].gate, gate);
  assert.equal(events[0].allowForChat, false);
  assert.equal(permissions.size, 1);
  permissions.resolve("r2", "allow-for-chat");
  assert.deepEqual(answers, ["allow"]);
});

test("in bot mode a policy with no answer, or one that throws, leaves the card to the user", () => {
  for (const policy of [
    () => undefined,
    () => {
      throw new Error("broken");
    },
  ]) {
    const events = [];
    const permissions = new PendingPermissions((event) => events.push(event), { policy });
    permissions.setMode("bot");
    permissions.add({ requestId: "r4", kind: "command", tool: "Bash", command: "ls", title: "x", allowForChat: true }, () => {});
    assert.equal(events.length, 1);
    assert.equal(events[0].gate, undefined);
    assert.equal(events[0].allowForChat, true);
  }
});

test("outside bot mode the policy is never consulted", () => {
  const permissions = new PendingPermissions(() => {}, {
    policy: () => {
      throw new Error("consulted");
    },
  });
  for (const mode of ["ask", "auto", "full"]) {
    permissions.setMode(mode);
    assert.doesNotThrow(() =>
      permissions.add({ requestId: `r-${mode}`, kind: "command", tool: "Bash", command: "ls", title: "x", allowForChat: false }, () => {}),
    );
  }
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
  assert.equal(claudeRequest("mcp__milagre__chat_stop", {}, { requestId: "r3" }).title, "Use chat_stop from milagre?");
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

test("Codex: a command that writes to GitHub can't be allowed for the whole Chat", () => {
  for (const command of ["/bin/zsh -lc 'git push origin HEAD'", "gh pr comment 4 --body hi", "gh pr merge 4"])
    assert.equal(codexCommandRequest("srv-1", { command }).allowForChat, false, command);
  assert.equal(codexCommandRequest("srv-1", { command: "git status" }).allowForChat, true);
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
