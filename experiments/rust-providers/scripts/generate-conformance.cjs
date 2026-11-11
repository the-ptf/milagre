#!/usr/bin/env node
// Regenerates tests/fixtures/conformance/codex-contract.json from the Node implementation in
// packages/core, so the Rust port is checked against what Milagre ships today. Run from the repo root
// with the repo's node_modules reachable (in a Worktree without its own, set NODE_PATH):
//   NODE_PATH=<checkout>/node_modules node experiments/rust-providers/scripts/generate-conformance.cjs
//   npx oxfmt experiments/rust-providers/tests/fixtures/conformance/codex-contract.json
// Pure functions only: nothing is spawned and nothing outside the fixture file is written.
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const agents = path.join(root, "packages/core/src/agents");
const permissions = require(path.join(agents, "permissions.cjs"));
const questions = require(path.join(agents, "questions.cjs"));
const { codexPolicy } = require(path.join(agents, "codex-provider.cjs"));
const { CodexRpc } = require(path.join(agents, "codex-rpc.cjs"));
const { babysitDenial } = require(path.join(root, "packages/core/src/babysit-guard.cjs"));

const writesRemote = (command) => babysitDenial(command, { level: 1, resolveThreads: false }) !== null;
// JSON drops undefined; null stands for "no request".
const plain = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));

const commandCases = [
  ["srv-1", { itemId: "cmd-1", command: "/bin/zsh -lc 'rm -rf build'", cwd: "/repo", reason: "Clean the build" }],
  [7, { command: "/bin/zsh -lc ls" }],
  ["srv-2", { command: "/bin/bash -lc 'echo '\\''hi'\\'''", cwd: null, reason: null, itemId: null }],
  ["srv-3", { command: "/bin/zsh -lc 'git push origin HEAD'", itemId: "cmd-3" }],
  ["srv-4", { command: "curl https://example.com", networkApprovalContext: { host: "example.com" } }],
  ["srv-5", { command: "/bin/zsh -lc 'a'b'" }],
  ["srv-6", {}],
  ["srv-7", { command: "/usr/bin/sh -lc 'gh pr merge 12'" }],
];

