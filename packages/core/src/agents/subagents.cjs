// Provider-owned children have their own lifecycle; a launch tool finishing is not a child finishing.
const { capOutput, claudeStep, codexStep } = require("./steps.cjs");
const { createHash } = require("node:crypto");
const { subagentActive: active } = require("@milagre/shared/agent-runs");
const { addProgress } = require("@milagre/shared/subagent-glance");
const { applyToolResult, applyToolUse, codexPlanTasks } = require("./tasks.cjs");
function update(state, id, patch, entry) {
  state.subagents ??= new Map();
  const previous = state.subagents.get(id);
  const row = entry?.text ? { ...entry, text: capOutput(entry.text) } : null;
  const previousRow = row && previous?.transcript.find((item) => item.id === row.id);
  const sameRow = !row || (previousRow?.kind === row.kind && previousRow?.text === row.text);
  if (previous && sameRow && Object.entries(patch).every(([key, value]) => previous[key] === value)) return { type: "subagent-update", agent: previous };
  const time = Date.now();
  const agent = { id, title: "Subagent", status: "running", startedAt: time, transcript: [], ...previous, ...patch, updatedAt: time };
  if (row && !sameRow) {
    agent.transcript = [...agent.transcript.filter((item) => item.id !== row.id), row].slice(-100);
    // The transcript keeps its last 100 entries and a client only their tail, so the totals are counted here, once each.
    if (!previousRow) agent.progress = addProgress(agent.progress, row);
  }
  if (!active(agent)) agent.endedAt ??= time;
  else delete agent.endedAt;
  state.subagents.set(id, agent);
  return { type: "subagent-update", agent };
}
const textContent = (content) =>
  typeof content === "string"
    ? content
    : (content ?? [])
        .map((b) => b.text ?? b.content ?? "")
        .filter((v) => typeof v === "string")
        .join("\n");
