#!/usr/bin/env node
// Regenerates tests/fixtures/conformance/claude-contract.json from the Node implementation in
// packages/core, so the Rust port is checked against what Milagre ships today. Run from the repo root
// with the repo's node_modules reachable (in a Worktree without its own, set NODE_PATH):
//   NODE_PATH=<checkout>/node_modules node experiments/rust-claude/scripts/generate-conformance.cjs
// Pure functions only: nothing is spawned and nothing outside the fixture file is written.
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const agents = path.join(root, "packages/core/src/agents");
const permissions = require(path.join(agents, "permissions.cjs"));
const questions = require(path.join(agents, "questions.cjs"));

const plain = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));

// The wire can_use_tool request -> the options object the TS SDK passes to canUseTool, per the public
// CanUseTool and SDKControlPermissionRequest types in @anthropic-ai/claude-agent-sdk 0.3.288.
function sdkOptions(requestId, r) {
  return {
    signal: undefined,
    suggestions: r.permission_suggestions,
    blockedPath: r.blocked_path,
    decisionReason: r.decision_reason,
    title: r.title,
    displayName: r.display_name,
    description: r.description,
    defaultToNo: r.default_to_no,
    suppressAlwaysAllowRule: r.suppress_always_allow_rule,
    toolUseID: r.tool_use_id,
    agentID: r.agent_id,
    requestId,
  };
}

const rule = { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test" }], behavior: "allow", destination: "localSettings" };
const req = (tool_name, input, extra = {}) => ({ subtype: "can_use_tool", tool_name, input, tool_use_id: "toolu_1", ...extra });
const permissionCases = [
  ["bash-plain", req("Bash", { command: "npm test" })],
  [
    "bash-sdk-labels",
    req(
      "Bash",
      { command: "rm -rf build" },
      { title: "Run rm?", display_name: "Shell", description: "Removes build", decision_reason: "rule", permission_suggestions: [rule] },
    ),
  ],
  ["bash-no-command", req("Bash", {})],
  ["bash-number-command", req("Bash", { command: 42 })],
  ["bash-suppressed-rule", req("Bash", { command: "ls" }, { permission_suggestions: [rule], suppress_always_allow_rule: true })],
  ["edit", req("Edit", { file_path: "/repo/src/a.ts", old_string: "one\ntwo", new_string: "uno" })],
  ["edit-missing-strings", req("Edit", { file_path: "/repo/b.ts" })],
  [
    "multiedit",
    req("MultiEdit", {
      file_path: "/repo/c.ts",
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "c\nd", new_string: "" },
      ],
    }),
  ],
  ["multiedit-no-edits", req("MultiEdit", { file_path: "/repo/c.ts" })],
  ["write", req("Write", { file_path: "/repo/notes/", content: "hello\nworld" })],
  ["write-no-path", req("Write", { content: "x" })],
  ["notebook", req("NotebookEdit", { notebook_path: "/repo/n.ipynb", new_source: "print(1)" })],
  ["write-huge", req("Write", { file_path: "/repo/big.txt", content: "y".repeat(25_000) })],
  ["write-unicode", req("Write", { file_path: "/repo/ü.txt", content: "çå 🎉\nnext" })],
  ["mcp-tool", req("mcp__milagre__chat_stop", { chatId: "c1", nested: { list: [1, 2.5, true, null], empty: {}, none: [] } })],
  ["mcp-double-underscore", req("mcp__a__b__c", {})],
  ["webfetch-blocked", req("WebFetch", { url: "https://example.com" }, { blocked_path: "/outside" })],
  ["read-reason-wins", req("Read", { file_path: "/outside/x" }, { blocked_path: "/outside", decision_reason: "Outside the workspace" })],
  ["empty-labels", req("Grep", { pattern: "x" }, { title: "", display_name: "", description: "" })],
  ["no-tool-use-id", { subtype: "can_use_tool", tool_name: "Glob", input: { pattern: "*" } }],
  ["huge-detail", req("Agent", { prompt: "z".repeat(21_000) })],
];

