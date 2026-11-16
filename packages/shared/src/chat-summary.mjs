import { pullRequestRefs } from "./chat-pull-requests.mjs";

export const isGitNote = (message) => typeof message?.context === "object" && message.context?.kind === "git-action";

export const isNote = (message) =>
  isGitNote(message) || ["worktree-linked", "reload", "checkpoint-restore", "babysit-stopped", "orchestrator-answer"].includes(message?.context?.kind);

export function summarizeChat(messages) {
  const input = messages.find((message) => message.role !== "assistant" && message.body?.trim());
  const lastReply = messages.findLast((message) => message.role === "assistant" && !isNote(message));
  const lastModel = messages.findLast((message) => message.role === "user" && message.model)?.model;
  const openHandoff = messages.findLast((message) => message.context?.kind === "handoff" && message.context.status === "preparing")?.id;
  const summary = { count: messages.length };
  if (messages.length) Object.assign(summary, { firstId: messages[0].id, lastId: messages.at(-1).id });
  if (input) {
    summary.titleLine = input.body.trim().split("\n")[0].slice(0, 200);
    if (input.images?.length) summary.titleImages = input.images.length;
  }
  if (lastReply?.outcome) summary.lastOutcome = lastReply.outcome;
  const refs = pullRequestRefs(messages);
  if (refs.length) summary.pullRequests = refs;
  if (lastModel) summary.lastModel = lastModel;
  if (openHandoff !== undefined) summary.openHandoff = openHandoff;
  const sent = messages
    .filter((message) => message.clientMessageId)
    .slice(-5)
    .map((message) => message.clientMessageId);
  if (sent.length) summary.clientMessageIds = sent;
  const card = messages[0]?.context;
  if (card?.kind === "linear-issue" && typeof card.key === "string") {
    summary.linearIssue = card.key;
    if (typeof card.workspace === "string" && card.workspace) summary.linearWorkspace = card.workspace;
  }
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
