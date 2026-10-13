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
    const status = done === children.length ? "completed" : done > 0 || children.some((child) => child.status === "in_progress") ? "in_progress" : "pending";
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
