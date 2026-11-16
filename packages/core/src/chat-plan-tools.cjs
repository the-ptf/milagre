const { z } = require("zod");
const { PHASES, currentPhase, setPhase, setTasks, updateTask } = require("@milagre/shared/chat-plan");

const PLAN_TOOL_NAMES = Object.freeze(["tasks_set", "task_update", "tasks_read", "phase_set"]);
const [TASKS_SET, TASK_UPDATE, TASKS_READ, PHASE_SET] = PLAN_TOOL_NAMES;
const MARKS = { completed: "[x]", in_progress: "[~]", pending: "[ ]" };
const status = z.enum(["pending", "in_progress", "completed"]);
const base = {
  id: z.string().max(20).optional().describe("Keep an existing task's id to keep its status; omit for a new task."),
  title: z.string().min(1).max(200),
  activeForm: z.string().max(200).optional().describe("Shown while in progress, e.g. 'Saving wishlist changes'."),
  status: status.optional(),
};
const leaf = z.strictObject(base);
const level2 = z.object({ ...base, children: z.array(leaf).optional() });
const level1 = z.object({ ...base, children: z.array(level2).optional() });

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

function createChatPlanTools({ read, update, now = Date.now }) {
  const change = (chatId, apply) => update(chatId, (plan) => apply(plan, now()));
  function definitions(chatId) {
    return [
      {
        name: TASKS_SET,
        description:
          "Write this Chat's task list, shown in its Tasks pill on desktop and phone. Send the whole tree, at most 3 levels deep. Keep a task's id to keep its status; new tasks get ids from Milagre. Returns the list with ids.",
        input: { tasks: z.array(level1).min(1).max(100) },
        readOnly: false,
        run: async ({ tasks }) => formatPlan(await change(chatId, (plan, at) => setTasks(plan, tasks, at))),
      },
      {
        name: TASK_UPDATE,
        description:
          "Change one task in this Chat's task list: mark a subtask in_progress when you start it and completed when it is done, or rename it. A parent's status follows its subtasks.",
        input: {
          id: z.string().min(1).max(20),
          status: status.optional(),
          title: z.string().min(1).max(200).optional(),
          activeForm: z.string().max(200).optional(),
        },
        readOnly: false,
        run: async (input) => formatPlan(await change(chatId, (plan, at) => updateTask(plan, input, at))),
      },
      {
        name: TASKS_READ,
        description: "Read this Chat's task list with ids, and its current phase.",
        input: {},
        readOnly: true,
        run: async () => formatPlan(await read(chatId)),
      },
      {
        name: PHASE_SET,
        description: `Move this Chat to a work phase, shown on its phase graph: ${PHASES.join(", ")}. Call it when the work moves on, not for every step.`,
        input: { phase: z.enum(PHASES) },
        readOnly: false,
        run: async ({ phase }) => formatPlan(await change(chatId, (plan, at) => setPhase(plan, phase, at))),
      },
    ];
  }
  return { definitions };
}

module.exports = { PLAN_TOOL_NAMES, createChatPlanTools, formatPlan };
