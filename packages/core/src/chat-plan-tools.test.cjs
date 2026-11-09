const assert = require("node:assert/strict");
const test = require("node:test");
const { inputSchema, runTool } = require("./linked-tools.cjs");
const { PLAN_TOOL_NAMES, createChatPlanTools, formatPlan } = require("./chat-plan-tools.cjs");

function harness() {
  const plans = new Map();
  const writes = [];
  let clock = 100;
  // Like ChatHost.updatePlan: changes run one after another, and one that throws saves nothing.
  let queue = Promise.resolve();
  const tools = createChatPlanTools({
    read: async (chatId) => plans.get(chatId),
    update: (chatId, change) => {
      const run = queue.then(async () => {
        const plan = change(plans.get(chatId));
        await new Promise((resolve) => setImmediate(resolve));
        plans.set(chatId, plan);
        writes.push(plan);
        return plan;
      });
      queue = run.catch(() => {});
      return run;
    },
    now: () => ++clock,
  });
  const call = (name, args, chatId = "/p#1") =>
    runTool(
      tools.definitions(chatId).find((tool) => tool.name === name),
      args,
    );
  return { plans, writes, call, tools };
}

test("tasks_set writes the tree and returns it with ids", async () => {
  const { plans, call } = harness();
  const result = await call("tasks_set", { tasks: [{ title: "Persist", children: [{ title: "Save" }, { title: "Restore" }] }, { title: "Verify" }] });
  assert.equal(result.isError, false);
  assert.equal(result.text, "[ ] 1 Persist\n  [ ] 1.1 Save\n  [ ] 1.2 Restore\n[ ] 2 Verify");
  assert.equal(plans.get("/p#1").source, "milagre");
});

test("task_update ticks a leaf and the parent follows", async () => {
  const { call } = harness();
  await call("tasks_set", { tasks: [{ title: "Persist", children: [{ title: "Save" }, { title: "Restore" }] }] });
  const result = await call("task_update", { id: "1.1", status: "completed" });
  assert.equal(result.text, "[~] 1 Persist\n  [x] 1.1 Save\n  [ ] 1.2 Restore");
});

test("writes to one Chat run in order", async () => {
  const { plans, call } = harness();
  await call("tasks_set", { tasks: [{ title: "A" }, { title: "B" }] });
  await Promise.all([call("task_update", { id: "1", status: "completed" }), call("task_update", { id: "2", status: "completed" })]);
  assert.deepEqual(
    plans.get("/p#1").tasks.map((task) => task.status),
    ["completed", "completed"],
  );
});

test("errors come back as tool errors and write nothing", async () => {
  const { writes, call } = harness();
  const result = await call("task_update", { id: "1", status: "completed" });
  assert.equal(result.isError, true);
  assert.match(result.text, /tasks_set/);
  assert.equal(writes.length, 0);
  const bad = await call("phase_set", { phase: "ship" });
  assert.equal(bad.isError, true);
});

test("phase_set records the phase and tasks_read shows it", async () => {
  const { call } = harness();
  await call("tasks_set", { tasks: [{ title: "A" }] });
  await call("phase_set", { phase: "build" });
  const read = await call("tasks_read", {});
  assert.equal(read.text, "Phase: build\n[ ] 1 A");
});

test("formatPlan says when there is nothing yet", () => {
  assert.equal(formatPlan(undefined), "No task list yet.");
});

test("tasks_set refuses a fourth level and writes nothing", async () => {
  const { writes, call } = harness();
  const result = await call("tasks_set", { tasks: [{ title: "A", children: [{ title: "B", children: [{ title: "C", children: [{ title: "D" }] }] }] }] });
  assert.equal(result.isError, true);
  assert.match(result.text, /Invalid arguments/);
  assert.equal(writes.length, 0);
  const ok = await call("tasks_set", { tasks: [{ title: "A", children: [{ title: "B", children: [{ title: "C" }] }] }] });
  assert.equal(ok.isError, false);
});

test("every tool's input renders as a JSON schema, including the recursive task tree", () => {
  const { tools } = harness();
  for (const definition of tools.definitions("/p#1")) assert.doesNotThrow(() => inputSchema(definition));
  const schema = inputSchema(tools.definitions("/p#1").find((tool) => tool.name === "tasks_set"));
  assert.equal(schema.type, "object");
  assert.ok(schema.properties.tasks);
  assert.doesNotMatch(JSON.stringify(schema), /\$ref|\$defs/);
});

test("PLAN_TOOL_NAMES lists exactly the tools served", () => {
  const { tools } = harness();
  assert.deepEqual(
    tools.definitions("/p#1").map((tool) => tool.name),
    [...PLAN_TOOL_NAMES],
  );
});