// Keep a small, deduplicated history. Polling the same provider item must not replay a message.
function communicate(state, ownerId, id, fromId, toId, text) {
  const agent = state.subagents?.get(ownerId);
  if (!agent || !text) return [];
  // Retain seen IDs beyond the visible history cap so polling older items cannot replay them.
  state.subagentCommunicationIds ??= new Set();
  if (state.subagentCommunicationIds.has(id) || agent.communications?.some((entry) => entry.id === id)) return [];
  state.subagentCommunicationIds.add(id);
  const communication = { id, fromId, toId, text: capOutput(text), at: Date.now() };
  return [update(state, ownerId, { communications: [...(agent.communications ?? []), communication].slice(-20) })];
}
// A subagent's own to-do list, as the chat's (tasks.cjs), kept per subagent. TaskCreate and TaskList wait for their
// result, which holds the ids, so those calls are held until it comes.
const TASK_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);
function subagentTasksUse(state, agentId, block) {
  state.subagentTasks ??= new Map();
  if (!state.subagentTasks.has(agentId)) state.subagentTasks.set(agentId, new Map());
  if (["TaskCreate", "TaskList"].includes(block.name)) {
    state.subagentTaskCalls ??= new Map();
    state.subagentTaskCalls.set(block.id, { agentId, call: block });
  } else {
    // Their results stay out of the transcript as the calls do.
    state.subagentTaskResults ??= new Set();
    state.subagentTaskResults.add(block.id);
  }
  const tasks = applyToolUse(state.subagentTasks.get(agentId), block.name, block.input);
  return tasks ? [update(state, agentId, { tasks })] : [];
}
function subagentTasksResult(state, block, structured) {
  const held = state.subagentTaskCalls?.get(block.tool_use_id);
  if (!held) return [];
  state.subagentTaskCalls.delete(block.tool_use_id);
  const tasks = applyToolResult(state.subagentTasks.get(held.agentId), held.call, block, structured);
  return tasks ? [update(state, held.agentId, { tasks })] : [];
}
function claudeRecipient(state, recipient) {
  const id = state.subagents?.has(recipient) ? recipient : (state.taskAgents?.get(recipient) ?? state.subagentNames?.get(recipient));
  return state.subagents?.has(id) ? id : undefined;
}
function claudeSubagents(message, state) {
  const events = [];
  const parent = message.parent_tool_use_id;
  const content = message.message?.content;
  if (message.type === "assistant" && Array.isArray(content)) {
    for (const [index, block] of content.entries()) {
      if (block.type === "tool_use" && ["Agent", "Task"].includes(block.name)) {
        // A background Agent of the chat's own returns at once; its result wakes the chat later, with a turn of its own.
        const background = !parent && Boolean(block.input?.run_in_background);
        if (!parent && !background) {
          state.foregroundChildren ??= new Set();
          state.foregroundChildren.add(block.id);
          events.push({ type: "subagents-waiting", waiting: true });
        }
        events.push(
          update(state, block.id, {
            title: block.input?.description || "Subagent",
            prompt: block.input?.prompt,
            ...(parent ? { parentId: parent } : {}),
            ...(background ? { background: true } : {}),
          }),
        );
        if (block.input?.name) {
          state.subagentNames ??= new Map();
          state.subagentNames.set(block.input.name, block.id);
        }
        events.push(...communicate(state, block.id, `task:${block.id}`, parent ?? null, block.id, block.input?.prompt));
      }
      if (block.type === "tool_use" && block.name === "SendMessage" && (!parent || state.subagents?.has(parent))) {
        const input = block.input ?? {};
        const text = input.message ?? input.content;
        const toId = claudeRecipient(state, input.to ?? input.recipient);
        if ((!input.type || input.type === "message") && toId && typeof text === "string" && text) {
          state.subagentMessages ??= new Map();
          state.subagentMessages.set(block.id, { fromId: parent ?? null, toId, text });
        }
      }
      // A subagent's to-do list calls change its list, not its transcript: the panel shows the list itself.
      if (parent && state.subagents?.has(parent) && block.type === "tool_use" && TASK_TOOLS.has(block.name)) {
        events.push(...subagentTasksUse(state, parent, block));
        continue;
      }
      if (parent && state.subagents?.has(parent)) {
        const step = block.type === "tool_use" ? claudeStep(block.id, block.name, block.input) : undefined;
        const text = block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : (step?.title ?? "");
        events.push(
          update(
            state,
            parent,
            { latestActivity: step ? text : "Responding" },
            {
              id: `${message.uuid ?? message.message.id}:${block.id ?? index}:${block.type}`,
              kind: step ? "tool" : "message",
              text,
              ...(step ? { tool: step.kind } : {}),
            },
          ),
        );
      }
    }
  }
  if (message.type === "user" && Array.isArray(content)) {
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const sent = state.subagentMessages?.get(block.tool_use_id);
      if (sent) {
        state.subagentMessages.delete(block.tool_use_id);
        if (!block.is_error && message.tool_use_result?.success !== false)
          events.push(...communicate(state, sent.toId, `send:${block.tool_use_id}`, sent.fromId, sent.toId, sent.text));
      }
      if (state.subagents?.has(block.tool_use_id)) {
        if (!parent) {
          state.foregroundChildren?.delete(block.tool_use_id);
          events.push({ type: "subagents-waiting", waiting: Boolean(state.foregroundChildren?.size) });
        }
        if (message.tool_use_result?.status !== "async_launched") {
          events.push(
            update(
              state,
              block.tool_use_id,
              { status: block.is_error ? "failed" : "completed", latestActivity: "Finished" },
              { id: "result", kind: "message", text: textContent(block.content) },
            ),
          );
          events.push(
            ...communicate(
              state,
              block.tool_use_id,
              `result:${block.tool_use_id}`,
              block.tool_use_id,
              state.subagents.get(block.tool_use_id).parentId ?? null,
              textContent(block.content),
            ),
          );
        }
      }
      if (parent && state.subagents?.has(parent)) {
        if (state.subagentTaskCalls?.has(block.tool_use_id)) {
          // tool_use_result belongs to the message, so it can only be matched to a lone result.
          const results = content.filter((item) => item?.type === "tool_result");
          events.push(...subagentTasksResult(state, block, results.length === 1 ? message.tool_use_result : undefined));
        } else if (!state.subagentTaskResults?.delete(block.tool_use_id))
          events.push(update(state, parent, {}, { id: `result:${block.tool_use_id}`, kind: "tool", text: textContent(block.content) }));
      }
    }
  }
  if (message.type === "system" && message.subtype?.startsWith("task_")) {
    state.taskAgents ??= new Map();
    let id = state.taskAgents.get(message.task_id) ?? message.tool_use_id;
    const known = id && state.subagents?.has(id);
    if (!known && !(message.subtype === "task_started" && (message.task_type === "local_agent" || message.subagent_type))) return events;
    id ??= message.task_id;
    state.taskAgents.set(message.task_id, id);
    const patch = { ...(message.description ? { title: message.description } : {}), ...(message.prompt ? { prompt: message.prompt } : {}) };
    if (message.subtype === "task_started") patch.status = "running";
    if (message.subtype === "task_progress") patch.latestActivity = message.summary || message.last_tool_name || message.description;
    if (message.subtype === "task_notification") {
      patch.status = { completed: "completed", failed: "failed", stopped: "cancelled" }[message.status] ?? "unknown";
      patch.latestActivity = message.summary;
    }
    if (message.subtype === "task_updated") {
      if (message.patch.status)
        patch.status =
          { pending: "initializing", running: "running", completed: "completed", failed: "failed", killed: "cancelled", paused: "waiting" }[
            message.patch.status
          ] ?? "unknown";
      if (message.patch.description) patch.title = message.patch.description;
    }
    events.push(update(state, id, patch, message.summary ? { id: "summary", kind: "message", text: message.summary } : undefined));
    if (message.subtype === "task_notification")
      events.push(
        ...communicate(state, id, `notification:${message.task_id}:${message.status}`, id, state.subagents.get(id).parentId ?? null, message.summary),
      );
  }
  return events;
}
const codexStatus = (status) =>
  ({
    pendingInit: "initializing",
    running: "running",
    interrupted: "cancelled",
    completed: "completed",
    errored: "failed",
    shutdown: "cancelled",
    notFound: "unknown",
  })[status] ?? "unknown";
