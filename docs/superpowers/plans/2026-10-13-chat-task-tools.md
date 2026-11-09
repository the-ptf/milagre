# Chat Task Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Chat, on any provider, keeps a persisted nested task list and phase history written through Milagre MCP tools, shown in a Tasks pill with a phase graph on desktop and phone.

**Architecture:** A pure shared module (`chat-plan.mjs`) owns the tree rules; a second (`phase-graph.mjs`) turns phase history into chart geometry. The plan lives on the Chat's session record as `session.plan` and changes through one new agent event, `plan-updated`, folded by the existing shared reducer, so storage, desktop live updates and phone snapshots come for free. Four Milagre tools (`tasks_set`, `task_update`, `tasks_read`, `phase_set`) join `extraTools` so Claude, Codex and Antigravity all get them; native todo lists map into the same plan until a Milagre tool takes it over.

**Tech Stack:** Node `node:test` (TS via type stripping), zod 4 tool inputs, React + Tailwind (desktop), Expo Router + react-native-svg (phone), Hugeicons.

**Spec:** `docs/superpowers/specs/2026-10-13-chat-task-tools-design.md`

## Global Constraints

- Tasks nest at most 3 levels; at most 100 tasks in one plan; at most 200 phase entries (oldest dropped).
- Ids are assigned by Milagre: `1`, `1.2`, `1.2.1`. An item that names an existing id keeps that task's status unless it gives one.
- Parent status is derived from children; `task_update` with `status` on a parent is an error.
- Phases, in row order bottom to top: `start`, `plan`, `build`, `test`, `review`, `merge`, `release`, `done`.
- `tasks_set` / `task_update` set `source: "milagre"`; after that, native `tasks-updated` events are ignored for that Chat. `phase_set` keeps the current source.
- No new dependencies. Charts are SVG (`react-native-svg` 15.15.4 is already in the phone app).
- No Claude attribution in commits or PR text. No screenshots in the PR diff (they go on the `screenshots` branch).
- Prose in UI copy and tool descriptions: no em or en dashes.

## Review Focus

1. **A Chat from before this change** (session has no `plan`, a run with old `tasks`): nothing throws; the pill is hidden; the first native or Milagre write creates the plan. Pinned by the reducer test "a session without plan takes a native list".
2. **The agent resends a tree that drops an in-progress task and adds new unnamed ones:** new items must not reuse a dropped or explicit id among siblings. Pinned by "unnamed items skip ids that named siblings use".
3. **Two `task_update` calls in quick succession** (agents batch tool calls): the second must see the first's result. Pinned by "writes to one Chat run in order".
4. **A phase history with a long idle stretch and a single entry:** the graph must not divide by zero or put the Now line at x=0. Pinned by "one entry draws a flat line to Now" and "a stretch over an hour folds into a gap".
5. **Turn end:** the plan must survive `turn-completed` and the run must no longer carry tasks. Pinned by "the plan outlives the turn".

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/shared/src/model.ts` (modify) | `ChatTask`, `ChatPlan`, `ChatPhase`, `ChatPhaseEntry` types; `plan?` on `AgentSession`; `plan-updated` in `AgentEvent` |
| `packages/shared/src/chat-plan.mjs` + `.d.mts` (create) | Tree rules: `setTasks`, `updateTask`, `setPhase`, `nativePlan`, `deriveTasks`, `taskCounts`, `currentPhase`, `PHASES` |
| `packages/shared/src/phase-graph.mjs` + `.d.mts` (create) | `phaseGraph(phases, now, options)` geometry and `phaseGraphPath(points, width, height)` |
| `packages/shared/src/agent-runs.mjs` + `.d.mts` (modify) | Reducer: `plan-updated` stores the plan; `tasks-updated` maps a native list; run no longer carries `tasks` |
| `packages/shared/package.json` (modify) | Exports `./chat-plan`, `./phase-graph` |
| `packages/core/src/chat-plan-tools.cjs` (create) | The four tool definitions, per-Chat write queue, text formatting |
| `packages/core/src/agents/chat-host.cjs` (modify) | `plan(chatId)` reader |
| `packages/core/src/runtime.cjs` (modify) | Wire tools into `extraTools` |
| `packages/core/src/agents/events.cjs` (modify) | Tasks paragraph in `milagreInstructions` |
| `apps/desktop/app/src/components/agents/TaskTrack.tsx` (rewrite) | Pill + popover with tree and phase graph |
| `apps/desktop/app/src/components/agents/PhaseGraph.tsx` (create) | SVG phase graph |
| `apps/desktop/app/src/components/ChatComposer.tsx`, `App.tsx`, `LinkWorkspace.tsx` (modify) | Pass `plan` from the session instead of `run.tasks` |
| `scripts/test-task-track.cjs` (modify) | Electron check for the nested tree and graph |
| `apps/mobile/src/plan-view.tsx` (create) | Tree + SVG phase graph for the phone |
| `apps/mobile/src/app/plan-sheet.tsx` (create), `_layout.tsx`, `chat.tsx`, `chat-reply.tsx` (modify) | Pill in the composer row, sheet route, inline card removed |
| `GLOSSARY.md` (modify) | Task list, Phase |

---

### Task 1: Shared plan model and tree rules

**Files:**
- Modify: `packages/shared/src/model.ts` (next to `AgentTask`, ~line 513; `AgentSession` ~line 113; `AgentEvent` union ~line 537)
- Create: `packages/shared/src/chat-plan.mjs`, `packages/shared/src/chat-plan.d.mts`
- Modify: `packages/shared/package.json` (`exports`)
- Test: `packages/shared/src/chat-plan.test.ts`

**Interfaces:**
- Produces (types, `model.ts`): `ChatTaskStatus`, `ChatTask { id; title; activeForm?; status; children? }`, `ChatPhase`, `ChatPhaseEntry { phase; at }`, `ChatPlan { source: "milagre" | "native"; tasks; phases; updatedAt }`, `AgentSession.plan?: ChatPlan`, event `{ type: "plan-updated"; plan: ChatPlan | null }`.
- Produces (functions, `@milagre/shared/chat-plan`):
  - `PHASES: readonly ChatPhase[]`
  - `setTasks(plan: ChatPlan | undefined, input: TaskInput[], now: number): ChatPlan` (throws `Error` with a user-facing sentence)
  - `updateTask(plan: ChatPlan | undefined, change: { id: string; status?; title?; activeForm? }, now: number): ChatPlan` (throws)
  - `setPhase(plan: ChatPlan | undefined, phase: ChatPhase, now: number): ChatPlan`
  - `nativePlan(plan: ChatPlan | undefined, tasks: AgentTask[], now: number): ChatPlan | undefined` (returns `plan` itself when Milagre owns it)
  - `deriveTasks(tasks: ChatTask[]): ChatTask[]`
  - `taskCounts(tasks: ChatTask[]): { done: number; total: number }` (leaves only)
  - `currentPhase(plan: ChatPlan | undefined): ChatPhase | undefined`
  - `TaskInput = { id?: string; title: string; activeForm?: string; status?: ChatTaskStatus; children?: TaskInput[] }`

- [ ] **Step 1: Add the types to `model.ts`**

After the `AgentTask` interface:

```ts
/** A Chat task's state. A parent's is derived from its subtasks (chat-plan.mjs). */
export type ChatTaskStatus = "pending" | "in_progress" | "completed";

/** One item of a Chat's task list, at most three levels deep. Ids are Milagre's: "1", "1.2", "1.2.1". */
export interface ChatTask {
  id: string;
  title: string;
  /** Present-continuous wording shown while in progress ("Saving wishlist changes"). */
  activeForm?: string;
  status: ChatTaskStatus;
  children?: ChatTask[];
}

/** Where a Chat's work is, set by the agent with phase_set. In graph row order, bottom to top. */
export type ChatPhase = "start" | "plan" | "build" | "test" | "review" | "merge" | "release" | "done";

export interface ChatPhaseEntry {
  phase: ChatPhase;
  /** When the agent moved to this phase, in milliseconds since epoch. */
  at: number;
}

/** A Chat's task list and phase history. Lives on the session, so it outlasts turns and restarts. */
export interface ChatPlan {
  /** "milagre" once tasks_set or task_update wrote it; "native" while it mirrors the provider's own todo list. */
  source: "milagre" | "native";
  tasks: ChatTask[];
  /** Oldest first, at most 200; the last is the current phase. */
  phases: ChatPhaseEntry[];
  updatedAt: number;
}
```

In `AgentSession`, after `subagents?: Subagent[];`:

```ts
  /** The Chat's task list and phase history (chat-plan.mjs); absent until an agent writes one. */
  plan?: ChatPlan;
