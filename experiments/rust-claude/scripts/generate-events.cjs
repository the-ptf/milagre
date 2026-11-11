#!/usr/bin/env node
// Regenerates tests/fixtures/conformance/claude-events.json: Claude stream-json messages run through Milagre's
// mapClaudeMessage (packages/core/src/agents/events.cjs), message by message, with the events each produced.
//   NODE_PATH=<checkout>/node_modules node experiments/rust-claude/scripts/generate-events.cjs
//   npx oxfmt experiments/rust-claude/tests/fixtures/conformance/claude-events.json
// Pure: no process, no file other than the fixture. Full subagent events are included.
// Read-image persistence has its own isolated fixture generator.
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../../..");
const { mapClaudeMessage } = require(path.join(root, "packages/core/src/agents/events.cjs"));

const { settleSubagents } = require(path.join(root, "packages/core/src/agents/subagents.cjs"));

const init = (session_id = "s-1") => ({ type: "system", subtype: "init", session_id, model: "claude-opus-5-5", tools: [] });
const stream = (event, parent = null) => ({ type: "stream_event", parent_tool_use_id: parent, event, session_id: "s-1" });
const text = (t) => stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } });
const textStart = (index = 0) => stream({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
const assistant = (content, extra = {}) => ({
  type: "assistant",
  parent_tool_use_id: null,
  message: { role: "assistant", content, ...extra.message },
  ...extra.top,
});
const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });
const toolResult = (id, content, extra = {}) => ({ type: "tool_result", tool_use_id: id, content, ...extra });
const user = (content, extra = {}) => ({ type: "user", parent_tool_use_id: null, message: { role: "user", content }, ...extra });
const success = (extra = {}) => ({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "ok", ...extra });

const at = (ms, message) => ({ at: ms, message });
const all = (messages) => messages.map((message) => (message.at !== undefined ? message : at(0, message)));

