const { summarizeChat, sameSummary } = require("@milagre/shared/chat-summary");
const { unloadedChats } = require("./message-store.cjs");

// Keeps each Chat's summary (session.summary) current with its messages, in the change that touches them, so the chat
// lists, titles and handoff recovery read the summary instead of walking every message of every Chat (#300).

const EMPTY = Object.freeze([]);
// Messages grouped by Chat, once per messages array (states are replaced, never changed in place).
const groupings = new WeakMap();
function byChat(messages) {
  let grouped = groupings.get(messages);
  if (!grouped) {
    grouped = new Map();
    for (const message of messages) {
      const key = String(message.session_id);
      const list = grouped.get(key);
      if (list) list.push(message);
      else grouped.set(key, [message]);
    }
    groupings.set(messages, grouped);
  }
  return grouped;
}
const sameList = (a, b) => a.length === b.length && a.every((item, index) => item === b[index]);
// A Link reaching a Chat adds a line to it, which doesn't count as activity: the Chat keeps its place in the lists.
const onlyLinkLines = (list, prior) =>
  list.length > prior.length &&
  prior.every((item, index) => item === list[index]) &&
  list.slice(prior.length).every((item) => item.context?.kind === "worktree-linked");

/** `next` with the summary of every Chat whose messages changed since `previous` (all of them without one) brought up to date. */
// `lastAt` is when a Chat last got a message or a reply ended, and `firstAt` when it got its first: messages carry no
// time, so both are stamped here as the change is saved. A state read from disk (no `previous`) keeps what it had.
function withChatSummaries(next, previous, clock = Date.now) {
  if (!next?.sessions || !Array.isArray(next.messages)) return next;
  if (previous && next.messages === previous.messages && next.sessions === previous.sessions) return next;
  const now = byChat(next.messages);
  const before = previous && Array.isArray(previous.messages) && previous.messages !== next.messages ? byChat(previous.messages) : null;
  const messagesKept = previous && previous.messages === next.messages;
  // An unloaded Chat's messages aren't in the state (see message-store.cjs), and can't have changed: it keeps its summary.
  const unloaded = unloadedChats(next);
  let sessions;
  for (const [id, session] of Object.entries(next.sessions)) {
    if (unloaded.has(Number(id))) {
      const kept = previous?.sessions?.[id]?.summary;
      if (!session.summary && kept) (sessions ??= { ...next.sessions })[id] = { ...session, summary: kept };
      continue;
    }
    const list = now.get(String(id)) ?? EMPTY;
    if (session.summary && (messagesKept || (before && sameList(list, before.get(String(id)) ?? EMPTY)))) continue;
    const summary = summarizeChat(list);
    const old = session.summary ?? previous?.sessions?.[id]?.summary;
    const quiet = before && onlyLinkLines(list, before.get(String(id)) ?? EMPTY);
    const active =
      previous && !quiet && (old ? old.count !== summary.count || old.lastId !== summary.lastId || old.lastOutcome !== summary.lastOutcome : summary.count > 0);
    const stamp = active ? clock() : undefined;
    const lastAt = stamp ?? old?.lastAt;
    if (lastAt !== undefined) summary.lastAt = lastAt;
    // `firstAt` is when the Chat got its first message, stamped like `lastAt`; a Chat that had messages before the host
    // kept it has none, and nothing in its session says when it began. It orders Chats across Projects, whose ids can't.
    const firstAt = summary.count === 0 ? undefined : old?.count ? old.firstAt : stamp;
    if (firstAt !== undefined) summary.firstAt = firstAt;
    if (sameSummary(session.summary, summary)) continue;
    (sessions ??= { ...next.sessions })[id] = { ...session, summary };
  }
  return sessions ? { ...next, sessions } : next;
}

module.exports = { withChatSummaries };
