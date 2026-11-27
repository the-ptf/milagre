import { isTurnEnd, subagentActive } from "./agent-runs.mjs";
import { providerCapabilities } from "./provider-capabilities.mjs";

/**
 * The activity from what is known of a Chat. `background` is how much background work still goes on.
 * The first that applies wins:
 * - waiting: the turn waits on the user (an approval or a question);
 * - working: a turn runs;
 * - failed: the last turn failed. It wins over background work, so a failure is never shown as work still going;
 * - background: no turn runs, but background work goes on and its results come back to the Chat;
 * - idle: nothing runs.
 */
export function activityOf({ running = false, waiting = false, failed = false, background = 0 } = {}) {
  if (running && waiting) return "waiting";
  if (running) return "working";
  if (failed) return "failed";
  if (background > 0) return "background";
  return "idle";
}

export const activityBusy = (activity) => activity === "working" || activity === "waiting" || activity === "background";

// Not toSorted: the phone's Hermes has none.
const oldestFirst = (items) => items.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
const ownsBackground = (session) => Boolean(session) && providerCapabilities(session.provider ?? "claude").backgroundSubagents;

/** Oldest first; empty for a provider without background subagents. */
export function backgroundSubagents(session) {
  if (!ownsBackground(session)) return [];
  return oldestFirst((session.subagents ?? []).filter((agent) => agent.background && subagentActive(agent) && agent.id !== session.native_session_id));
}

/** Oldest first. */
export function backgroundTasks(session) {
  return ownsBackground(session) ? oldestFirst([...(session.backgroundTasks ?? [])]) : [];
}

export function processWork(session) {
  return oldestFirst([...backgroundSubagents(session), ...backgroundTasks(session)]);
}

export const outlivesTurn = (agent) => Boolean(agent?.background) || agent?.source === "milagre-advisor";

const activeAdvisors = (session) => (session?.subagents ?? []).filter((agent) => agent.source === "milagre-advisor" && subagentActive(agent));

/** Oldest first. */
export function backgroundWork(session) {
  return oldestFirst([...processWork(session), ...activeAdvisors(session)]);
}

// Claude Code's task types: a local_bash task is a command run in the background or a Monitor, the only kind with output.
const TASK_TYPES = { local_bash: "command", local_workflow: "workflow" };
export const BACKGROUND_ITEM_LABELS = Object.freeze({ subagent: "Subagent", advisor: "Advisor", command: "Command", workflow: "Workflow", task: "Task" });

/** Oldest first. A command's output can be read while it runs (chat:task-output). */
export function backgroundItems(session, ports = []) {
  const agent = (type) => (item) => ({ type, id: item.id, title: item.title, startedAt: item.startedAt, agent: item });
  const served = new Set(ports.map((port) => port.taskId).filter(Boolean));
  return oldestFirst([
    ...backgroundSubagents(session).map(agent("subagent")),
    ...activeAdvisors(session).map(agent("advisor")),
    ...backgroundTasks(session)
      .filter((task) => !served.has(task.id))
      .map((task) => ({ type: TASK_TYPES[task.kind] ?? "task", id: task.id, title: task.title, startedAt: task.startedAt })),
  ]);
}

/** @returns {{ activity: string; background: number; since?: number }} */
export function chatActivity(session, run, lastOutcome = session?.summary?.lastOutcome) {
  const work = backgroundWork(session);
  const activity = activityOf({
    running: Boolean(run),
    waiting: Boolean(run?.approvals?.length || run?.questions?.length),
    failed: lastOutcome === "failed",
    background: work.length,
  });
  return { activity, background: work.length, ...(work.length ? { since: work[0].startedAt } : {}) };
}

// oxlint-disable-next-line no-control-regex -- CSI (colours, cursor moves), OSC (titles, links) and two-character escapes
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[ -/]*[@-~]/g;

export function plainTaskOutput(text) {
  return String(text ?? "")
    .replace(ESCAPES, "")
    .split("\n")
    .map((line) => line.replace(/\r+$/, "").split("\r").pop())
    .join("\n");
}

export function backgroundLabel(count) {
  return `${count} background task${count === 1 ? "" : "s"}`;
}

