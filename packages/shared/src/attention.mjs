import { providerName } from "./providers.mjs";
// System notifications for chats that wait on the user, built by the main process, which sees every
// project's chats (see notifications.cjs). Types: attention.d.mts.
import { chatTitle } from "./chats.mjs";
import { chatInProject, projectOfKey, subagentActive } from "./agent-runs.mjs";
import { isLinkScopeKey } from "./chat-scopes.mjs";

/**
 * The notification for an approval or question a turn waits on, e.g. "shop / fix-login - Claude needs input",
 * or null for any other event.
 */
export function attentionNotice(event, context) {
  if (event.type !== "permission-request" && event.type !== "question-request") return null;
  const where = context.worktreeName && context.worktreeName !== context.projectName ? `${context.projectName} / ${context.worktreeName}` : context.projectName;
  const agent = context.provider ? providerName(context.provider) : "Agent";

  const title = context.chatTitle || where;
  const subtitle = context.chatTitle ? where : undefined;

  if (event.type === "question-request") {
    const [first, ...rest] = event.questions;
    const more = rest.length ? ` (+${rest.length} more)` : "";
    return { title, subtitle, body: `${agent} needs input: ${first?.question ?? "Asked a question"}${more}` };
  }
  const command = event.command?.split("\n")[0].trim();
  return { title, subtitle, body: `${agent} needs approval: ${command ? `Run: ${command}` : event.title}` };
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

/** Chat keys outside `currentPath` whose turn waits on an approval or question, oldest key first. Link Chats are left out. */
export function chatsNeedingAttention(runs, currentPath = "") {
  return Object.entries(runs ?? {})
    .filter(([key, run]) => (run?.approvals?.length || run?.questions?.length) && !isLinkScopeKey(projectOfKey(key)) && !chatInProject(currentPath, key))
    .map(([key]) => key);
}

/** The attention button's words for the projects waiting, by name: "shop needs attention", "shop and api need attention", "shop and 2 more need attention". */
export function attentionLabel(names) {
  if (names.length <= 1) return `${names[0] ?? "A project"} needs attention`;
  if (names.length === 2) return `${names[0]} and ${names[1]} need attention`;
  return `${names[0]} and ${names.length - 1} more need attention`;
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
      const background = session.subagents?.some((agent) => agent.background && subagentActive(agent));
      const outcome = session.summary?.lastOutcome;
      const status = permission
        ? "approval"
        : question
          ? "question"
          : run || background
            ? "working"
            : session.unread && (outcome === "completed" || outcome === "failed")
              ? outcome
              : null;
      if (!status) continue;
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
