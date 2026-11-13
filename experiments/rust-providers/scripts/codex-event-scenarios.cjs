// Extra notification sequences for the trace recorder: item shapes and branches the Node test suites don't reach.
// Run only under record-codex-traces.cjs, which records every mapper call these make. Clock values are fixed.
const path = require("node:path");

const agents = path.resolve(__dirname, "../../../packages/core/src/agents");
const { mapCodexNotification } = require(path.join(agents, "events.cjs"));
const { settleSubagents } = require(path.join(agents, "subagents.cjs"));

const T = "thread-1";
const turn = "turn-1";
const state = (extra = {}) => {
  let time = 1_800_000_000_000;
  return { threadId: T, turnId: turn, lastItemId: null, hasText: false, steps: new Set(), now: () => (time += 1500), ...extra };
};
const started = (item, extra = {}) => ["item/started", { threadId: T, turnId: turn, item, ...extra }];
const completed = (item, extra = {}) => ["item/completed", { threadId: T, turnId: turn, item, ...extra }];
const both = (item, done) => [started(item), completed({ ...item, ...done })];

const command = (id, cmd, actions, done) =>
  both(
    { type: "commandExecution", id, command: cmd, cwd: "/repo", status: "inProgress", commandActions: actions, aggregatedOutput: null, exitCode: null },
    done,
  );
const mcp = (id, server, tool, args, done) => both({ type: "mcpToolCall", id, server, tool, arguments: args, status: "inProgress" }, done);
const text = (t) => ({ content: [{ type: "text", text: t }] });

