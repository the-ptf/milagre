const test = require("node:test");
const assert = require("node:assert/strict");
const { mapClaudeMessage, mapCodexNotification } = require("./events.cjs");
const child = (events) => events.find((e) => e.type === "subagent-update")?.agent;
const launch = {
  type: "assistant",
  parent_tool_use_id: null,
  message: { content: [{ type: "tool_use", id: "spawn", name: "Agent", input: { description: "Review auth", prompt: "Check authentication" } }] },
};
test("Claude tracks background completion after the launch tool returns and isolates child output", () => {
  const state = {};
  assert.equal(child(mapClaudeMessage(launch, state)).status, "running");
  mapClaudeMessage(
    { type: "system", subtype: "task_started", task_id: "task", tool_use_id: "spawn", task_type: "local_agent", description: "Review auth" },
    state,
  );
  const background = mapClaudeMessage(
    {
      type: "user",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: "spawn", content: "launched" }] },
      tool_use_result: { status: "async_launched" },
    },
    state,
  );
  assert.notEqual(child(background)?.status, "completed");
  const nested = mapClaudeMessage(
    { type: "assistant", parent_tool_use_id: "spawn", message: { id: "m1", content: [{ type: "text", text: "Found an auth issue" }] } },
    state,
  );
  assert.equal(child(nested).transcript[0].text, "Found an auth issue");
  assert.equal(
    nested.some((e) => e.type === "text-delta"),
    false,
  );
  const done = child(mapClaudeMessage({ type: "system", subtype: "task_notification", task_id: "task", status: "failed", summary: "Review crashed" }, state));
  assert.equal(done.id, "spawn");
  assert.equal(done.status, "failed");
  assert.equal(done.transcript[0].text, "Found an auth issue");
});
test("Claude excludes shell tasks and handles foreground results", () => {
  const state = {};
  assert.equal(
    child(mapClaudeMessage({ type: "system", subtype: "task_started", task_id: "bash", task_type: "local_bash", description: "sleep" }, state)),
    undefined,
  );
  mapClaudeMessage(launch, state);
  assert.equal(
    child(
      mapClaudeMessage(
        { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "spawn", content: "All good" }] } },
        state,
      ),
    ).status,
    "completed",
  );
});
test("Codex tracks each receiver, explicit waits, and never leaks unrelated threads", () => {
  const state = { threadId: "root", turnId: "turn" };
  const item = {
    id: "spawn",
    type: "collabAgentToolCall",
    tool: "spawnAgent",
    status: "completed",
    senderThreadId: "root",
    receiverThreadIds: ["child"],
    prompt: "Review auth",
    agentsStates: { child: { status: "running", message: null } },
  };
  assert.equal(child(mapCodexNotification("item/completed", { threadId: "root", turnId: "turn", item }, state)).status, "running");
  const waiting = mapCodexNotification("item/started", { threadId: "root", turnId: "turn", item: { ...item, id: "wait", tool: "wait" } }, state);
  assert.ok(waiting.some((e) => e.type === "subagents-waiting" && e.waiting));
  assert.deepEqual(mapCodexNotification("item/agentMessage/delta", { threadId: "stranger", delta: "secret" }, state), []);
  const output = mapCodexNotification("item/completed", { threadId: "child", item: { id: "reply", type: "agentMessage", text: "Found issue" } }, state);
  assert.equal(child(output).transcript[0].text, "Found issue");
  assert.equal(
    output.some((e) => e.type === "turn-completed"),
    false,
  );
  const done = mapCodexNotification(
    "item/completed",
    { threadId: "root", turnId: "turn", item: { ...item, id: "wait", tool: "wait", agentsStates: { child: { status: "completed", message: "Found issue" } } } },
    state,
  );
  assert.equal(child(done).status, "completed");
  assert.ok(done.some((e) => e.type === "subagents-waiting" && !e.waiting));
});
test("Codex native activity records expose children even without a collab tool call", () => {
  const state = { threadId: "root" };
  const events = mapCodexNotification(
    "item/completed",
    { threadId: "root", item: { type: "subAgentActivity", id: "activity", kind: "started", agentThreadId: "native-child", agentPath: "/root/review" } },
    state,
  );
  assert.equal(child(events).id, "native-child");
  assert.equal(child(events).status, "running");
  assert.equal(child(mapCodexNotification("thread/status/changed", { threadId: "native-child", status: { type: "systemError" } }, state)).status, "failed");
});
test("Claude's set of live background tasks keeps commands and MCP tasks, not agents or ambient watchers, and only on change", () => {
  const state = {};
  const changed = (tasks) => ({ type: "system", subtype: "background_tasks_changed", tasks });
  const tasksOf = (events) => events.find((event) => event.type === "background-tasks")?.tasks;
  const first = tasksOf(
    mapClaudeMessage(
      changed([
        { task_id: "b1", task_type: "local_bash", description: "sleep 75 && echo done" },
        { task_id: "a1", task_type: "local_agent", description: "Review auth" },
        { task_id: "w1", task_type: "monitor", description: "Watch logs", ambient: true },
        { task_id: "m1", task_type: "mcp_task", description: "" },
      ]),
      state,
    ),
  );
  assert.deepEqual(
    first.map(({ id, kind, title }) => ({ id, kind, title })),
    [
      { id: "b1", kind: "local_bash", title: "sleep 75 && echo done" },
      { id: "m1", kind: "mcp_task", title: "Background task" },
    ],
  );
  // The same set again is no change; a task keeps the time it was first seen.
  assert.equal(
    tasksOf(
      mapClaudeMessage(
        changed([
          { task_id: "m1", task_type: "mcp_task" },
          { task_id: "b1", task_type: "local_bash", description: "sleep 75 && echo done" },
        ]),
        state,
      ),
    ),
    undefined,
  );
  const later = tasksOf(mapClaudeMessage(changed([{ task_id: "b1", task_type: "local_bash", description: "sleep 75 && echo done" }]), state));
  assert.deepEqual(later, [first[0]]);
  // A session that ends takes its tasks with it.
  const { settleSubagents } = require("./subagents.cjs");
  assert.deepEqual(settleSubagents(state, "cancelled"), [{ type: "background-tasks", tasks: [] }]);
  assert.deepEqual(settleSubagents(state, "cancelled"), []);
});
test("an agent of the chat's own moved to the background is a background subagent", () => {
  const state = {};
  mapClaudeMessage(launch, state);
  mapClaudeMessage({ type: "system", subtype: "task_started", task_id: "task", tool_use_id: "spawn", task_type: "local_agent", is_backgrounded: false }, state);
  const moved = child(mapClaudeMessage({ type: "system", subtype: "task_updated", task_id: "task", patch: { is_backgrounded: true } }, state));
  assert.equal(moved.background, true);
});
test("canceling the parent settles children without claiming successful completion", () => {
  const { settleSubagents } = require("./subagents.cjs");
  const state = {};
  mapClaudeMessage(launch, state);
  assert.equal(child(settleSubagents(state, "cancelled")).status, "cancelled");
  assert.deepEqual(settleSubagents(state, "cancelled"), []);
});
test("a resumed Codex parent can rediscover a child through wait results", () => {
  const agent = child(
    mapCodexNotification(
      "item/completed",
      {
        threadId: "root",
        item: {
          type: "collabAgentToolCall",
          id: "wait",
          tool: "wait",
          receiverThreadIds: ["existing"],
          agentsStates: { existing: { status: "completed", message: "Saved result" } },
        },
      },
      { threadId: "root" },
    ),
  );
  assert.equal(agent.id, "existing");
  assert.equal(agent.transcript[0].text, "Saved result");
});
test("Claude waits until all foreground children have returned", () => {
  const state = {};
  mapClaudeMessage(launch, state);
  mapClaudeMessage({ ...launch, message: { content: [{ ...launch.message.content[0], id: "second" }] } }, state);
  const first = mapClaudeMessage(
    { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "spawn", content: "Done" }] } },
    state,
  );
  assert.equal(first.find((e) => e.type === "subagents-waiting").waiting, true);
});

