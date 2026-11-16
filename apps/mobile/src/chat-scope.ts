import type { CoordinatorState, OpenLink } from "@milagre/shared/model";
import { isLinkScopeKey, scopeKey } from "@milagre/shared/chat-scopes";
import { linkChatWorktreesLabel } from "@milagre/shared/worktree-link";
import type { OpenProject, Runs, Snapshot } from "./client.ts";

export function phoneSnapshot(value: Snapshot | { link: OpenLink; runs: Runs }): Snapshot {
  if ("project" in value) return value;
  const { link, runs } = value;
  const state: CoordinatorState = {
    next_id: link.state.next_id,
    ...(link.state.persistence ? { persistence: link.state.persistence } : {}),
    projects: {},
    tasks: {},
    messages: link.state.messages,
    ...(link.state.messagesInChats ? { messagesInChats: true } : {}),
    sessions: Object.fromEntries(Object.entries(link.state.sessions).map(([id, chat]) => [id, { ...chat, worktree_id: chat.id }])),
    worktrees: Object.fromEntries(
      Object.entries(link.state.sessions).map(([id, chat]) => [
        id,
        {
          id: chat.id,
          project_id: 0,
          path: chat.workspacePath,
          name: linkChatWorktreesLabel(chat.worktrees.length),
          sharedChat: { linkId: link.link.id, sessionId: chat.id },
        },
      ]),
    ),
  };
  state.worktrees[0] = { id: 0, project_id: 0, path: "", name: `${link.projects.length} Projects` };
  return { project: { path: scopeKey({ kind: "link", linkId: link.link.id }), name: link.link.name, state, link }, runs };
}

export function memberForDiff(project: OpenProject | undefined, chatId: number, memberId?: string) {
  if (!project) return undefined;
  if (!project.link) return project.state.worktrees[chatId];
  const member = project.link.state.sessions[chatId]?.worktrees.find((member) => member.projectId === memberId);
  return member ? { path: member.worktreePath, base: member.base, name: member.branch } : undefined;
}

export const isChatScope = (owner: unknown): owner is string => typeof owner === "string" && (owner.startsWith("/") || isLinkScopeKey(owner));
