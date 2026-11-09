// What a Chat is doing, in one word, for every surface that shows or announces it: sidebar rows on desktop and the
// phone, the Chat's own status line, the canvas, the inbox, linked and MCP Chat status, and desktop and phone
// notifications. A turn's end is not the end of the Chat's work: background work outlives it (a provider's background
// subagents and tasks, providerCapabilities().backgroundSubagents, and Milagre's advisors), and the Chat stays
// "background" until the last of it ends. Types: chat-activity.d.mts.

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

/** Whether the Chat's work is still under way: a turn runs, or background work goes on. */
export const activityBusy = (activity) => activity === "working" || activity === "waiting" || activity === "background";

// Not toSorted: the phone's Hermes has none.
const oldestFirst = (items) => items.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
const ownsBackground = (session) => Boolean(session) && providerCapabilities(session.provider ?? "claude").backgroundSubagents;

/** The Chat's background subagents still at work, oldest first; none for a provider without them. */
export function backgroundSubagents(session) {
  if (!ownsBackground(session)) return [];
  return oldestFirst((session.subagents ?? []).filter((agent) => agent.background && subagentActive(agent) && agent.id !== session.native_session_id));
}

/** The Chat's other background tasks (a command run in the background, an MCP task, a workflow), oldest first. */
export function backgroundTasks(session) {
  return ownsBackground(session) ? oldestFirst([...(session.backgroundTasks ?? [])]) : [];
}

/**
 * The background work the Chat's agent process holds: its background subagents and tasks. Anything that ends that
 * process (a handoff to another provider, a reload, a move to another folder) would stop it.
 */
export function processWork(session) {
  return oldestFirst([...backgroundSubagents(session), ...backgroundTasks(session)]);
}

/**
 * Whether a subagent's work outlives the turn and comes back to the Chat by itself: a provider's background subagent,
 * or a Milagre advisor (its result reaches the Chat as a message of its own, see advisor-delivery.cjs).
 */
export const outlivesTurn = (agent) => Boolean(agent?.background) || agent?.source === "milagre-advisor";

const activeAdvisors = (session) => (session?.subagents ?? []).filter((agent) => agent.source === "milagre-advisor" && subagentActive(agent));

/** Everything still at work for the Chat with no turn of its own, oldest first: its process's work and its advisors. */
export function backgroundWork(session) {
  return oldestFirst([...processWork(session), ...activeAdvisors(session)]);
}

// Claude Code's task types: a local_bash task is a command run in the background or a Monitor, the only kind with output.
const TASK_TYPES = { local_bash: "command", local_workflow: "workflow" };
export const BACKGROUND_ITEM_LABELS = Object.freeze({ subagent: "Subagent", advisor: "Advisor", command: "Command", workflow: "Workflow", task: "Task" });

/**
 * The Chat's background work as its background line lists it, oldest first: what each is and since when. A command's
 * output can be read while it runs (chat:task-output); a subagent or advisor carries its own transcript.
 */
export function backgroundItems(session, ports = []) {
  const agent = (type) => (item) => ({ type, id: item.id, title: item.title, startedAt: item.startedAt, agent: item });
  // A command serving one of the Chat's ports shows in Ports, where it can be opened and stopped, and not here too.
  const served = new Set(ports.map((port) => port.taskId).filter(Boolean));
  return oldestFirst([
    ...backgroundSubagents(session).map(agent("subagent")),
    ...activeAdvisors(session).map(agent("advisor")),
    ...backgroundTasks(session)
      .filter((task) => !served.has(task.id))
      .map((task) => ({ type: TASK_TYPES[task.kind] ?? "task", id: task.id, title: task.title, startedAt: task.startedAt })),
  ]);
}

/**
 * A Chat's activity from its saved session and its streaming run (agent-runs.mjs), with how much background work still
 * goes on and since when. `lastOutcome` is how its last reply ended (chat-summary.mjs), for a session without a summary.
 * @returns {{ activity: string; background: number; since?: number }}
 */
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

/**
 * A background command's output (chat:task-output) as plain text: without escape sequences, and a line the command
 * redrew with carriage returns (a progress bar) as it stands now.
 */
export function plainTaskOutput(text) {
  return String(text ?? "")
    .replace(ESCAPES, "")
    .split("\n")
    .map((line) => line.replace(/\r+$/, "").split("\r").pop())
    .join("\n");
}

/** "1 background task", "3 background tasks": agents, commands and advisors alike. */
export function backgroundLabel(count) {
  return `${count} background task${count === 1 ? "" : "s"}`;
}

/**
 * Why Milagre won't do what would stop the background work a Chat's agent process holds: hand the Chat to another
 * provider ("switch", naming it as `to`), reload its agent ("reload"), or start its agent in another folder ("move").
 * Each ends that process, and the work with it (T3 Code #16000), so the Chat waits for the work instead.
 */
export function backgroundBusyMessage(action, count, to = "another agent") {
  const one = count === 1;
  const running = `${one ? "A background task is" : `${count} background tasks are`} still running in this Chat`;
  const it = one ? "it" : "them";
  const ends = one ? "it finishes" : "they finish";
  if (action === "reload") return `${running}. Reloading would stop ${it}. Ask the agent to stop ${it}, or reload once ${ends}.`;
  if (action === "switch") return `${running}. Switching to ${to} would stop ${it}. Ask the agent to stop ${it}, or send again once ${ends}.`;
  return `${running}, and its agent can't move to another folder without stopping ${it}. Ask the agent to stop ${it}, or send again once ${ends}.`;
}

/** Keep the beginning of the latest reply; ordinary paragraph breaks stay in the preview. */
export function notificationPreview(previous, text, startsMessage = false) {
  return ((startsMessage ? "" : previous || "") + (text || "")).slice(0, 4096);
}

/**
 * Whether a background task holds back the announcement of the turn that started it. A command run in the background
 * doesn't: it can be a server that never ends, and the turn's end would never be announced.
 */
export const holdsAnnouncement = (task) => task?.kind !== "local_bash";

const MAX_CHATS = 500;

/**
 * Follows Chats from their agent events alone, for the notifiers that see no saved state (desktop's main process and
 * the daemon's phone push). `observe` folds an event and says how the Chat's activity changed; `completion` is set when
 * the Chat's work just ended: it left working or background for idle or failed, after a turn that completed or failed.
 * A turn that ends while background work goes on announces nothing then; the turn its result wakes announces its own
 * end, and if none comes the held end is announced when the last of it ends. A cancelled or quiet turn announces nothing.
 * Only work that holds the announcement counts here (holdsAnnouncement); the Chat's sidebar row shows all of it.
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
      // A turn's end means a turn ran, even one that started before this tracker was listening.
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
              // A quiet turn (a heartbeat's "(pass)", or one failing again) has nothing to announce, like a cancelled one.
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
    /** The Chat's activity as the events so far tell it. */
    activity(chatId) {
      return activity(chats.get(chatId));
    },
    /** How much of the Chat's background work, of the kinds that hold an announcement, still goes on. */
    background(chatId) {
      const chat = chats.get(chatId);
      return chat ? background(chat) : 0;
    },
    /** Forgets the Chats `drop` picks, every Chat when it is left out. */
    forget(drop = () => true) {
      // A copy: the caller's predicate may update the tracked Chats.
      for (const chatId of Array.from(chats.keys())) if (drop(chatId)) chats.delete(chatId);
    },
  };
}