function codexSubagents(method, params, state) {
  const item = params.item;
  const foreign = params.threadId && state.threadId && params.threadId !== state.threadId;
  if (foreign && !state.subagents?.has(params.threadId)) return [];
  if (!foreign && state.turnId && params.turnId && params.turnId !== state.turnId) return [];
  const events = [];
  if (item?.type === "subAgentActivity" && ["item/started", "item/completed"].includes(method)) {
    const target = item.agentThreadId;
    const sender = foreign ? params.threadId : null;
    const id = `activity:${params.threadId ?? state.threadId}:${item.id}:${item.kind}`;
    state.subagentActivityIds ??= new Set();
    if (state.subagentActivityIds.has(id)) return [];
    if (item.kind === "interacted") {
      const toId = target === state.threadId ? null : target;
      const owner = toId ?? sender;
      if (!state.subagents?.has(owner)) return [];
      state.subagentActivityIds.add(id);
      if (toId) {
        // An interaction may wake a completed child, but only its next thread read can prove it.
        state.subagentRecheckUntil ??= new Map();
        state.subagentRecheckUntil.set(toId, Date.now() + 10_000);
      }
      events.push(...communicate(state, owner, id, sender, toId, "Message sent"));
    } else if (target && target !== state.threadId) {
      state.subagentActivityIds.add(id);
      const status = { started: "running", interrupted: "cancelled", completed: "completed" }[item.kind];
      events.push(
        update(state, target, {
          title: item.agentPath || "Subagent",
          status: status ?? "unknown",
          ...(foreign && item.kind === "started" ? { parentId: params.threadId } : {}),
        }),
      );
    }
  }
  if (foreign && method === "thread/status/changed") {
    const status =
      params.status?.type === "active"
        ? params.status.activeFlags?.some((flag) => ["waitingOnApproval", "waitingOnUserInput"].includes(flag))
          ? "waiting"
          : "running"
        : { systemError: "failed", notLoaded: "unknown" }[params.status?.type];
    // Unloading describes the provider process, not a change to its recorded turn outcome.
    const unloadedTerminal = params.status?.type === "notLoaded" && ["completed", "failed", "cancelled"].includes(state.subagents.get(params.threadId).status);
    if (status && !unloadedTerminal) events.push(update(state, params.threadId, { status }));
  }
  if (item?.type === "collabAgentToolCall" && ["item/started", "item/completed"].includes(method)) {
    for (const id of item.receiverThreadIds ?? []) {
      const sender = foreign ? params.threadId : null;
      if (id === state.threadId) {
        if (foreign && method === "item/completed" && item.status !== "failed" && item.tool === "sendInput")
          events.push(...communicate(state, sender, `${item.id}:${id}`, sender, null, item.prompt));
        continue;
      }
      const status = item.agentsStates?.[id];
      if (!state.subagents?.has(id) && !status && item.tool !== "spawnAgent") continue;
      const patch = {
        ...(foreign && item.tool === "spawnAgent" ? { parentId: params.threadId } : {}),
        ...(item.tool === "spawnAgent" ? { title: item.prompt?.split("\n")[0].slice(0, 120) || "Subagent", prompt: item.prompt } : {}),
        ...(status ? { status: codexStatus(status.status) } : {}),
      };
      events.push(update(state, id, patch, status?.message ? { id: "result", kind: "message", text: status.message } : undefined));
      if (method === "item/completed" && item.status !== "failed") {
        if (["spawnAgent", "sendInput"].includes(item.tool)) events.push(...communicate(state, id, `${item.id}:${id}`, sender, id, item.prompt));
        if (status?.message) {
          // agentsStates is a snapshot: another wait call can report the same reply again.
          const resultId = createHash("sha256")
            .update(JSON.stringify([id, sender, status.status, status.message]))
            .digest("hex");
          events.push(...communicate(state, id, `reply:${resultId}`, id, sender, status.message));
        }
      }
    }
    if (!foreign && item.tool === "wait") events.push({ type: "subagents-waiting", waiting: method === "item/started" });
  }
  if (foreign && method === "item/started" && item) {
    const activity = codexStep(item)?.title ?? (item.type === "reasoning" ? "Thinking" : item.type === "agentMessage" ? "Responding" : undefined);
    if (activity) events.push(update(state, params.threadId, { latestActivity: activity }));
  }
  if (foreign && method === "item/completed" && item) {
    const step = codexStep(item);
    const text =
      item.type === "agentMessage"
        ? item.text
        : item.type === "reasoning"
          ? (item.summary ?? []).join("\n")
          : step
            ? [step.title, item.aggregatedOutput].filter(Boolean).join("\n")
            : "";
    if (text)
      events.push(
        update(
          state,
          params.threadId,
          { latestActivity: step?.title || "Responding" },
          { id: item.id, kind: step ? "tool" : "message", text, ...(step ? { tool: step.kind } : {}) },
        ),
      );
  }
  if (foreign && method === "turn/plan/updated") {
    const tasks = codexPlanTasks(params.plan);
    if (tasks) events.push(update(state, params.threadId, { tasks }));
  }
  if (foreign && method === "turn/started") events.push(update(state, params.threadId, { status: "running" }));
  if (foreign && method === "turn/completed")
    events.push(
      update(state, params.threadId, {
        status: params.turn?.status === "failed" ? "failed" : params.turn?.status === "interrupted" ? "cancelled" : "completed",
      }),
    );
  return events;
}
function settleSubagents(state, status) {
  return [...(state.subagents?.values() ?? [])].filter(active).map((agent) => update(state, agent.id, { status }));
}
module.exports = { claudeSubagents, codexSubagents, settleSubagents, active, update, communicate };
