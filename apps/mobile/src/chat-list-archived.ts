import { chatTitle } from "@milagre/shared/chats";
import type { AgentSession, ChatMessage } from "@milagre/shared/model";
import type { HostView } from "./all-computers-store.ts";

export type ArchivedChat = {
  hostId: string;
  hostName: string;
  projectPath: string;
  projectName: string;
  branch: string;
  chat: AgentSession;
  title: string;
};

const startedAt = (chat: AgentSession) => chat.summary?.firstAt ?? chat.summary?.lastAt ?? 0;

const built = new WeakMap<object, { key: string; items: ArchivedChat[] }>();

function archivedOf(view: HostView, project: HostView["projects"][number], copy: NonNullable<ReturnType<HostView["copies"]["get"]>>): ArchivedChat[] {
  const projectName = project.name || project.path.split("/").at(-1) || "Project";
  const key = [view.hostId, view.name, project.path, projectName].join("\n");
  const kept = built.get(copy);
  if (kept?.key === key) return kept.items;
  const state = copy.project.state;
  const archived = Object.values(state.sessions).filter((chat) => chat.archived);
  const items: ArchivedChat[] = [];
  if (archived.length) {
    const own = new Map<number, ChatMessage[]>(archived.map((chat) => [chat.id, []]));
    for (const message of state.messages || []) own.get(message.session_id)?.push(message);
    for (const chat of archived) {
      items.push({
        hostId: view.hostId,
        hostName: view.name,
        projectPath: project.path,
        projectName,
        branch: copy.project.link ? "" : (state.worktrees[chat.worktree_id]?.name ?? ""),
        chat,
        title: chatTitle(chat, own.get(chat.id)),
      });
    }
  }
  built.set(copy, { key, items });
  return items;
}

export function listArchivedChats(views: readonly HostView[]): ArchivedChat[] {
  const found: ArchivedChat[] = [];
  for (const view of views) {
    for (const project of view.projects) {
      if (project.hidden) continue;
      const copy = view.copies.get(project.path);
      if (copy) found.push(...archivedOf(view, project, copy));
    }
  }
  return found.sort((a, b) => startedAt(b.chat) - startedAt(a.chat) || (b.chat.summary?.lastAt ?? 0) - (a.chat.summary?.lastAt ?? 0));
}
