import assert from "node:assert/strict";
import test from "node:test";
import type { ChatPlan } from "./model.ts";
import { PHASES, currentPhase, deriveTasks, nativePlan, setPhase, setTasks, taskCounts, updateTask } from "./chat-plan.mjs";

const ids = (plan: ChatPlan) => {
  const out: string[] = [];
  const walk = (tasks: ChatPlan["tasks"]) => tasks.forEach((task) => (out.push(`${task.id}:${task.status}`), task.children && walk(task.children)));
  walk(plan.tasks);
  return out;
};

test("assigns position ids through three levels", () => {
  const plan = setTasks(undefined, [{ title: "A", children: [{ title: "A1", children: [{ title: "A1a" }] }, { title: "A2" }] }, { title: "B" }], 5);
  assert.deepEqual(ids(plan), ["1:pending", "1.1:pending", "1.1.1:pending", "1.2:pending", "2:pending"]);
  assert.equal(plan.source, "milagre");
  assert.equal(plan.updatedAt, 5);
});

test("a named item keeps its status; the input's status wins when given", () => {
  let plan = setTasks(undefined, [{ title: "A" }, { title: "B" }], 1);
  plan = updateTask(plan, { id: "1", status: "completed" }, 2);
  plan = setTasks(plan, [{ id: "1", title: "A renamed" }, { id: "2", title: "B", status: "in_progress" }, { title: "C" }], 3);
  assert.deepEqual(ids(plan), ["1:completed", "2:in_progress", "3:pending"]);
  assert.equal(plan.tasks[0].title, "A renamed");
});

test("unnamed items skip ids that named siblings use", () => {
  let plan = setTasks(undefined, [{ title: "A" }, { title: "B" }], 1);
  plan = setTasks(plan, [{ title: "New first" }, { id: "1", title: "A" }, { id: "2", title: "B" }], 2);
  assert.deepEqual(
    plan.tasks.map((task) => task.id),
    ["3", "1", "2"],
  );
});

test("rejects a fourth level, an empty title, duplicate ids and more than 100 tasks", () => {
  assert.throws(
    () => setTasks(undefined, [{ title: "A", children: [{ title: "B", children: [{ title: "C", children: [{ title: "D" }] }] }] }], 1),
    /at most 3 levels/,
  );
  assert.throws(() => setTasks(undefined, [{ title: "  " }], 1), /no title/);
  assert.throws(
    () =>
      setTasks(
        undefined,
        [
          { id: "1", title: "A" },
          { id: "1", title: "B" },
        ],
        1,
      ),
    /used twice/,
  );
  assert.throws(
    () =>
      setTasks(
        undefined,
        Array.from({ length: 101 }, (_, i) => ({ title: `T${i}` })),
        1,
      ),
    /at most 100/,
  );
});

test("parents derive their status from their subtasks", () => {
  const tasks = deriveTasks([
    {
      id: "1",
      title: "A",
      status: "pending",
      children: [
        { id: "1.1", title: "x", status: "completed" },
        { id: "1.2", title: "y", status: "pending" },
      ],
    },
    { id: "2", title: "B", status: "pending", children: [{ id: "2.1", title: "z", status: "completed" }] },
    { id: "3", title: "C", status: "completed", children: [{ id: "3.1", title: "w", status: "pending" }] },
  ]);
  assert.deepEqual(
    tasks.map((task) => task.status),
    ["in_progress", "completed", "pending"],
  );
});

test("updateTask changes one leaf and refuses parents and unknown ids", () => {
  let plan = setTasks(undefined, [{ title: "A", children: [{ title: "A1" }, { title: "A2" }] }], 1);
  plan = updateTask(plan, { id: "1.1", status: "in_progress", activeForm: "Doing A1" }, 2);
  assert.deepEqual(ids(plan), ["1:in_progress", "1.1:in_progress", "1.2:pending"]);
  assert.equal(plan.tasks[0].children?.[0].activeForm, "Doing A1");
  assert.throws(() => updateTask(plan, { id: "1", status: "completed" }, 3), /status of its subtasks/);
  assert.throws(() => updateTask(plan, { id: "9" }, 3), /No task 9.*1, 1\.1, 1\.2/);
  assert.throws(() => updateTask(undefined, { id: "1" }, 3), /tasks_set/);
});

test("setPhase appends, skips repeats, caps at 200 and keeps the source", () => {
  let plan = setPhase(undefined, "plan", 1);
  plan = setPhase(plan, "plan", 2);
  plan = setPhase(plan, "build", 3);
  assert.deepEqual(plan.phases, [
    { phase: "plan", at: 1 },
    { phase: "build", at: 3 },
  ]);
  assert.equal(currentPhase(plan), "build");
  for (let i = 0; i < 300; i++) plan = setPhase(plan, i % 2 ? "test" : "build", 10 + i);
  assert.equal(plan.phases.length, 200);
  const native = nativePlan(undefined, [{ id: "0", content: "x", status: "pending" }], 1)!;
  assert.equal(setPhase(native, "build", 2).source, "native");
  assert.equal(PHASES.length, 8);
});

test("nativePlan mirrors a flat list until Milagre owns the plan", () => {
  const native = nativePlan(undefined, [{ id: "0", content: "Read", activeForm: "Reading", status: "in_progress" }], 1)!;
  assert.deepEqual(native.tasks, [{ id: "0", title: "Read", activeForm: "Reading", status: "in_progress" }]);
  assert.equal(native.source, "native");
  assert.equal(nativePlan(native, [], 2), undefined);
  const owned = setTasks(native, [{ title: "Mine" }], 3);
  assert.equal(nativePlan(owned, [{ id: "0", content: "Other", status: "pending" }], 4), owned);
  const withPhase = setPhase(native, "build", 5);
  assert.deepEqual(nativePlan(withPhase, [], 6)?.tasks, []);
});

test("taskCounts counts leaves only", () => {
  const plan = setTasks(
    undefined,
    [
      { title: "A", children: [{ title: "A1", status: "completed" }, { title: "A2" }] },
      { title: "B", status: "completed" },
    ],
    1,
  );
  assert.deepEqual(taskCounts(plan.tasks), { done: 2, total: 3 });
});

test("an unnamed item never inherits a dropped task's state", () => {
  let plan = setTasks(undefined, [{ title: "A" }, { title: "B", activeForm: "Doing B" }], 1);
  plan = updateTask(plan, { id: "1", status: "completed" }, 2);
  plan = updateTask(plan, { id: "2", status: "in_progress" }, 3);
  plan = setTasks(plan, [{ id: "1", title: "A" }, { title: "C new" }], 4);
  assert.deepEqual(ids(plan), ["1:completed", "2:pending"]);
  assert.equal(plan.tasks[1].title, "C new");
  assert.equal(plan.tasks[1].activeForm, undefined);
});

test("a plan made by setPhase stays native until a task tool writes", () => {
  const phased = setPhase(undefined, "plan", 1);
  assert.equal(phased.source, "native");
  const mirrored = nativePlan(phased, [{ id: "0", content: "x", status: "pending" }], 2)!;
  assert.equal(mirrored.source, "native");
  assert.deepEqual(mirrored.tasks, [{ id: "0", title: "x", status: "pending" }]);
  assert.deepEqual(mirrored.phases, [{ phase: "plan", at: 1 }]);
  assert.throws(() => updateTask(phased, { id: "1" }, 2), /tasks_set/);
});