const cases = [
  ["text-reply", [init(), textStart(), text("Hel"), text("lo"), textStart(1), text("Second"), success()]],
  ["same-session-init-twice", [init("s-1"), init("s-1"), init("s-2"), success()]],
  [
    "thinking",
    [
      init(),
      at(1000, stream({ type: "content_block_start", index: 0, content_block: { type: "thinking" } })),
      at(1200, stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me " } })),
      at(1300, stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "check." } })),
      at(5600, stream({ type: "content_block_stop", index: 0 })),
      success(),
    ],
  ],
  [
    "thinking-redacted-long",
    [
      at(0, stream({ type: "content_block_start", index: 2, content_block: { type: "redacted_thinking" } })),
      at(65_400, stream({ type: "content_block_stop", index: 2 })),
    ],
  ],
  [
    "thinking-other-index-ignored",
    [
      at(0, stream({ type: "content_block_start", index: 0, content_block: { type: "thinking" } })),
      at(10, stream({ type: "content_block_stop", index: 1 })),
      at(20, stream({ type: "content_block_stop", index: 0 })),
    ],
  ],
  [
    "bash-step",
    [
      init(),
      assistant([toolUse("t1", "Bash", { command: "npm test" })]),
      user([toolResult("t1", "ok\n3 passed")], { tool_use_result: { stdout: "ok", stderr: "" } }),
      success(),
    ],
  ],
  ["bash-failed", [assistant([toolUse("t1", "Bash", { command: "false" })]), user([toolResult("t1", "Exit code 1", { is_error: true })])]],
  [
    "read-grep-glob",
    [
      assistant([
        toolUse("r", "Read", { file_path: "/repo/src/App.tsx" }),
        toolUse("g", "Grep", { pattern: "TODO", path: "src" }),
        toolUse("gl", "Glob", { pattern: "**/*.ts" }),
      ]),
      user([toolResult("r", [{ type: "text", text: "1\tconst a = 1;" }])], {
        tool_use_result: { type: "text", file: { filePath: "/repo/src/App.tsx", numLines: 12 } },
      }),
      user([toolResult("g", "src/a.ts:1:TODO")], { tool_use_result: { numMatches: 1, mode: "content" } }),
      user([toolResult("gl", "a.ts\nb.ts")]),
    ],
  ],
  [
    "edit-write",
    [
      assistant([
        toolUse("e", "Edit", { file_path: "/repo/a.ts", old_string: "a", new_string: "b" }),
        toolUse("w", "Write", { file_path: "/repo/new.ts", content: "x\ny" }),
      ]),
      user([toolResult("e", "edited")], {
        tool_use_result: { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }] },
      }),
      user([toolResult("w", "written")]),
    ],
  ],
  [
    "batched-results-skip-structured",
    [
      assistant([toolUse("a", "Read", { file_path: "a.md" }), toolUse("b", "Read", { file_path: "b.md" })]),
      user([toolResult("a", "x"), toolResult("b", "y")], { tool_use_result: { file: { numLines: 5 } } }),
    ],
  ],
  [
    "web-agent-todo-other",
    [
      assistant([
        toolUse("ws", "WebSearch", { query: "rust tokio" }),
        toolUse("wf", "WebFetch", { url: "https://example.com" }),
        toolUse("ag", "Agent", { description: "Explore code", prompt: "look", subagent_type: "Explore" }),
        toolUse("td", "TodoWrite", {
          todos: [{ content: "Plan", status: "completed", activeForm: "Planning" }, { content: "Build", status: "in_progress" }, { content: "  " }],
        }),
        toolUse("nb", "NotebookEdit", { notebook_path: "/repo/n.ipynb", new_source: "print(1)" }),
        toolUse("x", "SomethingNew", { a: 1 }),
      ]),
      user([toolResult("ag", "done")], { tool_use_result: { status: "completed", content: [{ type: "text", text: "Found it" }] } }),
      user([toolResult("td", "ok")]),
      user([toolResult("nb", "ok")]),
      user([toolResult("x", [{ type: "text", text: "r1" }, { type: "image", source: {} }, { foo: 1 }])]),
      user([toolResult("ws", "results")]),
      user([toolResult("wf", "page")]),
    ],
  ],
  [
    "agent-async",
    [assistant([toolUse("ag", "Task", { prompt: "go" })]), user([toolResult("ag", "launched")], { tool_use_result: { status: "async_launched" } })],
  ],
  [
    "mcp-tools",
    [
      assistant([
        toolUse("m1", "mcp__milagre__chat_stop", { chatId: "c1", api_key: "sk-1", nested: { token: "t", ok: true } }),
        toolUse("m2", "mcp__slack__send_message", { channel: "#ops", text: "x".repeat(5000) }),
        toolUse("m3", "mcp__milagre__design_show", { title: "Home", document: {} }),
        toolUse("m4", "mcp__milagre__artifact_resolve_comment", { id: "c", note: "Fixed spacing" }),
        toolUse("m5", "mcp__milagre__heartbeat_create", { name: "Watch PR" }),
        toolUse("m6", "mcp__milagre__routine_delete", { id: "r" }),
        toolUse("m7", "mcp__milagre__routine_list", {}),
        toolUse("m8", "mcp__milagre__tasks_read", {}),
      ]),
      user([toolResult("m3", '{"id":"home","version":2,"title":"Home v2","format":"design","group":"Onboarding","inline":true,"height":300}\n[image]')]),
      user([toolResult("m5", '{"routine":{"id":"h1","name":"Watch PR"}}\nRuns every 15m')]),
      user([toolResult("m4", "ok")]),
      user([toolResult("m1", "stopped")]),
      user([toolResult("m2", "sent", { is_error: true })]),
    ],
  ],
  [
    "tasks-create-update-list",
    [
      assistant([toolUse("c1", "TaskCreate", { subject: "Write tests", activeForm: "Writing tests" })]),
      user([toolResult("c1", "Task #7 created successfully")]),
      assistant([toolUse("c2", "TaskCreate", { subject: "Ship" })]),
      user([toolResult("c2", "created")], { tool_use_result: { task: { id: 9 } } }),
      assistant([toolUse("u1", "TaskUpdate", { taskId: "7", status: "in_progress" })]),
      assistant([toolUse("u2", "TaskUpdate", { taskId: 9, subject: "Ship it", status: "deleted" })]),
      assistant([toolUse("l1", "TaskList", {})]),
      user([toolResult("l1", "list")], {
        tool_use_result: {
          tasks: [
            { id: "7", subject: "Write tests", status: "completed" },
            { id: "8", subject: "New one" },
          ],
        },
      }),
    ],
  ],
  ["ask-user-question-no-step", [assistant([toolUse("q", "AskUserQuestion", { questions: [] })]), user([toolResult("q", "answered")])]],
  ["result-without-call", [user([toolResult("nope", "x")])]],
  [
    "design-drafts",
    [
      at(0, stream({ type: "message_start" })),
      at(0, stream({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "d1", name: "mcp__milagre__design_show", input: {} } })),
      at(50, stream({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"ti' } })),
      at(130, stream({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'tle":"é' } })),
      at(140, stream({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"}' } })),
      at(150, stream({ type: "content_block_stop", index: 1 })),
      at(160, stream({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "other", name: "Bash", input: {} } })),
    ],
  ],
  [
    "subagent-artifacts",
    [
      stream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "sd", name: "mcp__milagre__design_apply" } }, "agent-1"),
      stream({ type: "content_block_stop", index: 0 }, "agent-1"),
      {
        type: "assistant",
        parent_tool_use_id: "agent-1",
        message: { content: [toolUse("sa", "mcp__milagre__design_apply", { title: "Card" }), toolUse("sb", "Bash", { command: "ls" })] },
      },
      {
        type: "user",
        parent_tool_use_id: "agent-1",
        message: { content: [toolResult("sa", '{"id":"card","version":3,"title":"Card"}'), toolResult("sb", "x")] },
      },
      {
        type: "stream_event",
        parent_tool_use_id: "agent-1",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "subagent text" } },
      },
    ],
  ],
  [
    "usage-and-window",
    [
      assistant([{ type: "text", text: "hi" }], {
        message: { model: "claude-opus-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5, output_tokens: 20 } },
      }),
      assistant([], { message: { model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } } }),
      success({ modelUsage: { "claude-opus-5-5": { contextWindow: 200000 }, haiku: { contextWindow: 100000 } } }),
      assistant([], { message: { model: "claude-opus-5-5", usage: { input_tokens: 5 } } }),
    ],
  ],
  [
    "compaction",
    [
      { type: "system", subtype: "status", status: "compacting", parent_tool_use_id: null },
      { type: "system", subtype: "status", status: "compacting", parent_tool_use_id: null },
      {
        type: "system",
        subtype: "compact_boundary",
        parent_tool_use_id: null,
        compact_metadata: { trigger: "manual", pre_tokens: 150000, post_tokens: 20000 },
      },
      { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto" } },
    ],
  ],
  [
    "local-command",
    [
      init(),
      textStart(),
      text("Before"),
      assistant([{ type: "text", text: "Total cost: $0.10\nDuration: 2s" }], {
        top: { local_command_source: "<local-command-stdout>Total cost: $0.10</local-command-stdout>" },
        message: { model: "<synthetic>" },
      }),
      success({ result: "" }),
    ],
  ],
  [
    "local-command-failed",
    [
      assistant([], {
        top: {
          local_command_source:
            "<local-command-stdout>partial</local-command-stdout><local-command-stderr>\u001b[31mError: no context\u001b[0m &lt;x&gt;</local-command-stderr>",
        },
      }),
      success({ result: "" }),
    ],
  ],
  [
    "local-command-outcome-failed",
    [assistant([{ type: "text", text: "Nothing to compact" }], { top: { local_command_source: "", local_command_outcome: { kind: "failed" } } }), success()],
  ],
  [
    "login-failure",
    [
      init(),
      assistant([{ type: "text", text: "Not logged in · Please run /login" }], { top: { error: "authentication_failed" } }),
      { type: "result", subtype: "success", is_error: true, result: "Not logged in" },
    ],
  ],
  [
    "usage-limit",
    [
      { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1700000000 } },
      assistant([{ type: "text", text: "You've hit your session limit" }], { top: { error: "rate_limit" } }),
      { type: "result", subtype: "success", is_error: true, result: "You've hit your session limit · resets 12:10pm" },
    ],
  ],
  ["usage-limit-no-info", [assistant([], { top: { error: "rate_limit" } }), { type: "result", subtype: "error_during_execution", is_error: true }]],
  ["error-result", [{ type: "result", subtype: "error_during_execution", is_error: true, errors: ["Request was aborted.", null, "second"] }]],
  [
    "error-result-text",
    [
      { type: "result", subtype: "error_max_turns", is_error: true, result: "Max turns" },
      { type: "result", subtype: "error_max_turns", is_error: true },
    ],
  ],
  [
    "task-notification-result",
    [
      { type: "result", subtype: "success", is_error: false, num_turns: 0, result: "" },
      { type: "result", subtype: "success", is_error: false, num_turns: 0, result: "", user_message_uuids: ["u"] },
    ],
  ],
  [
    "prompt-suggestion",
    [
      init(),
      { type: "prompt_suggestion", suggestion: "Run the tests", session_id: "s-1" },
      { type: "prompt_suggestion", suggestion: "  ", session_id: "s-1" },
      { type: "prompt_suggestion", suggestion: "Other session", session_id: "s-2" },
    ],
    { suggestionTurnId: "turn-0" },
  ],
  [
    "prompt-suggestion-after-init-cleared",
    [{ type: "prompt_suggestion", suggestion: "x", session_id: "s-1" }],
    { sessionId: "s-1", suggestionTurnId: "turn-0" },
  ],
  ["unknown-messages", [{ type: "future_kind", data: 1 }, { type: "system", subtype: "hook_started" }, { type: "keep_alive" }]],
];