test("Codex peer messages keep the spawning parent and never make the main thread a child", () => {
  const state = { threadId: "root" };
  const call = (threadId, item) =>
    mapCodexNotification("item/completed", { threadId, item: { type: "collabAgentToolCall", status: "completed", ...item } }, state);
  call("root", { id: "spawn-a", tool: "spawnAgent", receiverThreadIds: ["a"], prompt: "Review auth" });
  call("a", { id: "spawn-b", tool: "spawnAgent", receiverThreadIds: ["b"], prompt: "Check tests" });
  call("root", { id: "spawn-c", tool: "spawnAgent", receiverThreadIds: ["c"], prompt: "Check types" });
  call("c", { id: "peer", tool: "sendInput", receiverThreadIds: ["b"], prompt: "The auth tests need an update." });
  assert.equal(state.subagents.get("b").parentId, "a");
  call("b", { id: "to-main", tool: "sendInput", receiverThreadIds: ["root"], prompt: "The fix is ready." });
  assert.equal(state.subagents.has("root"), false);
});

test("Codex native peer activity keeps the spawning parent without turning the main thread into a child", () => {
  const state = { threadId: "root" };
  const activity = (threadId, id, kind, target, path) =>
    mapCodexNotification("item/completed", { threadId, item: { type: "subAgentActivity", id, kind, agentThreadId: target, agentPath: path } }, state);
  activity("root", "spawn-a", "started", "a", "/root/a");
  activity("a", "spawn-b", "started", "b", "/root/a/b");
  activity("root", "spawn-c", "started", "c", "/root/c");
  activity("c", "peer", "interacted", "b", "/root/a/b");
  assert.equal(state.subagents.get("b").parentId, "a");
  activity("b", "to-main", "interacted", "root", "/root");
  assert.equal(state.subagents.has("root"), false);
});