```

In the `AgentEvent` union, after the `tasks-updated` member:

```ts
  /** Milagre's own event: a task tool changed the Chat's plan; null clears it. */
  | { type: "plan-updated"; plan: ChatPlan | null }
```

- [ ] **Step 2: Write the failing tests**

Create `packages/shared/src/chat-plan.test.ts`:

```ts
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
  assert.throws(() => setTasks(undefined, [{ title: "A", children: [{ title: "B", children: [{ title: "C", children: [{ title: "D" }] }] }] }], 1), /at most 3 levels/);
  assert.throws(() => setTasks(undefined, [{ title: "  " }], 1), /no title/);
  assert.throws(() => setTasks(undefined, [{ id: "1", title: "A" }, { id: "1", title: "B" }], 1), /used twice/);
  assert.throws(() => setTasks(undefined, Array.from({ length: 101 }, (_, i) => ({ title: `T${i}` })), 1), /at most 100/);
});

test("parents derive their status from their subtasks", () => {
  const tasks = deriveTasks([
    { id: "1", title: "A", status: "pending", children: [
      { id: "1.1", title: "x", status: "completed" },
      { id: "1.2", title: "y", status: "pending" },
    ] },
    { id: "2", title: "B", status: "pending", children: [{ id: "2.1", title: "z", status: "completed" }] },
    { id: "3", title: "C", status: "completed", children: [{ id: "3.1", title: "w", status: "pending" }] },
  ]);
  assert.deepEqual(tasks.map((task) => task.status), ["in_progress", "completed", "pending"]);
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
  assert.deepEqual(plan.phases, [{ phase: "plan", at: 1 }, { phase: "build", at: 3 }]);
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
  const plan = setTasks(undefined, [{ title: "A", children: [{ title: "A1", status: "completed" }, { title: "A2" }] }, { title: "B", status: "completed" }], 1);
  assert.deepEqual(taskCounts(plan.tasks), { done: 2, total: 3 });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/shared && node --test src/chat-plan.test.ts`
Expected: FAIL with `Cannot find module './chat-plan.mjs'`.

- [ ] **Step 4: Implement `chat-plan.mjs`**

```js
// A Chat's task list and phase history (ChatPlan in model.ts), written by Milagre's task tools or mirrored from a
// provider's own todo list. Pure functions: core, desktop and phone share them. Errors are sentences for the agent.

export const PHASES = Object.freeze(["start", "plan", "build", "test", "review", "merge", "release", "done"]);
const MAX_DEPTH = 3;
const MAX_TASKS = 100;
const MAX_PHASES = 200;

const text = (value) => (typeof value === "string" ? value.trim() : "");

/** Every task by id, depth first. */
function byId(tasks, out = new Map()) {
  for (const task of tasks) {
    out.set(task.id, task);
    if (task.children) byId(task.children, out);
  }
  return out;
}

/** Parents take their status from their subtasks; leaves keep theirs. */
export function deriveTasks(tasks) {
  return tasks.map((task) => {
    if (!task.children?.length) {
      const { children: _none, ...leaf } = task;
      return leaf;
    }
    const children = deriveTasks(task.children);
    const done = children.filter((child) => child.status === "completed").length;
    const status =
      done === children.length ? "completed" : done > 0 || children.some((child) => child.status === "in_progress") ? "in_progress" : "pending";
    return { ...task, status, children };
  });
}

/** Replaces the tree with `input`, keeping the status of tasks it names by id. */
export function setTasks(plan, input, now) {
  const known = byId(plan?.tasks ?? []);
  const explicit = new Set();
  let count = 0;
  const collect = (items) => {
    for (const item of items ?? []) {
      const id = text(item.id);
      if (id) {
        if (explicit.has(id)) throw new Error(`Task id ${id} is used twice.`);
        explicit.add(id);
      }
      collect(item.children);
    }
  };
  collect(input);
  const build = (items, prefix, depth) => {
    if (depth > MAX_DEPTH) throw new Error(`Tasks nest at most ${MAX_DEPTH} levels; "${text(items[0]?.title)}" is level ${depth}.`);
    let next = 1;
    return items.map((item, index) => {
      const title = text(item.title);
      if (!title) throw new Error(`Task ${prefix}${index + 1} has no title.`);
      if (++count > MAX_TASKS) throw new Error(`A task list holds at most ${MAX_TASKS} tasks.`);
      let id = text(item.id);
      if (!id) {
        while (explicit.has(`${prefix}${next}`)) next++;
        id = `${prefix}${next}`;
        explicit.add(id);
      }
      const previous = known.get(id);
      const activeForm = text(item.activeForm) || previous?.activeForm;
      const children = item.children?.length ? build(item.children, `${id}.`, depth + 1) : undefined;
      return {
        id,
        title,
        ...(activeForm ? { activeForm } : {}),
        status: item.status ?? previous?.status ?? "pending",
        ...(children ? { children } : {}),
      };
    });
  };
  const tasks = deriveTasks(build(input, "", 1));
  return { source: "milagre", tasks, phases: plan?.phases ?? [], updatedAt: now };
}

/** Changes one task: a leaf's status, or any task's title and activeForm. */
export function updateTask(plan, change, now) {
  if (!plan || plan.source !== "milagre") throw new Error("This Chat has no task list yet: write one with tasks_set.");
  const all = byId(plan.tasks);
  const target = all.get(change.id);
  if (!target) throw new Error(`No task ${change.id}. Task ids: ${[...all.keys()].join(", ")}.`);
  if (change.status && target.children?.length) throw new Error(`Task ${change.id} has subtasks: set the status of its subtasks instead.`);
  const patch = (tasks) =>
    tasks.map((task) => {
      if (task.id === change.id) {
        const title = text(change.title) || task.title;
        const activeForm = text(change.activeForm) || task.activeForm;
        return { ...task, title, ...(activeForm ? { activeForm } : {}), ...(change.status ? { status: change.status } : {}) };
      }
      return task.children ? { ...task, children: patch(task.children) } : task;
    });
  return { ...plan, tasks: deriveTasks(patch(plan.tasks)), updatedAt: now };
}

/** Moves the Chat to `phase`; the same phase twice in a row is one entry. Keeps the plan's source. */
export function setPhase(plan, phase, now) {
  const base = plan ?? { source: "milagre", tasks: [], phases: [], updatedAt: now };
  if (currentPhase(base) === phase) return base;
  return { ...base, phases: [...base.phases, { phase, at: now }].slice(-MAX_PHASES), updatedAt: now };
}

/** A provider's own flat todo list as the plan, unless Milagre's tools own it. An empty list with no phases clears it. */
export function nativePlan(plan, tasks, now) {
  if (plan?.source === "milagre") return plan;
  const phases = plan?.phases ?? [];
  if (!tasks.length && !phases.length) return undefined;
  return {
    source: "native",
    tasks: tasks.map((task) => ({ id: task.id, title: task.content, ...(task.activeForm ? { activeForm: task.activeForm } : {}), status: task.status })),
    phases,
    updatedAt: now,
  };
}

/** Done and total over leaves, for the pill. */
export function taskCounts(tasks) {
  let done = 0;
  let total = 0;
  for (const task of byId(tasks).values()) {
    if (task.children?.length) continue;
    total++;
    if (task.status === "completed") done++;
  }
  return { done, total };
}

export function currentPhase(plan) {
  return plan?.phases.at(-1)?.phase;
}
```

Create `packages/shared/src/chat-plan.d.mts`:

```ts
import type { AgentTask, ChatPhase, ChatPlan, ChatTask, ChatTaskStatus } from "./model.ts";

export type TaskInput = { id?: string; title: string; activeForm?: string; status?: ChatTaskStatus; children?: TaskInput[] };
export const PHASES: readonly ChatPhase[];
export function deriveTasks(tasks: ChatTask[]): ChatTask[];
export function setTasks(plan: ChatPlan | undefined, input: TaskInput[], now: number): ChatPlan;
export function updateTask(
  plan: ChatPlan | undefined,
  change: { id: string; status?: ChatTaskStatus; title?: string; activeForm?: string },
  now: number,
): ChatPlan;
export function setPhase(plan: ChatPlan | undefined, phase: ChatPhase, now: number): ChatPlan;
export function nativePlan(plan: ChatPlan | undefined, tasks: AgentTask[], now: number): ChatPlan | undefined;
export function taskCounts(tasks: ChatTask[]): { done: number; total: number };
export function currentPhase(plan: ChatPlan | undefined): ChatPhase | undefined;
```

In `packages/shared/package.json` `exports`, after `./chat-summary`:

```json
    "./chat-plan": {
      "types": "./src/chat-plan.d.mts",
      "default": "./src/chat-plan.mjs"
    },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/shared && node --test src/chat-plan.test.ts && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/model.ts packages/shared/src/chat-plan.mjs packages/shared/src/chat-plan.d.mts packages/shared/src/chat-plan.test.ts packages/shared/package.json
git commit -m "feat(shared): add the Chat plan model and task tree rules"
```

---

### Task 2: Phase graph geometry

**Files:**
- Create: `packages/shared/src/phase-graph.mjs`, `packages/shared/src/phase-graph.d.mts`
- Modify: `packages/shared/package.json` (`exports`)
- Test: `packages/shared/src/phase-graph.test.ts`

**Interfaces:**
- Consumes: `PHASES` from `./chat-plan.mjs`, `ChatPhaseEntry` from `model.ts`.
- Produces (`@milagre/shared/phase-graph`):
  - `phaseGraph(phases: ChatPhaseEntry[], now: number, options?: { gapMs?: number; formatTime?: (ms: number) => string }): PhaseGraph`
  - `PhaseGraph = { points: { x: number; row: number; phase: ChatPhase; at: number }[]; nowX: 1; gaps: { x0: number; x1: number; label: string }[]; ticks: { x: number; label: string }[]; current?: ChatPhase }` with `x` in [0, 1] and `row` 0 (`start`) to 7 (`done`)
  - `phaseGraphPath(points: PhaseGraph["points"], width: number, height: number): string` (SVG `d`, ends with a flat line to `x = width`)
  - `rowY(row: number, height: number): number`

- [ ] **Step 1: Write the failing tests**

Create `packages/shared/src/phase-graph.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { phaseGraph, phaseGraphPath, rowY } from "./phase-graph.mjs";

const HOUR = 3_600_000;
const format = (ms: number) => `t${ms / 60_000}`;

test("no entries draw nothing", () => {
  const graph = phaseGraph([], 10, { formatTime: format });
  assert.deepEqual(graph.points, []);
  assert.equal(graph.current, undefined);
});

test("one entry draws a flat line to Now", () => {
  const graph = phaseGraph([{ phase: "plan", at: 0 }], 0, { formatTime: format });
  assert.deepEqual(graph.points, [{ x: 0, row: 1, phase: "plan", at: 0 }]);
  assert.equal(graph.nowX, 1);
  assert.match(phaseGraphPath(graph.points, 100, 80), /^M0 \d+(\.\d+)? H100$/);
});

test("x follows time and the current phase is the last", () => {
  const graph = phaseGraph(
    [
      { phase: "start", at: 0 },
      { phase: "plan", at: 10 * 60_000 },
      { phase: "build", at: 20 * 60_000 },
    ],
    40 * 60_000,
    { formatTime: format },
  );
  assert.deepEqual(
    graph.points.map((point) => point.x),
    [0, 0.25, 0.5],
  );
  assert.equal(graph.current, "build");
  assert.deepEqual(graph.gaps, []);
});

test("a stretch over an hour folds into a gap with its length", () => {
  const graph = phaseGraph(
    [
      { phase: "build", at: 0 },
      { phase: "test", at: 30 * 60_000 },
      { phase: "review", at: 30 * 60_000 + 2 * HOUR },
    ],
    30 * 60_000 + 2 * HOUR + 30 * 60_000,
    { formatTime: format },
  );
  assert.equal(graph.gaps.length, 1);
  assert.equal(graph.gaps[0].label, "2h");
  // The two-hour stretch is drawn one hour wide: 30m + 60m + 30m.
  assert.deepEqual(
    graph.points.map((point) => Number(point.x.toFixed(3))),
    [0, 0.25, 0.75],
  );
  assert.deepEqual([graph.gaps[0].x0, graph.gaps[0].x1], [0.25, 0.75]);
});

test("ticks label the first point and points at least a quarter apart", () => {
  const graph = phaseGraph(
    [
      { phase: "start", at: 0 },
      { phase: "plan", at: 60_000 },
      { phase: "build", at: 20 * 60_000 },
      { phase: "test", at: 30 * 60_000 },
    ],
    40 * 60_000,
    { formatTime: format },
  );
  assert.deepEqual(
    graph.ticks.map((tick) => tick.label),
    ["t0", "t20", "t30"],
  );
});

test("rows run bottom to top and the path curves between points", () => {
  assert.ok(rowY(0, 80) > rowY(7, 80));
  const graph = phaseGraph(
    [
      { phase: "start", at: 0 },
      { phase: "build", at: 60_000 },
    ],
    120_000,
    { formatTime: format },
  );
  assert.match(phaseGraphPath(graph.points, 100, 80), /^M0 [\d.]+ C[\d., ]+ H100$/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/shared && node --test src/phase-graph.test.ts`
Expected: FAIL with `Cannot find module './phase-graph.mjs'`.

- [ ] **Step 3: Implement `phase-graph.mjs`**

```js
// Geometry for a Chat's phase graph: phase history to points on a 0..1 time axis that ends at Now, with stretches
// longer than `gapMs` drawn `gapMs` wide and labelled. Desktop and phone draw the same shapes with their own SVG.
import { PHASES } from "./chat-plan.mjs";

const HOUR = 3_600_000;
const defaultFormat = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function duration(ms) {
  return ms >= 48 * HOUR ? `${Math.round(ms / (24 * HOUR))}d` : `${Math.round(ms / HOUR)}h`;
}

export function phaseGraph(phases, now, { gapMs = HOUR, formatTime = defaultFormat } = {}) {
  if (!phases.length) return { points: [], nowX: 1, gaps: [], ticks: [] };
  const times = [...phases.map((entry) => entry.at), Math.max(now, phases.at(-1).at)];
  const widths = times.slice(1).map((at, index) => Math.min(Math.max(at - times[index], 0), gapMs));
  const total = widths.reduce((sum, width) => sum + width, 0);
  const xs = [0];
  for (const width of widths) xs.push(xs.at(-1) + width);
  const x = (index) => (total > 0 ? xs[index] / total : 0);
  const points = phases.map((entry, index) => ({ x: x(index), row: PHASES.indexOf(entry.phase), phase: entry.phase, at: entry.at }));
  const gaps = [];
  for (let index = 0; index < times.length - 1; index++) {
    const length = times[index + 1] - times[index];
    if (length > gapMs) gaps.push({ x0: x(index), x1: index + 1 === times.length - 1 ? 1 : x(index + 1), label: duration(length) });
  }
  const ticks = [];
  for (const point of points) {
    if (ticks.length && point.x - ticks.at(-1).x < 0.25) continue;
    if (point.x > 0.85) break;
    ticks.push({ x: point.x, label: formatTime(point.at) });
  }
  return { points, nowX: 1, gaps, ticks, current: phases.at(-1).phase };
}

/** The y of a phase row's centre, `start` (row 0) at the bottom. */
export function rowY(row, height) {
  const band = height / PHASES.length;
  return Number((height - (row + 0.5) * band).toFixed(2));
}

/** An S-curve from point to point, then flat to Now at the right edge. */
export function phaseGraphPath(points, width, height) {
  if (!points.length) return "";
  const at = (point) => [Number((point.x * width).toFixed(2)), rowY(point.row, height)];
  const [x0, y0] = at(points[0]);
  let d = `M${x0} ${y0}`;
  for (let index = 1; index < points.length; index++) {
    const [px, py] = at(points[index - 1]);
    const [nx, ny] = at(points[index]);
    const mid = Number(((px + nx) / 2).toFixed(2));
    d += ` C${mid} ${py}, ${mid} ${ny}, ${nx} ${ny}`;
  }
  return `${d} H${width}`;
}
```

Create `packages/shared/src/phase-graph.d.mts`:

```ts
import type { ChatPhase, ChatPhaseEntry } from "./model.ts";

export interface PhaseGraph {
  points: { x: number; row: number; phase: ChatPhase; at: number }[];
  nowX: 1;
  gaps: { x0: number; x1: number; label: string }[];
  ticks: { x: number; label: string }[];
  current?: ChatPhase;
}
export function phaseGraph(phases: ChatPhaseEntry[], now: number, options?: { gapMs?: number; formatTime?: (ms: number) => string }): PhaseGraph;
export function rowY(row: number, height: number): number;
export function phaseGraphPath(points: PhaseGraph["points"], width: number, height: number): string;
```

Add to `packages/shared/package.json` `exports`:

```json
    "./phase-graph": {
      "types": "./src/phase-graph.d.mts",
      "default": "./src/phase-graph.mjs"
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/shared && node --test src/phase-graph.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/phase-graph.mjs packages/shared/src/phase-graph.d.mts packages/shared/src/phase-graph.test.ts packages/shared/package.json
git commit -m "feat(shared): lay out the phase graph from a Chat's phase history"
```

---

### Task 3: Store the plan on the session through the shared reducer

**Files:**
- Modify: `packages/shared/src/agent-runs.mjs` (`applyRunEvent` `tasks-updated` case ~line 167; `applyAgentEvent` switch ~line 222)
- Modify: `packages/shared/src/agent-runs.d.mts` (drop `tasks` from `AgentRun`)
- Test: `packages/shared/src/agent-runs.test.ts`

**Interfaces:**
- Consumes: `nativePlan` from `./chat-plan.mjs`; event `plan-updated` from Task 1.
- Produces: after any `plan-updated` or `tasks-updated`, `state.sessions[id].plan` holds the plan (absent when cleared) and `changed: true`, so ChatHost saves it and publishes the state.

- [ ] **Step 1: Write the failing tests** (append to `agent-runs.test.ts`, which already has `base()`, `key()` and `PROJECT`)

```ts
test("a session without plan takes a native list", () => {
  let runs = startRun({}, key(1), "gpt-5.5");
  const first = applyAgentEvent(base(), runs, PROJECT, key(1), {
    type: "tasks-updated",
    tasks: [{ id: "0", content: "Read", status: "in_progress" }],
  });
  assert.equal(first.changed, true);
  assert.equal(first.state.sessions["1"].plan?.source, "native");
  assert.deepEqual(first.state.sessions["1"].plan?.tasks, [{ id: "0", title: "Read", status: "in_progress" }]);
  assert.equal("tasks" in (first.runs[key(1)] ?? {}), false);
});

test("plan-updated stores the plan and native lists stop once Milagre owns it", () => {
  const plan = { source: "milagre" as const, tasks: [{ id: "1", title: "Mine", status: "pending" as const }], phases: [], updatedAt: 1 };
  const runs = startRun({}, key(1), "gpt-5.5");
  const owned = applyAgentEvent(base(), runs, PROJECT, key(1), { type: "plan-updated", plan });
  assert.equal(owned.changed, true);
  assert.deepEqual(owned.state.sessions["1"].plan, plan);
  const ignored = applyAgentEvent(owned.state, owned.runs, PROJECT, key(1), {
    type: "tasks-updated",
    tasks: [{ id: "0", content: "Other", status: "pending" }],
  });
  assert.equal(ignored.changed, false);
  const cleared = applyAgentEvent(owned.state, owned.runs, PROJECT, key(1), { type: "plan-updated", plan: null });
  assert.equal(cleared.state.sessions["1"].plan, undefined);
});

test("the plan outlives the turn", () => {
  const plan = { source: "milagre" as const, tasks: [{ id: "1", title: "Mine", status: "pending" as const }], phases: [], updatedAt: 1 };
  const runs = startRun({}, key(1), "gpt-5.5");
  const owned = applyAgentEvent(base(), runs, PROJECT, key(1), { type: "plan-updated", plan });
  const ended = applyAgentEvent(owned.state, owned.runs, PROJECT, key(1), { type: "turn-completed" });
  assert.deepEqual(ended.state.sessions["1"].plan, plan);
  assert.equal(ended.runs[key(1)], undefined);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/shared && node --test --test-name-pattern="native list|plan-updated|outlives" src/agent-runs.test.ts`
Expected: FAIL (`plan` undefined; run still has `tasks`).

- [ ] **Step 3: Implement**

In `agent-runs.mjs`, add the import at the top with the others:

```js
import { nativePlan } from "./chat-plan.mjs";
```

Delete the `tasks-updated` case from `applyRunEvent` (the block commented "The agent's to-do list as it last reported it; an empty list clears it.").

In `applyAgentEvent`'s switch, before `case "session-started":`, add:

```js
    // A Chat's plan lives on its session (chat-plan.mjs), so it outlasts the turn. Milagre's task tools replace it whole.
    case "plan-updated": {
      const { plan: _previous, ...rest } = session;
      const next = event.plan ? { ...rest, plan: event.plan } : rest;
      return { state: { ...state, sessions: { ...state.sessions, [sessionId]: next } }, runs, changed: true };
    }
    // A provider's own todo list fills the plan until Milagre's tools own it.
    case "tasks-updated": {
      const plan = nativePlan(session.plan, event.tasks, Date.now());
      if (plan === session.plan) return { state, runs, changed: false };
      const { plan: _previous, ...rest } = session;
      return { state: { ...state, sessions: { ...state.sessions, [sessionId]: plan ? { ...rest, plan } : rest } }, runs, changed: true };
    }
```

In `agent-runs.d.mts`, delete the `tasks?: AgentTask[];` member of `AgentRun` and its comment, and remove `AgentTask` from the import list if it is now unused.

- [ ] **Step 4: Run the shared suite and typecheck**

Run: `cd packages/shared && npm test && npx tsc --noEmit`
Expected: PASS. Fix any existing test that asserted `run.tasks` by asserting `state.sessions[...].plan` instead.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/agent-runs.mjs packages/shared/src/agent-runs.d.mts packages/shared/src/agent-runs.test.ts
git commit -m "feat(shared): keep the Chat plan on its session across turns"
```

---

### Task 4: Milagre task tools for every provider

**Files:**
- Create: `packages/core/src/chat-plan-tools.cjs`
- Modify: `packages/core/src/agents/chat-host.cjs` (add `plan(chatId)` next to `addNote`, ~line 362)
- Modify: `packages/core/src/runtime.cjs` (`extraTools`, ~line 1339)
- Modify: `packages/core/src/agents/events.cjs` (`milagreInstructions`, ~line 20)
- Test: `packages/core/src/chat-plan-tools.test.cjs`, `packages/core/src/agents/events.test.cjs`

**Interfaces:**
- Consumes: `setTasks`, `updateTask`, `setPhase`, `currentPhase`, `PHASES` from `@milagre/shared/chat-plan`; tool shape `{ name, description, input, readOnly, run }` and `runTool` from `linked-tools.cjs`.
- Produces: `createChatPlanTools({ read, write, now? })` returning `{ definitions(chatId) }`, where `read(chatId): Promise<ChatPlan | undefined>` and `write(chatId, plan): Promise<void>`; `ChatHost.plan(chatId): Promise<ChatPlan | undefined>`; `formatPlan(plan): string`.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/chat-plan-tools.test.cjs`:

```js
const assert = require("node:assert/strict");
const test = require("node:test");
const { runTool } = require("./linked-tools.cjs");
const { createChatPlanTools, formatPlan } = require("./chat-plan-tools.cjs");

function harness() {
  const plans = new Map();
  const writes = [];
  let clock = 100;
  const tools = createChatPlanTools({
    read: async (chatId) => plans.get(chatId),
    write: async (chatId, plan) => {
      await new Promise((resolve) => setImmediate(resolve));
      plans.set(chatId, plan);
      writes.push(plan);
    },
    now: () => ++clock,
  });
  const call = (name, args, chatId = "/p#1") => runTool(tools.definitions(chatId).find((tool) => tool.name === name), args);
  return { plans, writes, call };
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
```

Add to `packages/core/src/agents/events.test.cjs`:

```js
test("Milagre instructions tell every agent to plan with the task tools", () => {
  const { milagreInstructions } = require("./events.cjs");
  const text = milagreInstructions();
  assert.match(text, /tasks_set/);
  assert.match(text, /task_update/);
  assert.match(text, /phase_set/);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/core && node --test src/chat-plan-tools.test.cjs && node --test --test-name-pattern="task tools" src/agents/events.test.cjs`
Expected: FAIL (`Cannot find module './chat-plan-tools.cjs'`; instruction text missing).

- [ ] **Step 3: Implement `chat-plan-tools.cjs`**

```js
const { z } = require("zod");
const { PHASES, currentPhase, setPhase, setTasks, updateTask } = require("@milagre/shared/chat-plan");

// Milagre's own task list and phase tools, the same for every provider. Each Chat's writes run one at a time, so a
// batch of task_update calls sees each other's results.
const MARKS = { completed: "[x]", in_progress: "[~]", pending: "[ ]" };
const status = z.enum(["pending", "in_progress", "completed"]);
const task = z.lazy(() =>
  z.object({
    id: z.string().max(20).optional().describe("Keep an existing task's id to keep its status; omit for a new task."),
    title: z.string().min(1).max(200),
    activeForm: z.string().max(200).optional().describe("Shown while in progress, e.g. 'Saving wishlist changes'."),
    status: status.optional(),
    children: z.array(task).optional(),
  }),
);

function formatPlan(plan) {
  if (!plan || (!plan.tasks.length && !plan.phases.length)) return "No task list yet.";
  const lines = [];
  const phase = currentPhase(plan);
  if (phase) lines.push(`Phase: ${phase}`);
  const walk = (tasks, depth) => {
    for (const item of tasks) {
      lines.push(`${"  ".repeat(depth)}${MARKS[item.status]} ${item.id} ${item.title}`);
      if (item.children) walk(item.children, depth + 1);
    }
  };
  walk(plan.tasks, 0);
  return lines.join("\n");
}

function createChatPlanTools({ read, write, now = Date.now }) {
  const queues = new Map();
  // Runs `change` on the Chat's current plan after its earlier writes, then saves the result.
  function change(chatId, apply) {
    const previous = queues.get(chatId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const plan = apply(await read(chatId), now());
      await write(chatId, plan);
      return plan;
    });
    const settled = next.catch(() => {});
    queues.set(chatId, settled);
    void settled.then(() => {
      if (queues.get(chatId) === settled) queues.delete(chatId);
    });
    return next;
  }
  function definitions(chatId) {
    return [
      {
        name: "tasks_set",
        description:
          "Write this Chat's task list, shown in its Tasks pill on desktop and phone. Send the whole tree, at most 3 levels deep. Keep a task's id to keep its status; new tasks get ids from Milagre. Returns the list with ids.",
        input: { tasks: z.array(task).min(1).max(100) },
        readOnly: false,
        run: async ({ tasks }) => formatPlan(await change(chatId, (plan, at) => setTasks(plan, tasks, at))),
      },
      {
        name: "task_update",
        description:
          "Change one task in this Chat's task list: mark a subtask in_progress when you start it and completed when it is done, or rename it. A parent's status follows its subtasks.",
        input: { id: z.string().min(1).max(20), status: status.optional(), title: z.string().min(1).max(200).optional(), activeForm: z.string().max(200).optional() },
        readOnly: false,
        run: async (input) => formatPlan(await change(chatId, (plan, at) => updateTask(plan, input, at))),
      },
      {
        name: "tasks_read",
        description: "Read this Chat's task list with ids, and its current phase.",
        input: {},
        readOnly: true,
        run: async () => formatPlan(await read(chatId)),
      },
      {
        name: "phase_set",
        description: `Move this Chat to a work phase, shown on its phase graph: ${PHASES.join(", ")}. Call it when the work moves on, not for every step.`,
        input: { phase: z.enum(PHASES) },
        readOnly: false,
        run: async ({ phase }) => formatPlan(await change(chatId, (plan, at) => setPhase(plan, phase, at))),
      },
    ];
  }
  return { definitions };
}

module.exports = { createChatPlanTools, formatPlan };
```

- [ ] **Step 4: Add `ChatHost.plan` and wire the tools**

In `packages/core/src/agents/chat-host.cjs`, before `async addNote(`:

```js
  /** The Chat's task list and phase history, for Milagre's task tools. */
  async plan(chatId) {
    const state = await this.states.get(projectOfKey(chatId));
    return state.sessions[sessionIdFromKey(chatId)]?.plan;
  }
```

In `packages/core/src/runtime.cjs`, just before `const linked = createLinkedWorktrees({`:

```js
  // Milagre's own task list and phase tools, the same for every provider (chat-plan-tools.cjs).
  const planTools = require("./chat-plan-tools.cjs").createChatPlanTools({
    read: (chatId) => chats.plan(chatId),
    write: (chatId, plan) => chats.receive(chatId, { type: "plan-updated", plan }),
  });
```

and in `extraTools: (chatId) => [`, as the first entry:

```js
      ...planTools.definitions(chatId),
```

- [ ] **Step 5: Add the instructions paragraph**

In `milagreInstructions` (`packages/core/src/agents/events.cjs`), after the `"When you need the user to choose between options, ..."` line:

```js
    "Tasks: for work with several steps, write the plan with milagre tasks_set (nested up to 3 levels), mark each subtask in_progress then completed with task_update as you go, and call phase_set when the work moves to a new phase (plan, build, test, review, merge, release, done). The user follows these in the Chat's Tasks pill. Do not also keep the list in your own todo or plan tool.",
```

- [ ] **Step 6: Run the core suite**

Run: `cd packages/core && npm test`
Expected: PASS. Existing instruction snapshot tests that compare `MILAGRE_INSTRUCTIONS` verbatim must be updated to include the new paragraph.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/chat-plan-tools.cjs packages/core/src/chat-plan-tools.test.cjs packages/core/src/agents/chat-host.cjs packages/core/src/runtime.cjs packages/core/src/agents/events.cjs packages/core/src/agents/events.test.cjs
git commit -m "feat(core): give every Chat Milagre task and phase tools"
```

---

### Task 5: Desktop Tasks pill with tree and phase graph

**Files:**
- Rewrite: `apps/desktop/app/src/components/agents/TaskTrack.tsx`
- Create: `apps/desktop/app/src/components/agents/PhaseGraph.tsx`
- Modify: `apps/desktop/app/src/components/ChatComposer.tsx` (prop `tasks` ~line 492 and 785, mount ~line 999)
- Modify: `apps/desktop/app/src/App.tsx:2356`, `apps/desktop/app/src/components/LinkWorkspace.tsx:540`
- Test: `scripts/test-task-track.cjs`

**Interfaces:**
- Consumes: `ChatPlan`, `ChatTask` (`../../model` re-exports shared model; if not, import from `@milagre/shared/model`), `taskCounts` from `@milagre/shared/chat-plan`, `phaseGraph`, `phaseGraphPath`, `rowY` from `@milagre/shared/phase-graph`.
- Produces: `TaskTrack({ plan }: { plan?: ChatPlan })`; `PhaseGraph({ plan }: { plan: ChatPlan })`; `ChatComposer` prop `plan?: ChatPlan` replaces `tasks`.

- [ ] **Step 1: Update the Electron check to the new shape (failing)**

In `scripts/test-task-track.cjs`, replace the `tasks` state in the fixture with:

```js
  const [plan, setPlan] = useState({ source: "milagre", updatedAt: 0, tasks: [
    {id:"1",title:"Persist wishlist items",status:"in_progress",children:[
      {id:"1.1",title:"Save wishlist changes on this device",activeForm:"Saving wishlist changes",status:"in_progress"},
      {id:"1.2",title:"Restore the wishlist on startup",status:"completed"}]},
    {id:"2",title:"Verify wishlist persistence",status:"completed",children:[
      {id:"2.1",title:"Verify items survive a browser restart",status:"completed",children:[
        {id:"2.1.1",title:"Chrome",status:"completed"}]},
      {id:"2.2",title:"Verify removed items stay removed",status:"completed"}]},
    {id:"3",title:"Prepare the wishlist evidence for review",status:"pending"}],
    phases: [
      {phase:"start",at:Date.now()-5*3600e3},{phase:"plan",at:Date.now()-4.8*3600e3},{phase:"build",at:Date.now()-4.5*3600e3},
      {phase:"test",at:Date.now()-4.2*3600e3},{phase:"review",at:Date.now()-1*3600e3}] });
  window.setPlan = setPlan;
```

pass `plan={plan}` instead of `tasks={tasks}` to `ChatComposer`, and replace the task assertions with:

```js
    assert.equal(await evaluate(`document.querySelector("${pill}").textContent`), "3/5");
    // ...inside the theme loop, after opening the popover:
      assert.equal(await evaluate('document.querySelectorAll("[data-task-row]").length'), 8);
      assert.deepEqual(await evaluate('[...document.querySelectorAll("[data-task-row]")].slice(0,2).map(row => row.dataset.depth + ":" + row.dataset.status)'), ["0:in_progress", "1:in_progress"]);
      assert.match(await evaluate('document.querySelector("[data-task-row][data-depth=\\"1\\"]").textContent'), /Saving wishlist changes/);
      assert.ok(await evaluate('!!document.querySelector("[data-slot=phase-graph] path")'));
      assert.equal(await evaluate('document.querySelector("[data-slot=phase-graph] [data-current-phase]").textContent'), "Review");
      assert.match(await evaluate('document.querySelector("[data-slot=phase-graph] [data-gap]").textContent'), /^3h$/);
    // collapsing:
      await evaluate('document.querySelector("[data-task-row] button[aria-expanded]").click()');
      assert.equal(await evaluate('document.querySelectorAll("[data-task-row]").length'), 6);
```

Change the end-of-list checks to `await evaluate("window.setPlan(p => ({...p, tasks: []}))")`, then assert the pill text is `Review` (it shows the phase when there are no tasks); then `await evaluate("window.setPlan(undefined)")` and wait for `[data-slot=task-track]` and `[data-slot=task-popover]` to be gone.

Run: `node scripts/test-task-track.cjs`
Expected: FAIL (`ChatComposer` doesn't accept `plan`).

- [ ] **Step 2: Write `PhaseGraph.tsx`**

```tsx
import { HugeiconsIcon } from "@hugeicons/react";
import { CheckmarkCircle02Icon, EyeIcon, Flag01Icon, GitMergeIcon, Rocket01Icon, Target02Icon, TestTube01Icon, Wrench01Icon } from "@hugeicons/core-free-icons";
import { PHASES } from "@milagre/shared/chat-plan";
import { phaseGraph, phaseGraphPath, rowY } from "@milagre/shared/phase-graph";
import type { ChatPhase, ChatPlan } from "../../model";

export const PHASE_LABELS: Record<ChatPhase, string> = {
  start: "Start", plan: "Plan", build: "Build", test: "Test", review: "Review", merge: "Merge", release: "Release", done: "Done",
};
const PHASE_ICONS = {
  start: Flag01Icon, plan: Target02Icon, build: Wrench01Icon, test: TestTube01Icon, review: EyeIcon, merge: GitMergeIcon, release: Rocket01Icon, done: CheckmarkCircle02Icon,
} as const;

const WIDTH = 260;
const HEIGHT = 168;

/** The Chat's phase history on a time axis that ends at Now; long idle stretches fold into a labelled gap. */
export function PhaseGraph({ plan, now = Date.now() }: { plan: ChatPlan; now?: number }) {
  const graph = phaseGraph(plan.phases, now);
  if (!graph.points.length) return null;
  const path = phaseGraphPath(graph.points, WIDTH, HEIGHT);
  return (
    <section data-slot="phase-graph" aria-label="Phase graph" className="flex flex-col gap-2 px-2 pb-2">
      <h3 className="flex items-center gap-2 text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase">
        <span aria-hidden className="h-px w-3 bg-accent" />
        Phase graph
      </h3>
      <div className="flex gap-2">
        <ol className="flex flex-col-reverse justify-between" style={{ height: HEIGHT }}>
          {PHASES.map((phase) => {
            const current = graph.current === phase;
            return (
              <li
                key={phase}
                {...(current ? { "data-current-phase": "" } : {})}
                className={`flex h-5 items-center gap-1 rounded px-1 text-[11px] ${current ? "bg-hover text-ink" : "text-ink-3"}`}
              >
                <HugeiconsIcon icon={PHASE_ICONS[phase]} size={11} aria-hidden />
                {PHASE_LABELS[phase]}
              </li>
            );
          })}
        </ol>
        <div className="relative min-w-0 flex-1">
          <svg viewBox={`0 0 ${WIDTH} ${HEIGHT + 18}`} className="w-full overflow-visible" role="img" aria-label={`Current phase: ${PHASE_LABELS[graph.current!]}`}>
            {graph.gaps.map((gap) => (
              <g key={`${gap.x0}-${gap.x1}`} data-gap>
                <rect x={((gap.x0 + gap.x1) / 2) * WIDTH - 12} y={HEIGHT / 2 - 8} width={24} height={16} rx={4} className="fill-[var(--color-accent-soft,theme(colors.hover))]" />
                <text x={((gap.x0 + gap.x1) / 2) * WIDTH} y={HEIGHT / 2 + 4} textAnchor="middle" className="fill-ink-2 text-[10px]">
                  {gap.label}
                </text>
              </g>
            ))}
            <path d={path} fill="none" strokeWidth={2} className="stroke-accent" strokeLinecap="round" />
            {graph.points.map((point, index) => (
              <circle
                key={`${point.at}-${index}`}
                cx={point.x * WIDTH}
                cy={rowY(point.row, HEIGHT)}
                r={index === graph.points.length - 1 ? 5 : 3}
                className={index === graph.points.length - 1 ? "fill-accent" : "fill-ink-2"}
              />
            ))}
            <line x1={WIDTH} x2={WIDTH} y1={0} y2={HEIGHT} strokeDasharray="3 3" className="stroke-accent" />
            {graph.ticks.map((tick) => (
              <text key={tick.x} x={tick.x * WIDTH} y={HEIGHT + 14} textAnchor="middle" className="fill-ink-3 text-[10px]">
                {tick.label}
              </text>
            ))}
            <text x={WIDTH} y={HEIGHT + 14} textAnchor="middle" className="fill-ink-3 text-[10px]">
              Now
            </text>
          </svg>
        </div>
      </div>
    </section>
  );
}
```

Note: in the gap test above, the gap label element is the `<g data-gap>`; its `textContent` is the label.

- [ ] **Step 3: Rewrite `TaskTrack.tsx`**

Keep the existing pill, popover, portal, `useAnchoredPopover`, `TaskMarker` and `statusLabels` (retyped to `ChatTask["status"]`). Change the component to:

```tsx
import { ArrowDown01Icon, ArrowRight01Icon, ListTodoIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { currentPhase, taskCounts } from "@milagre/shared/chat-plan";
import type { ChatPlan, ChatTask } from "../../model";
import { PHASE_LABELS, PhaseGraph } from "./PhaseGraph";

function TaskRows({ tasks, depth, folded, toggle }: { tasks: ChatTask[]; depth: number; folded: Set<string>; toggle: (id: string) => void }) {
  return tasks.map((task, index) => {
    const parent = Boolean(task.children?.length);
    const open = parent && !folded.has(task.id);
    return (
      <li key={task.id} className="flex flex-col">
        <div
          data-task-row
          data-depth={depth}
          data-status={task.status}
          style={{ paddingLeft: 8 + depth * 18 }}
          className={`flex items-start gap-2 rounded-md py-1.5 pr-2 text-[13px] ${
            task.status === "in_progress" && !parent ? "bg-hover ring-1 ring-accent/50" : ""
          }`}
        >
          {parent ? (
            <button type="button" aria-expanded={open} aria-label={open ? `Collapse ${task.title}` : `Expand ${task.title}`} onClick={() => toggle(task.id)} className="mt-0.5 text-ink-3">
              <HugeiconsIcon icon={open ? ArrowDown01Icon : ArrowRight01Icon} size={12} aria-hidden />
            </button>
          ) : (
            <span aria-hidden className="w-3" />
          )}
          <span aria-hidden className="mt-0.5 min-w-4 rounded bg-hover px-1 text-center text-[11px] text-ink-3 tabular-nums">
            {index + 1}
          </span>
          <span className={`min-w-0 flex-1 break-words ${task.status === "completed" && !parent ? "text-ink-3" : ""}`}>
            <span className="sr-only">{statusLabels[task.status]}: </span>
            {task.status === "in_progress" && task.activeForm ? task.activeForm : task.title}
          </span>
          <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-ink-3">
            <TaskMarker status={task.status} />
          </span>
        </div>
        {open && (
          <ul>
            <TaskRows tasks={task.children!} depth={depth + 1} folded={folded} toggle={toggle} />
          </ul>
        )}
      </li>
    );
  });
}

/** The Chat's plan: a "done/total" pill that opens its task tree and phase graph above the composer. */
export function TaskTrack({ plan }: { plan?: ChatPlan }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const [opened, setOpened] = useState(false);
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const bounds = useAnchoredPopover({ opened, setOpened, trigger, panel, width: 380 });
  const empty = !plan || (!plan.tasks.length && !plan.phases.length);
  useEffect(() => {
    if (empty) setOpened(false);
  }, [empty]);
  if (empty) return null;
  const { done, total } = taskCounts(plan.tasks);
  const phase = currentPhase(plan);
  const label = total ? `${done}/${total}` : PHASE_LABELS[phase!];
  const toggle = (id: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <div className="flex" data-slot="task-track">
      <Tooltip label="Tasks" align="end">
        <button
          ref={trigger}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={opened}
          aria-controls={opened ? panelId : undefined}
          aria-label={total ? `Tasks, ${done} of ${total} done` : `Phase: ${PHASE_LABELS[phase!]}`}
          onClick={() => setOpened(!opened)}
          className="flex h-6 items-center gap-1.5 rounded-full border border-line bg-surface px-2 text-[11px] text-ink-2 hover:bg-hover focus-visible:outline-2"
        >
          <HugeiconsIcon icon={ListTodoIcon} size={12} aria-hidden />
          <span className="tabular-nums">{label}</span>
        </button>
      </Tooltip>
      {opened &&
        createPortal(
          <div
            ref={panel}
            id={panelId}
            role="dialog"
            aria-label="Tasks"
            aria-modal="false"
            tabIndex={-1}
            data-slot="task-popover"
            style={bounds}
            className="fixed z-50 flex flex-col gap-2 overflow-hidden rounded-[10px] border border-line bg-surface p-1 text-ink shadow-raised focus:outline-none"
          >
            {plan.tasks.length > 0 && (
              <section aria-label="Tasks" className="flex min-h-0 flex-col gap-1">
                <h3 className="flex items-center justify-between px-2 pt-1 text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase">
                  <span className="flex items-center gap-2">
                    <span aria-hidden className="h-px w-3 bg-accent" />
                    Tasks
                  </span>
                  <span className="tabular-nums">{total}</span>
                </h3>
                <ScrollArea as="ul">
                  <TaskRows tasks={plan.tasks} depth={0} folded={folded} toggle={toggle} />
                </ScrollArea>
              </section>
            )}
            <PhaseGraph plan={plan} />
          </div>,
          document.body,
        )}
    </div>
  );
}
```

Keep the existing `react`, `react-dom`, `HugeiconsIcon`, `SpinnerRing`, `ScrollArea`, `Tooltip` and `useAnchoredPopover` imports; drop the `AgentTask` import.

- [ ] **Step 4: Pass `plan` through**

- `ChatComposer.tsx`: rename the prop `tasks?: AgentTask[]` to `plan?: ChatPlan` (type import from `../model`), destructure `plan`, and mount `<TaskTrack key={`tasks-${messages[0]?.session_id ?? "new"}`} plan={plan} />`. Remove the `AgentTask` import if unused.
- `App.tsx:2356`: `plan={selectedSession?.plan}` replaces `tasks={run?.tasks}`.
- `LinkWorkspace.tsx:540`: `plan={session?.plan}` replaces `tasks={run?.tasks}`.

- [ ] **Step 5: Run the checks**

Run: `node scripts/test-task-track.cjs && npm run typecheck --workspace milagre && npm run test:ui --workspace milagre`
Expected: PASS. With `MILAGRE_SCREENSHOT_DIR=/tmp/task-track node scripts/test-task-track.cjs`, open `/tmp/task-track/task-popover-dark.png` and `-light.png` and compare against the reference screenshot: tree indented, current row highlighted, graph with a `3h` gap chip and the Review row highlighted.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/app/src/components/agents/TaskTrack.tsx apps/desktop/app/src/components/agents/PhaseGraph.tsx apps/desktop/app/src/components/ChatComposer.tsx apps/desktop/app/src/App.tsx apps/desktop/app/src/components/LinkWorkspace.tsx scripts/test-task-track.cjs
git commit -m "feat(desktop): show the Chat plan as a task tree with a phase graph"
```

---

### Task 6: Phone pill and plan sheet

**Files:**
- Create: `apps/mobile/src/plan-view.tsx`, `apps/mobile/src/app/plan-sheet.tsx`
- Modify: `apps/mobile/src/app/_layout.tsx:88` (register the route), `apps/mobile/src/app/chat.tsx:~1513` (pill), `apps/mobile/src/chat-reply.tsx:312-321` (remove inline card)
- Test: `apps/mobile/src/plan-label.test.ts`

**Interfaces:**
- Consumes: `taskCounts`, `currentPhase`, `PHASES` from `@milagre/shared/chat-plan`; `phaseGraph`, `phaseGraphPath`, `rowY` from `@milagre/shared/phase-graph`; `ChatPlan` from `@milagre/shared/model`; `Icon` from `./icons`; `useStyles`, `useTheme` as in `context-sheet.tsx`.
- Produces: `PlanTree({ plan })`, `PlanPhaseGraph({ plan, width })`, `planPillLabel(plan): string | null`, route `/plan-sheet?id=<sessionId>`.

- [ ] **Step 1: Write the failing test** (pure label logic)

Create `apps/mobile/src/plan-label.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { planPillLabel } from "./plan-label.ts";

test("pill shows leaf counts, the phase when there are no tasks, and nothing without a plan", () => {
  assert.equal(planPillLabel(undefined), null);
  assert.equal(planPillLabel({ source: "milagre", tasks: [], phases: [], updatedAt: 0 }), null);
  assert.equal(
    planPillLabel({ source: "milagre", tasks: [{ id: "1", title: "A", status: "pending", children: [{ id: "1.1", title: "a", status: "completed" }, { id: "1.2", title: "b", status: "pending" }] }], phases: [], updatedAt: 0 }),
    "1/2",
  );
  assert.equal(planPillLabel({ source: "milagre", tasks: [], phases: [{ phase: "review", at: 1 }], updatedAt: 0 }), "Review");
});
```

Run: `cd apps/mobile && node --test src/plan-label.test.ts`
Expected: FAIL (`Cannot find module './plan-label.ts'`).

- [ ] **Step 2: Implement `plan-label.ts` and `plan-view.tsx`**

`apps/mobile/src/plan-label.ts` (kept free of React Native imports so `node --test` can load it):

```ts
import { currentPhase, taskCounts } from "@milagre/shared/chat-plan";
import type { ChatPhase, ChatPlan } from "@milagre/shared/model";

export const PHASE_LABELS: Record<ChatPhase, string> = {
  start: "Start", plan: "Plan", build: "Build", test: "Test", review: "Review", merge: "Merge", release: "Release", done: "Done",
};

/** The composer pill's text: done/total over leaf tasks, else the current phase; null hides the pill. */
export function planPillLabel(plan: ChatPlan | undefined): string | null {
  if (!plan) return null;
  const { done, total } = taskCounts(plan.tasks);
  if (total) return `${done}/${total}`;
  const phase = currentPhase(plan);
  return phase ? PHASE_LABELS[phase] : null;
}
```

`apps/mobile/src/plan-view.tsx`:

```tsx
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from "react-native-svg";
import { ArrowDown01Icon, ArrowRight01Icon, CheckmarkCircle02Icon, CircleIcon, EyeIcon, Flag01Icon, GitMergeIcon, Rocket01Icon, Target02Icon, TestTube01Icon, Wrench01Icon } from "@hugeicons/core-free-icons";
import { PHASES } from "@milagre/shared/chat-plan";
import { phaseGraph, phaseGraphPath, rowY } from "@milagre/shared/phase-graph";
import type { ChatPlan, ChatTask } from "@milagre/shared/model";
import { Icon } from "./icons";
import { PHASE_LABELS } from "./plan-label";
import { useTheme } from "./theme";
import { useStyles } from "./ui";

const PHASE_ICONS = { start: Flag01Icon, plan: Target02Icon, build: Wrench01Icon, test: TestTube01Icon, review: EyeIcon, merge: GitMergeIcon, release: Rocket01Icon, done: CheckmarkCircle02Icon } as const;

function Rows({ tasks, depth, folded, toggle }: { tasks: ChatTask[]; depth: number; folded: Set<string>; toggle: (id: string) => void }) {
  const { colors } = useTheme();
  const styles = useStyles();
  return tasks.map((task, index) => {
    const parent = Boolean(task.children?.length);
    const open = parent && !folded.has(task.id);
    const current = task.status === "in_progress" && !parent;
    return (
      <View key={task.id}>
        <Pressable
          disabled={!parent}
          onPress={() => toggle(task.id)}
          accessibilityRole={parent ? "button" : undefined}
          accessibilityState={parent ? { expanded: open } : undefined}
          style={[styles.row, { flexWrap: "nowrap", gap: 8, paddingVertical: 7, paddingLeft: 4 + depth * 18, paddingRight: 6, borderRadius: 8 }, current && { backgroundColor: colors.hover, borderWidth: 1, borderColor: colors.accent }]}
        >
          <View style={{ width: 12 }}>{parent && <Icon icon={open ? ArrowDown01Icon : ArrowRight01Icon} tone="ink3" size={12} />}</View>
          <Text style={[styles.muted, { fontVariant: ["tabular-nums"], fontSize: 12 }]}>{index + 1}</Text>
          <Text style={{ flex: 1, color: task.status === "completed" && !parent ? colors.ink3 : colors.ink, fontSize: 15 }}>
            {current && task.activeForm ? task.activeForm : task.title}
          </Text>
          <Icon icon={task.status === "completed" ? CheckmarkCircle02Icon : CircleIcon} tone={task.status === "completed" ? "green" : "ink3"} size={16} />
        </Pressable>
        {open && <Rows tasks={task.children!} depth={depth + 1} folded={folded} toggle={toggle} />}
      </View>
    );
  });
}

export function PlanTree({ plan }: { plan: ChatPlan }) {
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) => setFolded((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  return <View>{<Rows tasks={plan.tasks} depth={0} folded={folded} toggle={toggle} />}</View>;
}

const HEIGHT = 168;

export function PlanPhaseGraph({ plan, width }: { plan: ChatPlan; width: number }) {
  const { colors } = useTheme();
  const graph = phaseGraph(plan.phases, Date.now());
  if (!graph.points.length || width <= 0) return null;
  const path = phaseGraphPath(graph.points, width, HEIGHT);
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      <View style={{ height: HEIGHT, justifyContent: "space-between", flexDirection: "column-reverse" }}>
        {PHASES.map((phase) => (
          <View key={phase} style={{ flexDirection: "row", alignItems: "center", gap: 4, height: 20, paddingHorizontal: 4, borderRadius: 4, backgroundColor: graph.current === phase ? colors.hover : "transparent" }}>
            <Icon icon={PHASE_ICONS[phase]} tone={graph.current === phase ? "ink" : "ink3"} size={11} />
            <Text style={{ fontSize: 11, color: graph.current === phase ? colors.ink : colors.ink3 }}>{PHASE_LABELS[phase]}</Text>
          </View>
        ))}
      </View>
      <Svg width={width} height={HEIGHT + 18} accessibilityLabel={`Current phase: ${PHASE_LABELS[graph.current!]}`}>
        {graph.gaps.map((gap) => (
          <G key={`${gap.x0}-${gap.x1}`}>
            <Rect x={((gap.x0 + gap.x1) / 2) * width - 12} y={HEIGHT / 2 - 8} width={24} height={16} rx={4} fill={colors.hover} />
            <SvgText x={((gap.x0 + gap.x1) / 2) * width} y={HEIGHT / 2 + 4} textAnchor="middle" fontSize={10} fill={colors.ink2}>
              {gap.label}
            </SvgText>
          </G>
        ))}
        <Path d={path} fill="none" stroke={colors.accent} strokeWidth={2} strokeLinecap="round" />
        {graph.points.map((point, index) => (
          <Circle key={`${point.at}-${index}`} cx={point.x * width} cy={rowY(point.row, HEIGHT)} r={index === graph.points.length - 1 ? 5 : 3} fill={index === graph.points.length - 1 ? colors.accent : colors.ink2} />
        ))}
        <Line x1={width} x2={width} y1={0} y2={HEIGHT} stroke={colors.accent} strokeDasharray="3 3" />
        {graph.ticks.map((tick) => (
          <SvgText key={tick.x} x={tick.x * width} y={HEIGHT + 14} textAnchor="middle" fontSize={10} fill={colors.ink3}>
            {tick.label}
          </SvgText>
        ))}
        <SvgText x={width - 2} y={HEIGHT + 14} textAnchor="end" fontSize={10} fill={colors.ink3}>
          Now
        </SvgText>
      </Svg>
    </View>
  );
}
```

`colors.hover`, `colors.accent`, `colors.ink`, `colors.ink2` and `colors.ink3` are existing phone tokens (`apps/mobile/src/theme.ts`). Read `apps/mobile/src/icons.tsx` for `Icon`'s `tone` values; if `"ink"` is not one, pass the ink colour the way other call sites do.

- [ ] **Step 3: Add the sheet route**

`apps/mobile/src/app/plan-sheet.tsx`, following `context-sheet.tsx`:

```tsx
import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useSession } from "../session";
import { useStyles } from "../ui";
import { PlanPhaseGraph, PlanTree } from "../plan-view";
import { planPillLabel } from "../plan-label";

/** Desktop's Tasks popover as a sheet: the Chat's task tree and phase graph, live as the agent works. */
export default function PlanSheet() {
  const styles = useStyles();
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const session = useSession();
  const plan = session.snapshot?.project?.state.sessions[Number(id)]?.plan;
  const [graphWidth, setGraphWidth] = useState(0);
  const missing = !planPillLabel(plan);
  useEffect(() => {
    if (missing) router.back();
  }, [missing]);
  if (!plan || missing) return null;
  return (
    <ScrollView contentContainerStyle={{ paddingTop: 28, paddingHorizontal: 20, paddingBottom: Math.max(insets.bottom, 16) + 4, gap: 20 }}>
      {plan.tasks.length > 0 && (
        <View style={{ gap: 6 }}>
          <Text accessibilityRole="header" style={styles.subtitle}>Tasks</Text>
          <PlanTree plan={plan} />
        </View>
      )}
      {plan.phases.length > 0 && (
        <View style={{ gap: 6 }} onLayout={(event) => setGraphWidth(event.nativeEvent.layout.width - 90)}>
          <Text accessibilityRole="header" style={styles.subtitle}>Phase graph</Text>
          <PlanPhaseGraph plan={plan} width={graphWidth} />
        </View>
      )}
    </ScrollView>
  );
}
```

In `_layout.tsx`, after the `context-sheet` screen:

```tsx
                      <Stack.Screen name="plan-sheet" options={{ ...sheet, sheetAllowedDetents: [0.6, 1] }} />
```

- [ ] **Step 4: Add the pill and remove the inline card**

In `chat.tsx`, before the `ContextRing` block (inside the same row, after `<View style={{ flex: 1 }} />`):

```tsx
                    {params.id && planPillLabel(chat?.plan) && (
                      <PillButton
                        title={planPillLabel(chat?.plan)!}
                        icon={ListTodoIcon}
                        secondary
                        onPress={() => router.push({ pathname: "/plan-sheet", params: { id: params.id } })}
                      />
                    )}
```

Import `planPillLabel` from `../plan-label`, `ListTodoIcon` from `@hugeicons/core-free-icons`, and `PillButton` from `../ui` if `chat.tsx` doesn't already. `PillButton` takes `{ title, onPress, icon?, secondary? }` (`apps/mobile/src/ui.tsx:158`). If it renders too tall for the composer row next to `PermissionChip`, match `PermissionChip`'s chip instead.

In `chat-reply.tsx`, delete the `{run?.tasks?.length ? ( … ) : null}` block (lines 312-321) and any icon imports it alone used.

- [ ] **Step 5: Run checks**

Run: `cd apps/mobile && node --test src/*.test.ts && npx tsc --noEmit && npx oxlint src`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/plan-label.ts apps/mobile/src/plan-label.test.ts apps/mobile/src/plan-view.tsx apps/mobile/src/app/plan-sheet.tsx apps/mobile/src/app/_layout.tsx apps/mobile/src/app/chat.tsx apps/mobile/src/chat-reply.tsx
git commit -m "feat(mobile): open the Chat plan from a Tasks pill as a sheet"
```

---

### Task 7: End-to-end verification, glossary and PR

**Files:**
- Modify: `GLOSSARY.md`

- [ ] **Step 1: Glossary**

Add, in alphabetical position:

```markdown
- **Phase:** where a Chat's work is (Start, Plan, Build, Test, Review, Merge, Release, Done), set by the agent with `phase_set` and drawn on the Tasks pill's phase graph.
- **Task list:** a Chat's tree of tasks, at most three levels deep, written by the agent with Milagre's `tasks_set` and `task_update`. Saved with the Chat; a provider's own todo list fills it until Milagre's tools take over.
```

- [ ] **Step 2: Full suites**

Run: `npm run typecheck && npm run typecheck:mobile && npm run test:unit`
Expected: PASS.

- [ ] **Step 3: Real provider runs**

Start a dev Milagre on its own Vite/Electron ports and profile (never touch the running Milagre; see `docs/development.md`). In one Claude, one Codex and one Antigravity Chat, send: "Plan adding a wishlist page in three steps with subtasks using your task tools, move to the build phase, then mark the first subtask done. Don't edit files." Confirm in each: the pill shows `1/N`, the popover tree has the agent's items, the graph shows Plan then Build. Then restart the dev app and confirm the plan is still there.

- [ ] **Step 4: Phone check**

On a slim iOS simulator (`simslim list`; see `~/.claude/rules/simulators.md`) with the Milagre dev build pointed at the dev host, open the same Claude Chat: pill in the composer row, sheet shows the tree and graph. Screenshot both.

- [ ] **Step 5: Push screenshots and open the PR**

Commit the desktop popover (dark, light, narrow) and phone sheet screenshots to the orphan `screenshots` branch, not this branch. Push `milagre/chat-task-tools`, then open the PR with `gh pr create` titled "feat: Milagre task tools and phase graph for every provider", body listing: the env fix commit, the four tools, persistence, native fallback, desktop and phone UI, verification done (suites, three providers, restart, phone) and the screenshot links. No Claude attribution lines. After merge, publish the phone OTA.
