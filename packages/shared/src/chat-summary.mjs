// What the chat lists, titles and handoff recovery need from a Chat's messages, kept on the Chat itself
// (`session.summary`) so they don't walk every message of every Chat. The host keeps it current; see #300.
import { pullRequestRefs } from "./chat-pull-requests.mjs";

/** A line the commit dialog saved in the chat, as opposed to an agent's reply. */
export const isGitNote = (message) => typeof message?.context === "object" && message.context?.kind === "git-action";

/** A line Milagre saved in the chat that isn't a reply: a commit dialog note, a Link reaching the Chat, or a reload. */
export const isNote = (message) => isGitNote(message) || message?.context?.kind === "worktree-linked" || message?.context?.kind === "reload";

/** The summary of a Chat whose messages, in the Project's order, are `messages`. */
export function summarizeChat(messages) {
  const input = messages.find((message) => message.role !== "assistant" && message.body?.trim());
  const lastReply = messages.findLast((message) => message.role === "assistant" && !isNote(message));
  const lastModel = messages.findLast((message) => message.role === "user" && message.model)?.model;
  const openHandoff = messages.findLast((message) => message.context?.kind === "handoff" && message.context.status === "preparing")?.id;
  const summary = { count: messages.length };
  if (messages.length) Object.assign(summary, { firstId: messages[0].id, lastId: messages.at(-1).id });
  // The first line of the first thing the user wrote names a Chat that has no title.
  if (input) summary.titleLine = input.body.trim().split("\n")[0].slice(0, 200);
  if (lastReply?.outcome) summary.lastOutcome = lastReply.outcome;
  const refs = pullRequestRefs(messages);
  if (refs.length) summary.pullRequests = refs;
  if (lastModel) summary.lastModel = lastModel;
  if (openHandoff !== undefined) summary.openHandoff = openHandoff;
  // A window that holds no messages matches its pending send to the saved one by these (see pendingChatSessionId).
  const sent = messages
    .filter((message) => message.clientMessageId)
    .slice(-5)
    .map((message) => message.clientMessageId);
  if (sent.length) summary.clientMessageIds = sent;
  return summary;
}

/** Whether two summaries say the same, so an unchanged Chat keeps its object. */
export function sameSummary(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) =>
      Array.isArray(a[key])
        ? Array.isArray(b[key]) && a[key].length === b[key].length && a[key].every((item, index) => item === b[key][index])
        : a[key] === b[key],
    )
  );
}

/** The Chat's summary: the one the host keeps, else one made from its messages (an older host keeps none). */
export function chatSummary(session, messages) {
  return session?.summary ?? summarizeChat(messages ?? []);
}