test("Codex native history replay preserves terminal lifecycle", (t) => {
  let time = 100;
  t.mock.method(Date, "now", () => ++time);
  const state = { threadId: "root" };
  const items = [
    { type: "subAgentActivity", id: "spawn", kind: "started", agentThreadId: "a", agentPath: "/root/a" },
    { type: "subAgentActivity", id: "message", kind: "interacted", agentThreadId: "a", agentPath: "/root/a" },
    { type: "subAgentActivity", id: "done", kind: "completed", agentThreadId: "a", agentPath: "/root/a" },
  ];
  for (const item of items) mapCodexNotification("item/completed", { threadId: "root", item }, state);
  const original = structuredClone(state.subagents.get("a"));
  for (const item of items) {
    assert.deepEqual(mapCodexNotification("item/started", { threadId: "root", item }, state), []);
    assert.deepEqual(mapCodexNotification("item/completed", { threadId: "root", item }, state), []);
  }
  assert.deepEqual(state.subagents.get("a"), original);
});

test("Codex native interactions do not invent unknown agents or restart completed receivers", () => {
  const state = { threadId: "root" };
  const activity = (id, kind, target) =>
    mapCodexNotification(
      "item/completed",
      { threadId: "root", item: { type: "subAgentActivity", id, kind, agentThreadId: target, agentPath: `/root/${target}` } },
      state,
    );
  activity("unknown", "interacted", "stranger");
  assert.equal(state.subagents?.has("stranger") ?? false, false);
  activity("spawn", "started", "a");
  activity("done", "completed", "a");
  activity("message", "interacted", "a");
  assert.equal(state.subagents.get("a").status, "completed");
});

test("Codex repeated waits keep one reply until the reported result changes", (t) => {
  let time = 100;
  t.mock.method(Date, "now", () => ++time);
  const state = { threadId: "root" };
  const wait = (id, status, message) =>
    mapCodexNotification(
      "item/completed",
      {
        threadId: "root",
        item: {
          type: "collabAgentToolCall",
          id,
          tool: "wait",
          status: "completed",
          senderThreadId: "root",
          receiverThreadIds: ["a"],
          agentsStates: { a: { status, message } },
        },
      },
      state,
    );
  wait("wait-1", "completed", "Auth is valid");
  const original = structuredClone(state.subagents.get("a"));
  wait("wait-2", "completed", "Auth is valid");
  assert.deepEqual(state.subagents.get("a"), original);
  wait("wait-3", "completed", "Found another issue");
  assert.deepEqual(
    state.subagents
      .get("a")
      .transcript.filter((entry) => entry.id === "result")
      .map((entry) => entry.text),
    ["Found another issue"],
  );
});

test("Claude SendMessage never creates a subagent", () => {
  const state = {};
  const send = (id, input) =>
    mapClaudeMessage(
      { type: "assistant", parent_tool_use_id: null, message: { id: `assistant-${id}`, content: [{ type: "tool_use", id, name: "SendMessage", input }] } },
      state,
    );
  mapClaudeMessage(
    {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: "tool_use",
            id: "a",
            name: "Agent",
            input: { description: "Review reviewer", prompt: "Review the code", name: "reviewer", run_in_background: true },
          },
        ],
      },
    },
    state,
  );
  send("named", { to: "reviewer", message: "Check the edge case" });
  send("unknown", { to: "stranger", message: "Not part of this chat" });
  mapClaudeMessage(
    { type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "unknown", content: "Message delivered" }] } },
    state,
  );
  assert.deepEqual([...state.subagents.keys()], ["a"]);
});