cases.push(...require("./subagent-cases.cjs").map(([name, messages]) => [name, messages.map((message, index) => at(1000 + index * 100, message))]));
const originalNow = Date.now;
const output = cases.map(([name, messages, initial = {}]) => {
  const steps = all(messages);
  let clock = 0;
  const state = { turnId: "turn-1", hasText: false, now: () => clock, ...initial };
  return {
    name,
    initial,
    steps: steps.map(({ at: time, message }, index) => {
      clock = time;
      Date.now = () => clock;
      const events = message.settle ? settleSubagents(state, message.settle) : mapClaudeMessage(message, state);
      // The tail case checks the final 100 rows and cumulative totals; omit its growing warmup snapshots.
      if (name === "child-transcript-byte-tail" && index > 0 && index < 20) return { at: time, message };
      if (name === "child-transcript-tail" && index > 0 && index < 101) return { at: time, message };
      return { at: time, message, events: JSON.parse(JSON.stringify(events)) };
    }),
  };
});

Date.now = originalNow;
const file = path.join(__dirname, "../tests/fixtures/conformance/claude-events.json");
fs.writeFileSync(file, `${JSON.stringify({ generatedBy: "experiments/rust-claude/scripts/generate-events.cjs", cases: output }, null, 2)}\n`);
console.log(`wrote ${path.relative(root, file)} (${output.length} cases)`);
