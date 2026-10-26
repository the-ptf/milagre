import { providerName } from "./providers.mjs";
// System notifications for chats that wait on the user, built by the main process, which sees every
// project's chats (see notifications.cjs). Types: attention.d.mts.
import { chatTitle } from "./chats.mjs";
import { projectOfKey } from "./agent-runs.mjs";
import { activityBusy, chatActivity } from "./chat-activity.mjs";
import { isLinkScopeKey } from "./chat-scopes.mjs";

/** A compact plain-text preview for desktop and phone notifications. */
export function notificationText(value, { markdown = true } = {}) {
  let text = typeof value === "string" ? value : "";
  if (markdown)
    text = text
      .replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g, " ")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, "")
      .replace(/(?<![\w/])(\*\*|__|~~)(\w.*?)\1/g, "$2")
      .replace(/(^|\s)([*_])(\w[^*_\n]*?\w|\w)\2(?=$|[\s.,!?;:])/g, "$1$3")
      .replace(/`+([^`]+)`+/g, "$1");
  text = (markdown ? text.replace(/\s+/g, " ") : text).trim();
  if (text.length <= 240) return text;
  const start = text.slice(0, 239);
  const space = start.lastIndexOf(" ");
  return `${space > 120 ? start.slice(0, space) : start}…`;
}

export { notificationPreview } from "./chat-activity.mjs";

/** The same chat-only title and result preview on desktop and phones. */
export function completionNotice(title, { failed, body }) {
  return {
    title: (typeof title === "string" ? title.trim() : "") || "Milagre",
    body: notificationText(failed ? `Turn failed: ${body}` : body) || (failed ? "Turn failed." : "Turn completed."),
  };
}

/** The notification for an approval or question a turn waits on, or null for any other event. */
export function attentionNotice(event, context) {
  if (event.type !== "permission-request" && event.type !== "question-request") return null;
  const agent = context.provider ? providerName(context.provider) : "Agent";
  const title = context.chatTitle?.trim() || "Milagre";

  if (event.type === "question-request") {
    const [first, ...rest] = event.questions;
    const more = rest.length ? ` (+${rest.length} more)` : "";
    return { title, body: notificationText(`${agent} needs input: ${first?.question ?? "Asked a question"}${more}`) };
  }
  const command = event.command?.split("\n")[0].trim();
  return { title, body: notificationText(`${agent} needs approval: ${command ? `Run: ${command}` : event.title}`, { markdown: !command }) };
}

/** What a notice names about a chat: its project, worktree, title and agent. */
export function attentionContext(state, projectName, sessionId) {
  const session = state.sessions[sessionId];
  if (!session) return { projectName };
  return {
    projectName,
    worktreeName: state.worktrees?.[session.worktree_id]?.name,
    chatTitle: chatTitle(
      session,
      state.messages.filter((message) => message.session_id === session.id),
    ),
    provider: session.provider,
  };
}

const NO_HIDDEN = new Set();

/** Chat keys other than `currentChat` whose turn waits on an approval or question, oldest key first. Link Chats and the
 * Projects in `hidden` (hidden from the sidebar and the phone's list) are left out. */
export function chatsNeedingAttention(runs, currentChat = "", hidden = NO_HIDDEN) {
  return Object.entries(runs ?? {})
    .filter(
      ([key, run]) =>
        (run?.approvals?.length || run?.questions?.length) && !isLinkScopeKey(projectOfKey(key)) && !hidden.has(projectOfKey(key)) && key !== currentChat,
    )
    .map(([key]) => key);
}

/** Name the waiting Chat, or count Chats when the button opens a menu. */
export function attentionLabel(titles) {
  if (titles.length <= 1) return `${titles[0]?.trim() || "Chat"} needs attention`;
  return `${titles.length} Chats need attention`;
}

/** What a waiting run asks for, in one line: the approval's command or title, or its first question. */
export function waitingFor(run) {
  const approval = run?.approvals?.[0];
  if (approval) return approval.command?.split("\n")[0].trim() || approval.title;
  return run?.questions?.[0]?.questions?.[0]?.question;
}

/** Small, live inbox projection. Transcripts and tool output stay with their Chats. */
const inboxPriority = (item) => (item.status === "approval" || item.status === "question" ? 0 : 1);

export function inboxSnapshot(scopes, runs = {}) {
  const agents = [];
  for (const { path, name, state } of scopes) {
    for (const session of Object.values(state.sessions)) {
      if (session.archived) continue;
      const key = `${path}#${session.id}`;
      const run = runs[key];
      const permission = run?.approvals?.find((request) => !run.answered?.[request.requestId]);
      const question = permission ? undefined : run?.questions?.find((request) => !run.answered?.[request.requestId]);
      // A failed turn is never shown as work still going, even with background subagents at work (chat-activity.mjs).
      const { activity } = chatActivity(session, run);
      const background = activity === "background";
      const outcome = session.summary?.lastOutcome;
      const status = permission
        ? "approval"
        : question
          ? "question"
          : activityBusy(activity)
            ? "working"
            : session.unread && (outcome === "completed" || outcome === "failed")
              ? outcome
              : null;
      if (!status) continue;
      // A hidden Run Chat only surfaces for what needs a person: its approval, its question or its failure.
      if (session.routine?.hidden === true && status !== "approval" && status !== "question" && status !== "failed") continue;
      const last = state.messages?.findLast((message) => message.session_id === session.id && message.role === "assistant");
      agents.push({
        key,
        projectPath: path,
        project: name,
        title: chatTitle(session, []),
        provider: session.provider,
        status,
        at: run?.startedAt ?? session.summary?.lastAt ?? 0,
        ...(permission ? { permission } : {}),
        ...(question ? { question } : {}),
        ...(status === "working"
          ? {
              preview: (
                run?.steps?.findLast((step) => step.status === "running")?.title ||
                run?.text ||
                (background ? "Working in the background." : "The agent is working.")
              )
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 240),
            }
          : {}),
        ...(status === "completed" || status === "failed"
          ? {
              preview:
                last?.body?.slice(0, 240) ||
                (status === "failed" ? "The turn failed. Open the Chat for details." : "The agent finished its turn. Open the Chat to review the result."),
            }
          : {}),
      });
    }
  }
  const items = agents
    .filter((item) => item.status !== "working")
    .toSorted((a, b) => inboxPriority(a) - inboxPriority(b) || (inboxPriority(a) === 0 ? a.at - b.at : b.at - a.at) || a.key.localeCompare(b.key));
  return { agents, items };
}

/** The experimental activity switch applies equally to the dots and inbox pages. */
export function visibleInbox(snapshot, activity = true) {
  const visible = (item) => activity || item.status === "question" || item.status === "approval";
  const agents = snapshot.agents.filter(visible);
  const items = snapshot.items.filter(visible);
  return { agents, items: [...items, ...agents.filter((item) => item.status === "working" && !items.some((row) => row.key === item.key))] };
}