const add = (p, diff) => ({ path: p, kind: { type: "add" }, diff });
const fileCases = [
  ["srv-1", { itemId: "patch-1", reason: "Write notes" }, [add("/repo/notes.txt", "hello\n")]],
  [3, { itemId: "patch-2" }, [add("/repo/a.txt", "one\ntwo"), { path: "/repo/b.txt", kind: { type: "delete" }, diff: "gone\n" }]],
  ["srv-3", {}, [{ path: "/repo/c.txt", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-a\n+b\n" }]],
  ["srv-4", { grantRoot: "/outside" }, [add("/outside/x", "x\n")]],
  ["srv-5", {}, []],
  ["srv-6", {}, [add("/repo/big.txt", "y".repeat(25_000))]],
  ["srv-7", {}, [add("/repo/unified.txt", "diff --git a/x b/x\nbody\n")]],
];

const mcp = (message, extra = {}) => ({
  serverName: "milagre",
  mode: "form",
  message,
  requestedSchema: { type: "object", properties: {} },
  _meta: {
    codex_approval_kind: "mcp_tool_call",
    persist: ["session", "always"],
    tool_description: "Create an editable design",
    tool_params: { id: "daily-notes" },
  },
  ...extra,
});
const mcpCases = [
  ["srv-mcp", mcp('Allow the milagre MCP server to run tool "design_delete"?')],
  ["srv-mcp2", mcp("", { serverName: "github", _meta: { codex_approval_kind: "mcp_tool_call" } })],
  ["srv-form", mcp("Fill this", { requestedSchema: { type: "object", properties: { email: { type: "string" } } } })],
  ["srv-req", mcp("x", { requestedSchema: { type: "object", properties: {}, required: ["a"] } })],
  ["srv-url", mcp("x", { mode: "url" })],
  ["srv-nometa", { serverName: "milagre", mode: "form", message: "x", requestedSchema: { type: "object", properties: {} } }],
];

const toolNames = [
  "tasks_set",
  "task_update",
  "tasks_read",
  "phase_set",
  "routine_list",
  "request_secret",
  "report_milagre_bug",
  "project_add",
  "worktree_link",
  "worktree_remove",
  "chat_set_mode",
  "chat_respond",
  "delegate",
  "desktop_act",
  "desktop_press",
  "desktop_launch",
  "design_show",
  "design_apply",
  "artifact_show",
  "html_render",
  "artifact_resolve_comment",
  "browser_open",
  "browser_resolve_comment",
  "conclude_negotiation",
  "flow_step_output",
  "design_delete",
  "chat_stop",
  "worktree_create",
  "heartbeat_create",
  "routine_create",
  "routine_delete",
  "linear_create_issue",
  "browser_click",
  "chat_list",
];
const ungatedCases = [
  ...toolNames.map((tool) => mcp(`Allow the milagre MCP server to run tool "${tool}"?`)),
  mcp('Allow the github MCP server to run tool "tasks_set"?', { serverName: "github" }),
  mcp('Allow the milagre MCP server to run tool "tasks_set"?', { requestedSchema: { type: "object", properties: { a: {} } } }),
];

const questionCases = [
  [
    "srv-q",
    {
      questions: [
        {
          id: "color",
          header: "Color",
          question: "Which color?",
          isOther: true,
          isSecret: false,
          options: [
            { label: "Red", description: "Warm" },
            { label: "Green", description: "Calm" },
          ],
        },
      ],
    },
  ],
  [9, { questions: [{ id: " pin ", header: null, question: "  PIN?  ", isSecret: true, options: [] }, { id: "", question: "dropped" }, { id: "x" }] }],
  [
    "srv-q3",
    { questions: [{ id: "a", question: "Pick", options: [{ label: "" }, { label: " Yes ", description: "  " }, null, { description: "no label" }] }] },
  ],
  ["srv-q4", { questions: [] }],
  ["srv-q5", {}],
];
const questionResponses = [
  ["answered", { color: ["Red"], other: ["typed", "two"] }],
  ["answered", {}],
  ["dismissed", { color: ["Red"] }],
  ["cancelled", undefined],
];

const policyCases = [];
for (const mode of ["ask", "auto", "full"])
  for (const guarded of [false, true])
    for (const readOnly of [false, true]) policyCases.push([mode, "/repo", ["/repo", "/other", "/other", "/third"], guarded, readOnly]);

// Frame classification, through codex-rpc.cjs's own handleLine.
const frameLines = [
  '{"id":1,"result":{"ok":true}}',
  '{"id":2,"error":{"code":-32601,"message":"unknown method x"}}',
  '{"id":3,"result":null}',
  '{"id":"srv-1","method":"item/commandExecution/requestApproval","params":{"command":"ls"}}',
  '{"id":5,"method":"item/tool/requestUserInput"}',
  '{"method":"turn/started","params":{"threadId":"t"}}',
  '{"method":"initialized"}',
  '{"id":99,"result":{}}',
  "not json",
  '{"id":1,"error":{"code":-1,"message":""}}',
  '{"id":2,"error":null,"result":7}',
];
function classifyWithNode(line) {
  const rpc = new CodexRpc({ command: "unused" });
  const seen = [];
  rpc.on("request", (r) => seen.push({ kind: "request", id: r.id, method: r.method, params: r.params }));
  rpc.on("notification", (n) => seen.push({ kind: "notification", method: n.method, params: n.params }));
  for (const [id, method] of [
    [1, "m1"],
    [2, "m2"],
    [3, "m3"],
  ])
    rpc.pending.set(id, {
      method,
      timer: null,
      resolve: (result) => seen.push({ kind: "response", id, result }),
      reject: (error) => seen.push({ kind: "error", id, message: error.message, code: error.rpcError?.code ?? null }),
    });
  rpc.handleLine(line);
  return seen[0] ?? { kind: "ignored" };
}

const fixture = {
  generatedFrom: "packages/core/src/agents/{permissions,questions,codex-provider,codex-rpc}.cjs",
  commandRequests: commandCases.map(([id, params]) => ({
    id,
    params,
    writesRemote: writesRemote(String(permissions.codexCommandRequest(id, params).command)),
    expected: plain(permissions.codexCommandRequest(id, params)),
  })),
  fileRequests: fileCases.map(([id, params, changes]) => ({ id, params, changes, expected: plain(permissions.codexFileRequest(id, params, changes)) })),
  mcpRequests: mcpCases.map(([id, params]) => ({ id, params, expected: plain(permissions.codexMcpRequest(id, params)) })),
  ungatedApprovals: ungatedCases.map((params) => ({ params, expected: permissions.isCodexPlanToolApproval(params) })),
  decisions: ["allow", "allow-for-chat", "deny", "cancelled"].map((decision) => ({
    decision,
    codex: permissions.codexDecision(decision),
    mcp: permissions.codexMcpResponse(decision),
  })),
  questionRequests: questionCases.map(([id, params]) => ({ id, params, expected: plain(questions.codexQuestionRequest(id, params)) })),
  questionResponses: questionResponses.map(([outcome, answers]) => ({
    outcome,
    answers: answers ?? null,
    expected: questions.codexQuestionResponse(outcome, answers),
  })),
  policies: policyCases.map(([mode, cwd, roots, guarded, readOnly]) => ({
    mode,
    cwd,
    roots,
    guarded,
    readOnly,
    expected: codexPolicy(mode, cwd, roots, { guarded, readOnly }),
  })),
  frames: frameLines.map((line) => ({ line, expected: classifyWithNode(line) })),
};

const out = path.join(__dirname, "../tests/fixtures/conformance/codex-contract.json");
fs.writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${path.relative(root, out)}`);