test("unloading a Codex child preserves a known terminal outcome and its timestamps", (t) => {
  let time = 100;
  t.mock.method(Date, "now", () => ++time);
  for (const [turnStatus, expected] of [
    ["completed", "completed"],
    ["failed", "failed"],
    ["interrupted", "cancelled"],
  ]) {
    const state = { threadId: "root" };
    mapCodexNotification(
      "item/completed",
      { threadId: "root", item: { type: "subAgentActivity", id: "spawn", kind: "started", agentThreadId: "child", agentPath: "/root/review" } },
      state,
    );
    mapCodexNotification("turn/completed", { threadId: "child", turn: { id: "review", status: turnStatus, items: [] } }, state);
    const terminal = state.subagents.get("child");
    assert.equal(terminal.status, expected);
    const events = mapCodexNotification("thread/status/changed", { threadId: "child", status: { type: "notLoaded" } }, state);
    assert.equal(state.subagents.get("child"), terminal);
    assert.deepEqual(events, []);
    mapCodexNotification("thread/status/changed", { threadId: "child", status: { type: "active", activeFlags: [] } }, state);
    assert.equal(state.subagents.get("child").status, "running");
  }
});

test("unloading a Codex child without a known outcome keeps its status unknown", () => {
  const state = { threadId: "root" };
  mapCodexNotification(
    "item/completed",
    { threadId: "root", item: { type: "subAgentActivity", id: "spawn", kind: "started", agentThreadId: "child", agentPath: "/root/review" } },
    state,
  );
  assert.equal(state.subagents.get("child").status, "running");
  mapCodexNotification("thread/status/changed", { threadId: "child", status: { type: "notLoaded" } }, state);
  assert.equal(state.subagents.get("child").status, "unknown");
  mapCodexNotification("thread/status/changed", { threadId: "child", status: { type: "notLoaded" } }, state);
  assert.equal(state.subagents.get("child").status, "unknown");
  assert.deepEqual(mapCodexNotification("thread/status/changed", { threadId: "stranger", status: { type: "notLoaded" } }, state), []);
  assert.equal(state.subagents.has("stranger"), false);
});

