// What a Chat is doing, in one word, for every surface that shows or announces it: sidebar rows on desktop and the
// phone, the Chat's own status line, the inbox, and desktop and phone notifications. A turn's end is not the end of the
// Chat's work: background subagents (providerCapabilities().backgroundSubagents) outlive it and wake the Chat later with a
// turn of their own, so the Chat stays "background" until the last of them ends. Types: chat-activity.d.mts.

import { isTurnEnd, subagentActive } from "./agent-runs.mjs";
import { providerCapabilities } from "./provider-capabilities.mjs";

/**
 * The first that applies wins:
 * - waiting: the turn waits on the user (an approval or a question);
 * - working: a turn runs;
 * - failed: the last turn failed. It wins over background work, so a failure is never shown as work still going;
 * - background: no turn runs, but background subagents still work and their results will wake the Chat;
 * - idle: nothing runs.
 */
export const CHAT_ACTIVITIES = Object.freeze(["waiting", "working", "failed", "background", "idle"]);

/** The activity from what is known of a Chat. `background` is how many background subagents still work. */
export function activityOf({ running = false, waiting = false, failed = false, background = 0 } = {}) {
  if (running && waiting) return "waiting";
  if (running) return "working";
  if (failed) return "failed";
  if (background > 0) return "background";
  return "idle";
}

/** Whether the Chat's work is still under way: a turn runs, or background subagents still work. */
export const activityBusy = (activity) => activity === "working" || activity === "waiting" || activity === "background";

const oldestFirst = (agents) => agents.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));

/**
 * The Chat's provider-owned background subagents still at work, oldest first; none for a provider without them. They
 * run in the Chat's agent process, so anything that ends it (a handoff, a reload) would stop them.
 */
export function backgroundSubagents(session) {
  if (!session || !providerCapabilities(session.provider ?? "claude").backgroundSubagents) return [];
  return oldestFirst((session.subagents ?? []).filter((agent) => agent.background && subagentActive(agent) && agent.id !== session.native_session_id));
}

/**
 * Whether a subagent's work outlives the turn and comes back to the Chat by itself: a provider's background subagent,
 * or a Milagre advisor (its result reaches the Chat as a message of its own, see advisor-delivery.cjs).
 */
export const outlivesTurn = (agent) => Boolean(agent?.background) || agent?.source === "milagre-advisor";

/** Everything still at work for the Chat with no turn of its own: its background subagents and its advisors, oldest first. */
export function backgroundWork(session) {
  const advisors = (session?.subagents ?? []).filter((agent) => agent.source === "milagre-advisor" && subagentActive(agent));
  return oldestFirst([...backgroundSubagents(session), ...advisors]);
}

/**
 * A Chat's activity from its saved session and its streaming run (agent-runs.mjs), with the count of background
 * work still going. `lastOutcome` is how its last reply ended (chat-summary.mjs), when the session has no summary.
 * @returns {{ activity: string; background: number; since?: number }}
 */
export function chatActivity(session, run, lastOutcome = session?.summary?.lastOutcome) {
  const agents = backgroundWork(session);
  const activity = activityOf({
    running: Boolean(run),
    waiting: Boolean(run?.approvals?.length || run?.questions?.length),
    failed: lastOutcome === "failed",
    background: agents.length,
  });
  return { activity, background: agents.length, ...(agents.length ? { since: agents[0].startedAt } : {}) };
}

/** "1 background agent", "3 background agents". */
export function backgroundLabel(count) {
  return `${count} background agent${count === 1 ? "" : "s"}`;
}

/**
 * Why Milagre won't do what would stop a Chat's background subagents: hand it to another provider ("switch", naming
 * it as `to`), reload its agent ("reload"), or start its agent in another folder ("move"). Each of those ends the
 * agent process the subagents run in, so the Chat waits for them instead.
 */
export function backgroundBusyMessage(action, count, to = "another agent") {
  const running = `${count === 1 ? "A background agent is" : `${count} background agents are`} still running in this Chat`;
  if (action === "reload")
    return `${running}. Reloading would stop ${count === 1 ? "it" : "them"}; reload once ${count === 1 ? "it finishes" : "they finish"}.`;
  if (action === "switch")
    return `${running}. Switching to ${to} would stop ${count === 1 ? "it" : "them"}; send again once ${count === 1 ? "it finishes" : "they finish"}.`;
  return `${running}, and its agent can't move to another folder without stopping ${count === 1 ? "it" : "them"}. Send again once ${count === 1 ? "it finishes" : "they finish"}.`;
}

/** Keep the beginning of the latest reply; ordinary paragraph breaks stay in the preview. */
export function notificationPreview(previous, text, startsMessage = false) {
  return ((startsMessage ? "" : previous || "") + (text || "")).slice(0, 4096);
}

const MAX_CHATS = 500;

/**
 * Follows Chats from their agent events alone, for the notifiers that see no saved state (desktop's main process and
 * the daemon's phone push). `observe` folds an event and says how the Chat's activity changed; `completion` is set when
 * the Chat's work just ended: it left working or background for idle or failed, after a turn that completed or failed.
 * A turn that ends while background subagents work announces nothing then; the turn their result wakes announces its
 * own end, and if none comes the held end is announced when the last of them ends. A cancelled turn announces nothing.
 */
export function createActivityTracker({ maxChats = MAX_CHATS } = {}) {
  const chats = new Map();
  const fresh = () => ({ running: false, ended: false, requests: new Set(), background: new Set(), failed: false, preview: "", end: null });
  const activity = (chat) =>
    chat ? activityOf({ running: chat.running, waiting: chat.requests.size > 0, failed: chat.failed, background: chat.background.size }) : "idle";
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
            if (subagentActive(event.agent)) chat.background.add(event.agent.id);
            else chat.background.delete(event.agent.id);
          }
          break;
        default:
          if (isTurnEnd(event)) {
            chat.running = false;
            chat.ended = true;
            chat.requests.clear();
            chat.failed = event.type === "turn-failed";
            chat.end =
              event.type === "turn-cancelled" ? null : { failed: chat.failed, body: chat.failed ? event.message : chat.preview || "Turn completed.", event };
            chat.preview = "";
          }
      }
      const next = activity(chat);
      if (previous !== next && (previous === "working" || previous === "waiting" || previous === "background") && (next === "idle" || next === "failed")) {
        completion = chat.end;
        chat.end = null;
      }
      return { previous, next, completion };
    },
    /** The Chat's activity as the events so far tell it. */
    activity(chatId) {
      return activity(chats.get(chatId));
    },
    /** How many of the Chat's background subagents still work. */
    background(chatId) {
      return chats.get(chatId)?.background.size ?? 0;
    },
    /** Forgets the Chats `drop` picks, every Chat when it is left out. */
    forget(drop = () => true) {
      for (const chatId of [...chats.keys()]) if (drop(chatId)) chats.delete(chatId);
    },
  };
}