const permissionCards = permissionCases.map(([name, request]) => ({
  name,
  request_id: `ctl-${name}`,
  request,
  expected: plain(permissions.claudeRequest(request.tool_name, request.input, sdkOptions(`ctl-${name}`, request))),
}));

const resultCases = [];
for (const decision of ["allow", "allow-for-chat", "deny", "cancelled"])
  for (const suggestions of [[], [rule, { type: "addDirectories", directories: ["/x"], destination: "projectSettings" }]])
    resultCases.push({
      decision,
      input: { command: "ls", extra: [1] },
      suggestions,
      expected: plain(permissions.claudeResult(decision, { command: "ls", extra: [1] }, suggestions)),
    });

const q = (list) => req("AskUserQuestion", { questions: list });
const questionCases = [
  ["single", q([{ question: "Which DB?", header: "DB", options: [{ label: "Postgres", description: "SQL" }, { label: "Mongo" }], multiSelect: false }])],
  ["trim-and-drop", q([{ question: "  Pick  ", header: " H ", options: [{ label: "  " }, { label: " A ", description: "  " }, {}], multiSelect: "yes" }])],
  [
    "multi",
    q([
      { question: "One?", options: [] },
      { question: "Two?", options: [{ label: "x" }], multiSelect: true },
    ]),
  ],
  ["missing-text", q([{ question: "Ok?" }, { header: "no question" }])],
  ["empty", q([])],
  ["not-a-list", req("AskUserQuestion", { questions: "nope" })],
];
const questionCards = questionCases.map(([name, request]) => ({
  name,
  request_id: `ctl-${name}`,
  request,
  expected: plain(questions.claudeQuestionRequest(request.input, sdkOptions(`ctl-${name}`, request))),
}));

const twoQuestions = {
  questions: [
    { question: "First?", options: [] },
    { question: "Second?", options: [] },
  ],
  metadata: { source: "x" },
};
const questionResults = [
  ["answered", "answered", { 0: ["A", "B"], 1: ["typed"] }],
  ["answered-partial", "answered", { 1: ["only"] }],
  ["answered-empty-list", "answered", { 0: [] }],
  ["dismissed", "dismissed", {}],
  ["cancelled", "cancelled", {}],
  ["unshown", "unshown", {}],
].map(([name, outcome, answers]) => ({
  name,
  outcome,
  input: twoQuestions,
  answers,
  expected: plain(questions.claudeQuestionResult(outcome, twoQuestions, answers)),
}));

// PendingQuestions.answer: which outcome and answers reach the settle callback.
const settleCases = [
  ["kept", { 0: [" a ", ""], 1: ["b"] }],
  ["unknown-id", { 7: ["x"] }],
  ["blank-only", { 0: ["  "] }],
  ["empty", {}],
].map(([name, answers]) => {
  const card = questions.claudeQuestionRequest(twoQuestions, { requestId: "r" });
  let settled = null;
  const pending = new questions.PendingQuestions(() => {});
  pending.add(card, (outcome, kept) => (settled = { outcome, answers: kept }));
  pending.answer("r", answers);
  return { name, card, answers, expected: plain(settled) };
});

const out = {
  generatedBy: "experiments/rust-claude/scripts/generate-conformance.cjs",
  messages: {
    DENIED_MESSAGE: permissions.DENIED_MESSAGE,
    CANCELLED_MESSAGE: permissions.CANCELLED_MESSAGE,
    DISMISSED_MESSAGE: questions.DISMISSED_MESSAGE,
    UNSHOWN_MESSAGE: questions.UNSHOWN_MESSAGE,
  },
  permissionCards,
  permissionResults: resultCases,
  questionCards,
  questionResults,
  settleCases,
};
const file = path.join(__dirname, "../tests/fixtures/conformance/claude-contract.json");
fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${path.relative(root, file)}`);