test("Codex publishes current subagent activity when work starts", () => {
  const state = { threadId: "root", subagents: new Map([["child", { id: "child", title: "Review", status: "running", transcript: [] }]]) };
  const start = (item) => child(mapCodexNotification("item/started", { threadId: "child", item }, state));
  const testing = start({ id: "test", type: "commandExecution", command: "npm test" });
  assert.equal(testing.latestActivity, "Ran `npm test`");
  assert.equal(testing.transcript.length, 0);
  assert.equal(
    start({ id: "edit", type: "fileChange", changes: [{ path: "auth.ts", kind: { type: "update" }, diff: "" }] }).latestActivity,
    "Edited `auth.ts`",
  );
  assert.equal(start({ id: "reason", type: "reasoning" }).latestActivity, "Thinking");
  assert.equal(start({ id: "reply", type: "agentMessage" }).latestActivity, "Responding");
});
test("Claude marks an Agent the chat runs in the background, whose result wakes the chat; nested and foreground ones are not", () => {
  const state = {};
  const spawn = (id, parent, input) => ({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { content: [{ type: "tool_use", id, name: "Agent", input }] },
  });
  assert.equal(child(mapClaudeMessage(spawn("bg", null, { description: "Review", prompt: "Check", run_in_background: true }), state)).background, true);
  assert.equal(child(mapClaudeMessage(spawn("fg", null, { description: "Review", prompt: "Check" }), state)).background, undefined);
  assert.equal(child(mapClaudeMessage(spawn("nested", "bg", { description: "Sub", prompt: "Check", run_in_background: true }), state)).background, undefined);
});
test("a Codex subagent's design call is an artifact step of the reply, named for the subagent", () => {
  const state = { threadId: "root" };
  mapCodexNotification(
    "item/completed",
    { threadId: "root", item: { type: "subAgentActivity", id: "spawn", kind: "started", agentThreadId: "child", agentPath: "/root/designer" } },
    state,
  );
  const call = { type: "mcpToolCall", id: "d1", server: "milagre", tool: "design_show", status: "inProgress", arguments: { title: "Card" } };
  const started = mapCodexNotification("item/started", { threadId: "child", item: call }, state);
  assert.deepEqual(
    started.find((event) => event.type === "step-started"),
    { type: "step-started", step: { id: "d1", kind: "artifact", title: "Showed `Card`", tool: "design_show", agent: "child" } },
  );
  const text = JSON.stringify({ id: "card", version: 1, title: "Card", format: "design" });
  const completed = mapCodexNotification(
    "item/completed",
    { threadId: "child", item: { ...call, status: "completed", result: { content: [{ type: "text", text }] } } },
    state,
  );
  assert.deepEqual(completed.find((event) => event.type === "step-completed")?.artifact, { id: "card", version: 1, title: "Card", format: "design" });
  // Its other tools stay in its own transcript.
  const read = { type: "mcpToolCall", id: "r1", server: "milagre", tool: "design_read", status: "inProgress", arguments: {} };
  assert.equal(
    mapCodexNotification("item/started", { threadId: "child", item: read }, state).some((event) => event.type === "step-started"),
    false,
  );
});
test("Claude keeps a subagent's own to-do list on it, apart from the chat's, and counts its steps and tool calls", () => {
  const state = {};
  mapClaudeMessage(launch, state);
  const said = (id, text) => ({ type: "assistant", parent_tool_use_id: "spawn", uuid: id, message: { id, content: [{ type: "text", text }] } });
  const tool = (id, name, input) => ({
    type: "assistant",
    parent_tool_use_id: "spawn",
    uuid: id,
    message: { id, content: [{ type: "tool_use", id, name, input }] },
  });
  const todos = [
    { content: "Read the login code", status: "completed", activeForm: "Reading the login code" },
    { content: "Check the token refresh", status: "in_progress", activeForm: "Checking the token refresh" },
    { content: "Write up findings", status: "pending" },
  ];
  const listed = mapClaudeMessage(tool("t1", "TodoWrite", { todos }), state);
  assert.deepEqual(
    listed.findLast((e) => e.type === "subagent-update").agent.tasks.map((task) => [task.content, task.status]),
    [
      ["Read the login code", "completed"],
      ["Check the token refresh", "in_progress"],
      ["Write up findings", "pending"],
    ],
  );
  // The chat's own list is untouched.
  assert.equal(
    listed.some((e) => e.type === "tasks-updated"),
    false,
  );
  mapClaudeMessage(said("m1", "I'll start with the token refresh. It runs on every request."), state);
  mapClaudeMessage(tool("t2", "Read", { file_path: "/repo/src/auth.ts" }), state);
  mapClaudeMessage(tool("t3", "Read", { file_path: "/repo/docs/flow.png" }), state);
  const last = mapClaudeMessage(tool("t4", "Bash", { command: "npm test" }), state);
  const agent = last.findLast((e) => e.type === "subagent-update").agent;
  // The to-do list call is the list, not a step of the transcript.
  assert.deepEqual(agent.progress, { steps: 1, said: "I'll start with the token refresh.", tools: { reads: 1, images: 1, commands: 1 } });
  assert.equal(
    agent.transcript.some((entry) => /to-do/.test(entry.text)),
    false,
  );
  assert.equal(agent.transcript.find((entry) => entry.text.startsWith("Ran")).tool, "shell");
  // A transcript entry seen again (the same message replayed) isn't counted twice.
  const replay = mapClaudeMessage(tool("t4", "Bash", { command: "npm test" }), state);
  assert.equal((replay.findLast((e) => e.type === "subagent-update")?.agent ?? agent).progress.tools.commands, 1);
});
test("Claude keeps a subagent's TaskCreate list once its result gives the id", () => {
  const state = {};
  mapClaudeMessage(launch, state);
  mapClaudeMessage(
    {
      type: "assistant",
      parent_tool_use_id: "spawn",
      uuid: "c1",
      message: { id: "c1", content: [{ type: "tool_use", id: "create", name: "TaskCreate", input: { subject: "Audit the session cookie" } }] },
    },
    state,
  );
  const created = mapClaudeMessage(
    {
      type: "user",
      parent_tool_use_id: "spawn",
      message: { content: [{ type: "tool_result", tool_use_id: "create", content: "Task #7 created successfully" }] },
    },
    state,
  );
  const agent = created.findLast((e) => e.type === "subagent-update").agent;
  assert.deepEqual(agent.tasks, [{ id: "7", content: "Audit the session cookie", status: "pending" }]);
});
test("Codex keeps a subagent's plan updates on it, not on the chat", () => {
  const state = { threadId: "root", turnId: "turn" };
  mapCodexNotification(
    "item/completed",
    {
      threadId: "root",
      turnId: "turn",
      item: {
        id: "spawn",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "completed",
        receiverThreadIds: ["child"],
        prompt: "Review auth",
        agentsStates: { child: { status: "running", message: null } },
      },
    },
    state,
  );
  const events = mapCodexNotification(
    "turn/plan/updated",
    {
      threadId: "child",
      turnId: "child-turn",
      plan: [
        { step: "Read the code", status: "completed" },
        { step: "Write it up", status: "inProgress" },
      ],
    },
    state,
  );
  assert.equal(
    events.some((e) => e.type === "tasks-updated"),
    false,
  );
  assert.deepEqual(
    child(events).tasks.map((task) => task.status),
    ["completed", "in_progress"],
  );
});