export function backgroundBusyMessage(action, count, to = "another agent") {
  const one = count === 1;
  const running = `${one ? "A background task is" : `${count} background tasks are`} still running in this Chat`;
  const it = one ? "it" : "them";
  const ends = one ? "it finishes" : "they finish";
  if (action === "reload") return `${running}. Reloading would stop ${it}. Ask the agent to stop ${it}, or reload once ${ends}.`;
  if (action === "edit") return `${running}. Editing a message would stop ${it}. Ask the agent to stop ${it}, or edit once ${ends}.`;
  if (action === "switch") return `${running}. Switching to ${to} would stop ${it}. Ask the agent to stop ${it}, or send again once ${ends}.`;
  return `${running}, and its agent can't move to another folder without stopping ${it}. Ask the agent to stop ${it}, or send again once ${ends}.`;
}

export function notificationPreview(previous, text, startsMessage = false) {
  return ((startsMessage ? "" : previous || "") + (text || "")).slice(0, 4096);
}

/** A command run in the background doesn't: it can be a server that never ends. */
export const holdsAnnouncement = (task) => task?.kind !== "local_bash";

const MAX_CHATS = 500;

/**
 * `observe` returns how the Chat's activity changed; `completion` is set when its work just ended. A turn that ends
 * while background work goes on announces nothing until the last of it ends.
 */
export function createActivityTracker({ maxChats = MAX_CHATS, holdsTask = holdsAnnouncement } = {}) {
  const chats = new Map();
  const fresh = () => ({ running: false, ended: false, requests: new Set(), agents: new Set(), tasks: new Set(), failed: false, preview: "", end: null });
  const background = (chat) => chat.agents.size + chat.tasks.size;
  const activity = (chat) =>
    chat ? activityOf({ running: chat.running, waiting: chat.requests.size > 0, failed: chat.failed, background: background(chat) }) : "idle";
  return {
    observe(chatId, event) {
      let chat = chats.get(chatId);
      if (!chat) {
        chat = fresh();
        chats.set(chatId, chat);
        if (chats.size > maxChats) chats.delete(chats.keys().next().value);
      }
      if (isTurnEnd(event) && !chat.running && !chat.ended) chat.running = true;
      const previous = activity(chat);
      let completion = null;
      switch (event.type) {
        case "turn-started":
          chat.running = true;
          chat.ended = false;
          chat.failed = false;
          chat.end = null;
          chat.preview = "";
          break;
        case "message-sent":
        case "answers-sent":
          chat.preview = "";
          if (event.type === "message-sent") {
            chat.running = true;
            chat.ended = false;
            chat.failed = false;
            chat.end = null;
          }
          break;
        case "text-delta":
          if (chat.running) chat.preview = notificationPreview(chat.preview, event.text, event.startsMessage);
          break;
        case "permission-request":
        case "question-request":
          if (chat.running && typeof event.requestId === "string") chat.requests.add(event.requestId);
          break;
        case "permission-resolved":
        case "question-resolved":
          chat.requests.delete(event.requestId);
          break;
        case "subagent-update":
          if (outlivesTurn(event.agent)) {
            if (subagentActive(event.agent)) chat.agents.add(event.agent.id);
            else chat.agents.delete(event.agent.id);
          }
          break;
        case "background-tasks":
          chat.tasks = new Set((Array.isArray(event.tasks) ? event.tasks : []).filter(holdsTask).map((task) => task.id));
          break;
        default:
          if (isTurnEnd(event)) {
            chat.running = false;
            chat.ended = true;
            chat.requests.clear();
            chat.failed = event.type === "turn-failed";
            chat.end =
              event.type === "turn-cancelled" || event.quiet
                ? null
                : { failed: chat.failed, body: chat.failed ? event.message : chat.preview || "Turn completed.", event };
            chat.preview = "";
          }
      }
      const next = activity(chat);
      if (previous !== next && activityBusy(previous) && (next === "idle" || next === "failed")) {
        completion = chat.end;
        chat.end = null;
      }
      return { previous, next, completion };
    },
    activity(chatId) {
      return activity(chats.get(chatId));
    },
    background(chatId) {
      const chat = chats.get(chatId);
      return chat ? background(chat) : 0;
    },
    forget(drop = () => true) {
      for (const chatId of Array.from(chats.keys())) if (drop(chatId)) chats.delete(chatId);
    },
  };
}
