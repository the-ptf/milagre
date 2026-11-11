// Deterministic Claude lifecycle messages, shared only by fixture generation.
const assistant = (content, parent = null, uuid = "m1") => ({ type: "assistant", parent_tool_use_id: parent, uuid, message: { content } });
const use = (id, name, input = {}) => ({ type: "tool_use", id, name, input });
const launch = (id = "a", input = {}, parent = null) => assistant([use(id, "Agent", { description: "Review auth", prompt: "Check auth", ...input })], parent);
const result = (id, content, parent = null, extra = {}) => ({
  type: "user",
  parent_tool_use_id: parent,
  message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
  ...extra,
});
const task = (subtype, fields = {}) => ({ type: "system", subtype, task_id: "t1", ...fields });
const bg = (tasks) => task("background_tasks_changed", { tasks });
const settle = (status) => ({ settle: status });
module.exports = [
  [
    "child-foreground-nested",
    [
      launch(),
      launch("b", { subagent_type: "Explore" }, "a"),
      assistant([{ type: "text", text: "## Checking **auth**. Then tests." }, use("r", "Read", { file_path: "screen.PNG" })], "a"),
      result("r", "Read image", "a"),
      result("b", "nested done", "a"),
      result("a", "done"),
    ],
  ],
  [
    "child-background-lifecycle",
    [
      launch("a", { run_in_background: true }),
      task("task_started", { tool_use_id: "a", task_type: "local_agent" }),
      result("a", "launched", null, { tool_use_result: { status: "async_launched" } }),
      task("task_progress", { summary: "Testing." }),
      task("task_updated", { patch: { status: "paused" } }),
      task("task_updated", { patch: { status: "running", description: "Tests" } }),
      task("task_notification", { status: "completed", summary: "Done." }),
      settle("cancelled"),
    ],
  ],
  [
    "child-orphan-and-unknown",
    [
      assistant([{ type: "text", text: "unknown" }], "missing"),
      task("task_progress", { summary: "ignored" }),
      task("task_started", { task_type: "local_bash" }),
      task("task_started", { subagent_type: "qa-breaker", description: "QA" }),
      task("task_updated", { patch: { is_backgrounded: true, status: "pending" } }),
      task("task_notification", { status: "future", summary: "unknown outcome" }),
      settle("failed"),
    ],
  ],
  [
    "child-replay-and-replacement",
    [
      launch(),
      assistant([{ type: "text", text: "One. Next" }, use("s", "Bash", { command: "ls" })], "a"),
      assistant([{ type: "text", text: "One. Next" }, use("s", "Bash", { command: "ls" })], "a"),
      assistant([{ type: "text", text: "Replaced" }], "a"),
      result("s", "ok", "a"),
      result("s", "ok", "a"),
      result("a", "done"),
      task("task_started", { tool_use_id: "a", task_type: "local_agent" }),
      settle("failed"),
      settle("failed"),
    ],
  ],
  [
    "child-task-lists",
    [
      launch(),
      assistant([use("c", "TaskCreate", { subject: "Build", activeForm: "Building" })], "a"),
      result("c", "Task #7 created successfully", "a", { tool_use_result: { task: { id: "7" } } }),
      assistant([use("u", "TaskUpdate", { taskId: "7", status: "in_progress" })], "a"),
      result("u", "ok", "a"),
      assistant([use("l", "TaskList")], "a"),
      result("l", "list", "a", { tool_use_result: { tasks: [{ id: "7", subject: "Build", status: "completed" }] } }),
      assistant([use("todo", "TodoWrite", { todos: [{ content: "Review", status: "pending" }] }), use("get", "TaskGet", { taskId: "0" })], "a"),
      result("todo", "ok", "a"),
      result("get", "ok", "a"),
      settle("cancelled"),
    ],
  ],
  [
    "child-task-batched-no-structured",
    [
      launch(),
      assistant([use("c", "TaskCreate", { subject: "Build" }), use("d", "TaskCreate", { subject: "Test" })], "a"),
      {
        type: "user",
        parent_tool_use_id: "a",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "c", content: "Task #1 created successfully" },
            { type: "tool_result", tool_use_id: "d", content: "Task #2 created successfully" },
          ],
        },
        tool_use_result: { task: { id: "wrong" } },
      },
    ],
  ],
  [
    "child-transcript-tail",
    [
      launch(),
      ...Array.from({ length: 105 }, (_, i) => assistant([{ type: "text", text: `${i}. Step ${i}. Details` }], "a", `m${i}`)),
      assistant([use("long", "Bash", { command: "ls" })], "a"),
      result("long", "x".repeat(21000), "a"),
      settle("failed"),
    ],
  ],
  [
    "child-status-mapping",
    [
      launch(),
      task("task_started", { tool_use_id: "a", task_type: "local_agent" }),
      ...["pending", "running", "paused", "completed", "running", "failed", "running", "killed", "future"].map((status) =>
        task("task_updated", { patch: { status } }),
      ),
      task("task_notification", { status: "stopped", summary: "stopped" }),
    ],
  ],
  [
    "background-set",
    [
      bg([]),
      bg([
        { task_id: "b", task_type: "local_bash", description: " Build " },
        { task_id: "a", description: "" },
        { task_id: "agent", task_type: "local_agent" },
        { task_id: "ambient", ambient: true },
      ]),
      bg([
        { task_id: "a", description: "" },
        { task_id: "b", task_type: "local_bash", description: " Build " },
      ]),
      bg([{ task_id: "b", task_type: "local_bash", description: "changed" }]),
      bg([]),
      bg([{ task_id: "b", task_type: "local_bash", description: "new" }]),
      settle("cancelled"),
    ],
  ],
  ["background-limit", [bg(Array.from({ length: 55 }, (_, i) => ({ task_id: `b${i}`, task_type: "mcp", description: "😀".repeat(120) }))), settle("failed")]],
];