const scenarios = [
  {
    name: "commands and actions",
    calls: [
      ...command("c1", "/bin/zsh -lc 'cat src/a.ts'", [{ type: "read", name: "a.ts", path: "src/a.ts", command: "cat src/a.ts" }], {
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "x",
      }),
      ...command("c2", "/bin/zsh -lc 'rg foo src'", [{ type: "search", query: "foo", path: "src", command: "rg foo src" }], {
        status: "completed",
        exitCode: 1,
        aggregatedOutput: "",
      }),
      ...command("c3", "/bin/zsh -lc 'rg --files'", [{ type: "search", command: "rg --files" }], {
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "a\nb\n",
      }),
      ...command("c4", "/bin/zsh -lc ls", [{ type: "listFiles", path: "src", command: "ls" }], { status: "completed", exitCode: 0, aggregatedOutput: "a\n" }),
      ...command("c5", "/bin/zsh -lc 'cat /tmp/x'", [{ type: "read", path: "/tmp/x", command: "cat /tmp/x" }], {
        status: "failed",
        exitCode: 1,
        aggregatedOutput: "No such file",
      }),
      ...command("c6", "/bin/zsh -lc 'rm -rf /'", [{ type: "unknown", command: "rm -rf /" }], { status: "declined" }),
      ["item/commandExecution/outputDelta", { threadId: T, turnId: turn, itemId: "c7", delta: "ignored, not started" }],
      started({ type: "commandExecution", id: "c7", command: `/bin/zsh -lc '${"echo long ".repeat(20)}'`, status: "inProgress" }),
      ["item/commandExecution/outputDelta", { threadId: T, turnId: turn, itemId: "c7", delta: "line\n" }],
      completed({ type: "commandExecution", id: "c7", command: "/bin/zsh -lc 'echo'", status: "completed", exitCode: 0, aggregatedOutput: "y".repeat(25_000) }),
      completed({ type: "commandExecution", id: "c8", command: "/bin/zsh -lc 'echo late'", status: "completed", exitCode: 0, aggregatedOutput: "late\n" }),
    ],
  },
  {
    name: "file changes",
    calls: [
      ...both(
        { type: "fileChange", id: "f1", status: "inProgress", changes: [{ path: "/repo/new.txt", kind: { type: "add" }, diff: "hello\n" }] },
        { status: "completed" },
      ),
      ...both(
        {
          type: "fileChange",
          id: "f2",
          status: "inProgress",
          changes: [
            { path: "/repo/a.txt", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-a\n+b\n" },
            { path: "/repo/b.txt", kind: { type: "delete" }, diff: "gone\n" },
          ],
        },
        { status: "failed" },
      ),
      ...both({ type: "fileChange", id: "f3", status: "inProgress", changes: [] }, { status: "completed" }),
      ...both(
        { type: "fileChange", id: "f4", status: "inProgress", changes: [{ path: "/repo/old.txt", kind: { type: "delete" }, diff: "x\n" }] },
        { status: "completed" },
      ),
    ],
  },
  {
    name: "mcp, dynamic, web, images",
    calls: [
      ...mcp(
        "m1",
        "milagre",
        "design_show",
        { title: "Daily notes", document: { nodes: [] } },
        { status: "completed", result: text('{"id":"daily","version":3,"title":"Daily notes","format":"design","group":"Home"}\n[image]') },
      ),
      ...mcp("m2", "milagre", "design_apply", { id: "daily" }, { status: "completed", result: text("not json") }),
      ...mcp(
        "m3",
        "milagre",
        "artifact_show",
        {},
        { status: "completed", result: text('{"id":"page","version":1,"title":"Report","inline":true,"height":300}') },
      ),
      ...mcp("m4", "milagre", "artifact_resolve_comment", { id: "c1", note: "Fixed the header" }, { status: "completed", result: text("ok") }),
      ...mcp("m5", "milagre", "browser_resolve_comment", { id: "c2", note: "Done" }, { status: "failed", error: { message: "gone" } }),
      ...mcp(
        "m6",
        "milagre",
        "heartbeat_create",
        { name: "Watch CI", prompt: "check" },
        { status: "completed", result: text('{"routine":{"id":"r1","name":"Watch CI"}}\nNext run in 5 minutes.') },
      ),
      ...mcp("m7", "milagre", "routine_create", {}, { status: "completed", result: text("{}") }),
      ...mcp("m8", "milagre", "routine_delete", { id: "r1" }, { status: "completed", result: text("deleted") }),
      ...mcp("m9", "milagre", "routine_list", null, { status: "completed", result: text("[]") }),
      ...mcp(
        "m10",
        "linear",
        "get_issue",
        { identifier: "ENG-12", api_key: "secret-value", nested: { authorization: "Bearer x", n: 1.5 } },
        { status: "completed", result: text('{"title":"Bug"}') },
      ),
      ...mcp("m11", "github", "search", { q: "x".repeat(5000) }, { status: "failed", error: { message: "rate limited" } }),
      ...mcp(
        "m12",
        "notion",
        "fetch",
        {},
        {
          status: "completed",
          result: {
            content: [
              { type: "image", data: "AAAA", mimeType: "image/png" },
              { type: "text", text: "caption" },
            ],
          },
        },
      ),
      ...both(
        { type: "dynamicToolCall", id: "d1", tool: "lookup", arguments: { key: "k" }, status: "inProgress" },
        {
          status: "completed",
          success: true,
          contentItems: [
            { type: "inputText", text: "found" },
            { type: "inputImage", imageUrl: "data:" },
          ],
        },
      ),
      ...both({ type: "dynamicToolCall", id: "d2", tool: "broken", status: "inProgress" }, { status: "completed", success: false, contentItems: [] }),
      ...both(
        { type: "webSearch", id: "w1", query: "", action: { type: "search", query: "rust tokio", queries: ["rust tokio"] } },
        { results: [{ title: "Tokio", url: "https://tokio.rs" }, { url: "https://docs.rs" }, {}] },
      ),
      ...both({ type: "webSearch", id: "w2", action: { type: "openPage", url: "https://example.com/a" } }, {}),
      ...both({ type: "webSearch", id: "w3", action: { type: "findInPage", url: "https://example.com", pattern: "needle" } }, {}),
      ...both({ type: "webSearch", id: "w4", action: {} }, { results: [] }),
      ...both({ type: "imageView", id: "i1", path: "/repo/shot.png" }, { status: "completed" }),
      ...both({ type: "imageView", id: "i2", path: "" }, { status: "failed" }),
      ...both({ type: "imageGeneration", id: "g1", status: "inProgress" }, { status: "completed", savedPath: "/tmp/g1.png", revisedPrompt: "A cat" }),
      ...both({ type: "imageGeneration", id: "g2", status: "inProgress" }, { status: "failed", failure: { type: "usageLimitExceeded" } }),
      ...both({ type: "imageGeneration", id: "g3", status: "inProgress" }, { status: "completed" }),
      ...both({ type: "somethingNew", id: "n1" }, { status: "completed" }),
    ],
  },
  {
    name: "messages, thinking, compaction, plan, usage",
    calls: [
      ["item/agentMessage/delta", { threadId: T, turnId: turn, itemId: "msg-1", delta: "Hello" }],
      ["item/agentMessage/delta", { threadId: T, turnId: turn, itemId: "msg-1", delta: "" }],
      ["item/agentMessage/delta", { threadId: T, turnId: "turn-0", itemId: "msg-0", delta: "stale" }],
      ["item/agentMessage/delta", { threadId: T, turnId: turn, itemId: "msg-2", delta: "Second" }],
      completed({ type: "agentMessage", id: "async-1", delivery: "async", text: "Async note" }),
      completed({ type: "agentMessage", id: "async-1", delivery: "async", text: "Async note" }),
      started({ type: "agentMessage", id: "async-2", delivery: "async", text: "" }),
      started({ type: "reasoning", id: "rs-1", summary: [], content: [] }),
      started({ type: "reasoning", id: "rs-1", summary: [], content: [] }),
      ["item/reasoning/summaryTextDelta", { threadId: T, turnId: turn, itemId: "rs-1", delta: "**Plan**" }],
      ["item/reasoning/summaryPartAdded", { threadId: T, turnId: turn, itemId: "rs-1", summaryIndex: 0 }],
      ["item/reasoning/summaryPartAdded", { threadId: T, turnId: turn, itemId: "rs-1", summaryIndex: 1 }],
      completed({ type: "reasoning", id: "rs-1", summary: ["**Plan**", "", "Then act", 3], content: [] }),
      completed({ type: "reasoning", id: "rs-2", summary: [], content: [] }),
      started({ type: "contextCompaction", id: "cc-1" }),
      started({ type: "contextCompaction", id: "cc-1" }),
      completed({ type: "contextCompaction", id: "cc-1" }),
      completed({ type: "contextCompaction", id: "cc-1" }),
      completed({ type: "contextCompaction", id: "cc-2" }),
      [
        "turn/plan/updated",
        {
          threadId: T,
          turnId: turn,
          plan: [
            { step: " Read ", status: "completed" },
            { step: "", status: "pending" },
            { step: "Write", status: "inProgress" },
            { step: "Ship", status: "weird" },
          ],
        },
      ],
      ["turn/plan/updated", { threadId: T, turnId: "turn-0", plan: [] }],
      ["turn/plan/updated", { threadId: T, turnId: turn, plan: null }],
      [
        "thread/tokenUsage/updated",
        { threadId: T, turnId: turn, tokenUsage: { last: { totalTokens: 1234 }, total: { totalTokens: 9999 }, modelContextWindow: 272000 } },
      ],
      ["thread/tokenUsage/updated", { threadId: T, turnId: turn, tokenUsage: { last: { totalTokens: 5 }, modelContextWindow: 0 } }],
      ["turn/started", { threadId: T, turn: { id: turn, status: "inProgress" } }],
      ["turn/started", { threadId: T }],
      ["turn/diff/updated", { threadId: T, turnId: turn, diff: "" }],
    ],
  },
  {
    name: "turn endings",
    calls: [
      ["turn/completed", { threadId: T, turn: { id: "turn-0", status: "completed" } }],
      ["turn/completed", { threadId: T, turn: { id: turn, status: "interrupted" } }],
      ["turn/completed", { threadId: T, turn: { id: turn, status: "failed", error: { message: '{"type":"error","error":{"message":"Model overloaded"}}' } } }],
      ["turn/completed", { threadId: T, turn: { id: turn, status: "failed", error: { message: "", codexErrorInfo: "other" } } }],
      ["turn/completed", { threadId: T, turn: { id: turn, status: "failed", error: { message: "401", codexErrorInfo: "unauthorized" } } }],
      ["turn/completed", { threadId: T, turn: { id: turn, status: "completed" } }],
      ["turn/completed", { threadId: T }],
    ],
  },
  {
    name: "login and usage limits",
    extra: { requiresOpenaiAuth: true },
    calls: [
      [
        "turn/completed",
        {
          threadId: T,
          turn: { id: turn, status: "failed", error: { message: "unexpected status 401", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } } },
        },
      ],
      ["turn/completed", { threadId: T, turn: { id: turn, status: "failed", error: { message: "x", codexErrorInfo: "unauthorized" } } }],
      [
        "turn/completed",
        { threadId: T, turn: { id: turn, status: "failed", error: { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" } } },
      ],
      [
        "account/rateLimits/updated",
        {
          rateLimits: {
            primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_800_003_600 },
            secondary: { usedPercent: 100, resetsAt: 1_800_090_000 },
          },
        },
      ],
      [
        "turn/completed",
        { threadId: T, turn: { id: turn, status: "failed", error: { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" } } },
      ],
      ["account/rateLimits/updated", { rateLimits: { primary: { usedPercent: 40, resetsAt: 1_800_003_600 } } }],
      ["turn/completed", { threadId: T, turn: { id: turn, status: "failed", error: { message: "limit", codexErrorInfo: "usageLimitExceeded" } } }],
    ],
  },
  {
    name: "subagents",
    calls: [
      started({
        type: "collabAgentToolCall",
        id: "co-1",
        tool: "spawnAgent",
        senderThreadId: T,
        receiverThreadIds: ["child-1"],
        prompt: "Review the auth flow\nin detail",
        agentsStates: {},
      }),
      completed({
        type: "collabAgentToolCall",
        id: "co-1",
        tool: "spawnAgent",
        receiverThreadIds: ["child-1", T],
        prompt: "Review the auth flow\nin detail",
        agentsStates: { "child-1": { status: "running", message: null } },
      }),
      started({ type: "subAgentActivity", id: "sa-1", kind: "started", agentThreadId: "child-2", agentPath: "researcher" }),
      started({ type: "subAgentActivity", id: "sa-1", kind: "started", agentThreadId: "child-2", agentPath: "researcher" }),
      ["thread/status/changed", { threadId: "child-1", status: { type: "active", activeFlags: ["waitingOnApproval"] } }],
      ["thread/status/changed", { threadId: "child-1", status: { type: "active", activeFlags: [] } }],
      ["turn/started", { threadId: "child-1", turn: { id: "ct-1", status: "inProgress" } }],
      [
        "item/started",
        { threadId: "child-1", turnId: "ct-1", item: { type: "commandExecution", id: "cc-1", command: "/bin/zsh -lc 'npm test'", status: "inProgress" } },
      ],
      [
        "item/completed",
        {
          threadId: "child-1",
          turnId: "ct-1",
          item: { type: "commandExecution", id: "cc-1", command: "/bin/zsh -lc 'npm test'", status: "completed", exitCode: 0, aggregatedOutput: "ok\n" },
        },
      ],
      ["item/started", { threadId: "child-1", turnId: "ct-1", item: { type: "reasoning", id: "cr-1", summary: [] } }],
      ["item/completed", { threadId: "child-1", turnId: "ct-1", item: { type: "reasoning", id: "cr-1", summary: ["Checking tests"] } }],
      ["item/completed", { threadId: "child-1", turnId: "ct-1", item: { type: "agentMessage", id: "cm-1", text: "## Found it. The token expires early." } }],
      [
        "item/started",
        {
          threadId: "child-1",
          turnId: "ct-1",
          item: { type: "mcpToolCall", id: "cd-1", server: "milagre", tool: "design_show", arguments: { title: "Auth" }, status: "inProgress" },
        },
      ],
      [
        "item/completed",
        {
          threadId: "child-1",
          turnId: "ct-1",
          item: {
            type: "mcpToolCall",
            id: "cd-1",
            server: "milagre",
            tool: "design_show",
            arguments: { title: "Auth" },
            status: "completed",
            result: text('{"id":"auth","version":1,"title":"Auth"}'),
          },
        },
      ],
      ["turn/plan/updated", { threadId: "child-1", turnId: "ct-1", plan: [{ step: "Inspect", status: "completed" }] }],
      started({ type: "collabAgentToolCall", id: "co-2", tool: "wait", receiverThreadIds: ["child-1"], agentsStates: {} }),
      ["turn/completed", { threadId: "child-1", turn: { id: "ct-1", status: "completed" } }],
      completed({
        type: "collabAgentToolCall",
        id: "co-2",
        tool: "wait",
        receiverThreadIds: ["child-1"],
        agentsStates: { "child-1": { status: "completed", message: "Token expiry is 5 minutes." } },
      }),
      ["thread/status/changed", { threadId: "child-1", status: { type: "notLoaded" } }],
      started({ type: "subAgentActivity", id: "sa-2", kind: "interacted", agentThreadId: "child-1" }),
      started({ type: "subAgentActivity", id: "sa-3", kind: "interacted", agentThreadId: "unknown-child" }),
      started({ type: "subAgentActivity", id: "sa-4", kind: "completed", agentThreadId: "child-2" }),
      ["thread/status/changed", { threadId: "child-2", status: { type: "systemError" } }],
      ["turn/completed", { threadId: "child-3", turn: { id: "x", status: "failed" } }],
      started({ type: "collabAgentToolCall", id: "co-3", tool: "sendInput", receiverThreadIds: ["child-9"], agentsStates: {} }),
      completed({
        type: "collabAgentToolCall",
        id: "co-4",
        tool: "closeAgent",
        receiverThreadIds: ["child-1"],
        agentsStates: { "child-1": { status: "shutdown" } },
      }),
    ],
    after: (s) => [settleSubagents(s, "cancelled")],
  },
  {
    name: "settle running subagents",
    calls: [
      started({ type: "subAgentActivity", id: "sa-1", kind: "started", agentThreadId: "child-a", agentPath: "a" }),
      started({
        type: "collabAgentToolCall",
        id: "co-1",
        tool: "spawnAgent",
        receiverThreadIds: ["child-b"],
        prompt: "",
        agentsStates: { "child-b": { status: "pendingInit" } },
      }),
    ],
    after: (s) => [settleSubagents(s, "failed"), settleSubagents(s, "failed")],
  },
];

for (const scenario of scenarios) {
  const s = state(scenario.extra);
  let time = 1_800_000_000_000;
  const realNow = Date.now;
  Date.now = () => (time += 250);
  try {
    for (const [method, params] of scenario.calls) mapCodexNotification(method, params, s);
    scenario.after?.(s);
  } finally {
    Date.now = realNow;
  }
}
console.log(`# scenarios ${scenarios.length}`);
