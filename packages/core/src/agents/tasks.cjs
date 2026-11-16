// (one change per call), so those are folded into a per-session Map, in creation order. Codex sends the whole plan.

const STATUSES = new Set(["pending", "in_progress", "completed"]);

const text = (value) => (typeof value === "string" ? value.trim() : "");
const status = (value) => (STATUSES.has(value) ? value : "pending");

function task(id, content, state, activeForm) {
  const form = text(activeForm);
  return { id: String(id), content, ...(form ? { activeForm: form } : {}), status: status(state) };
}

function replace(map, list) {
  map.clear();
  for (const item of list) map.set(item.id, item);
  return [...map.values()];
}

function todoWriteTasks(input) {
  if (!Array.isArray(input?.todos)) return null;
  return input.todos.flatMap((todo, index) => (text(todo?.content) ? [task(index, text(todo.content), todo.status, todo.activeForm)] : []));
}

// Codex turn/plan/updated plan [{ step, status: "pending" | "inProgress" | "completed" }].
function codexPlanTasks(plan) {
  if (!Array.isArray(plan)) return null;
  return plan.flatMap((item, index) => (text(item?.step) ? [task(index, text(item.step), item.status === "inProgress" ? "in_progress" : item.status)] : []));
}

// ACP plan entries [{ content, status: "pending" | "in_progress" | "completed", priority }]: the whole plan each time.
function acpPlanTasks(entries) {
  if (!Array.isArray(entries)) return null;
  return entries.flatMap((entry, index) => (text(entry?.content) ? [task(index, text(entry.content), entry.status)] : []));
}

function createdId(structured, block) {
  if (structured?.task?.id !== undefined) return String(structured.task.id);
  const body = typeof block?.content === "string" ? block.content : (block?.content ?? []).map((part) => part?.text ?? "").join("\n");
  return /#(\w+)/.exec(body)?.[1];
}

function applyToolUse(map, name, input) {
  if (name === "TodoWrite") {
    const list = todoWriteTasks(input);
    return list ? replace(map, list) : null;
  }
  if (name !== "TaskUpdate") return null;
  const id = String(input?.taskId ?? "");
  const current = map.get(id);
  if (!current) return null;
  if (input.status === "deleted") {
    map.delete(id);
    return [...map.values()];
  }
  const content = text(input.subject) || current.content;
  const form = text(input.activeForm) || current.activeForm;
  map.set(id, task(id, content, input.status ?? current.status, form));
  return [...map.values()];
}

function applyToolResult(map, call, block, structured) {
  if (block?.is_error) return null;
  if (call.name === "TaskList") {
    if (!Array.isArray(structured?.tasks)) return null;
    return replace(
      map,
      structured.tasks.flatMap((item) => (text(item?.subject) ? [task(item.id, text(item.subject), item.status, map.get(String(item.id))?.activeForm)] : [])),
    );
  }
  if (call.name !== "TaskCreate") return null;
  const subject = text(call.input?.subject);
  if (!subject) return null;
  const id = createdId(structured, block) ?? `task-${map.size + 1}`;
  map.set(id, task(id, subject, "pending", call.input.activeForm));
  return [...map.values()];
}

module.exports = { acpPlanTasks, applyToolResult, applyToolUse, codexPlanTasks, todoWriteTasks };
