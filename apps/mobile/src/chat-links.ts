import {
  LINK_PROBLEM_LABEL,
  findLink,
  linkAskMessage,
  linkEndpoints,
  linkProblem,
  linkedEndLabel,
  linkedEnds,
  type CanvasLink,
  type LinkEnd,
  type LinkScope,
  type LinkWorktree,
} from "@milagre/shared/chat-links";
import type { RegisteredProject } from "./client";
import type { MenuSection } from "./ui";

export type LinkChat = {
  projectPath: string;
  projectName: string;
  projectId: string;
  chatId: number;
  title: string;
  branch?: string;
  worktreePath: string;
};
export type LinkChoice = { scope: LinkScope; grant: boolean; text: string };
type Call = <T>(method: string, args: unknown[]) => Promise<T>;

export const linkChatKey = (chat: Pick<LinkChat, "projectPath" | "chatId">) => `${chat.projectPath}#${chat.chatId}`;
export const linkWorktree = (chat: Pick<LinkChat, "projectId" | "worktreePath">): LinkWorktree => ({
  project_id: chat.projectId,
  worktree_path: chat.worktreePath,
});

export function endNamer(projects: readonly RegisteredProject[], branchOf: (projectPath: string, worktreePath: string) => string | undefined) {
  return (end: LinkEnd) => {
    const project = projects.find((item) => item.id === end.project_id);
    return {
      project: project?.name,
      branch: project && end.worktree_path !== undefined ? branchOf(project.path, end.worktree_path) : undefined,
    };
  };
}

export function linkedLabels(links: readonly CanvasLink[], worktree: LinkWorktree | undefined, names: ReturnType<typeof endNamer>) {
  if (!worktree) return [];
  return linkedEnds(links, worktree).map(({ link, other }) => ({ link, label: linkedEndLabel(other, names(other)) }));
}

export const linkedAccessibilityLabel = (labels: readonly string[]) => `Linked to ${labels.join(", ")}`;

export function linkMenuSection({ available, worktreePath, linked }: { available: boolean; worktreePath?: string; linked: number }): MenuSection | null {
  if (!available || !worktreePath) return null;
  return {
    items: [
      { id: "link-with", title: "Link with…", systemImage: "link" },
      ...(linked > 0 ? [{ id: "link-remove", title: "Remove Link with…", systemImage: "xmark.circle" }] : []),
    ],
  };
}

export function linkPickerItems(links: readonly CanvasLink[], source: LinkChat, chats: readonly LinkChat[]) {
  const sourceKey = linkChatKey(source);
  return chats
    .filter((chat) => linkChatKey(chat) !== sourceKey)
    .map((chat) => {
      const problem = linkProblem(links, linkWorktree(source), linkWorktree(chat));
      const where = [chat.projectName, chat.branch].filter(Boolean).join(" / ");
      const item: { id: string; title: string; subtitle: string; keywords: string; disabled?: boolean } = {
        id: linkChatKey(chat),
        title: chat.title,
        subtitle: problem ? `${where} · ${LINK_PROBLEM_LABEL[problem]}` : where,
        keywords: where,
      };
      if (problem) item.disabled = true;
      return item;
    });
}

export const linkSummary = (source: LinkChat, target: LinkChat, scope: LinkScope = "worktrees") =>
  scope === "projects" ? `${source.projectName} ⇄ ${target.projectName}` : `${source.branch || source.title} ⇄ ${target.branch || target.title}`;
export const projectsScopeSubtitle = (source: LinkChat, target: LinkChat) => `Every Worktree of ${source.projectName} and ${target.projectName}, new ones too`;
export const createLinkTitle = (text: string) => (text.trim() ? "Create Link and ask" : "Create Link");

export async function createChatLink({
  call,
  source,
  target,
  choice,
  send,
}: {
  call: Call;
  source: LinkChat;
  target: LinkChat;
  choice: LinkChoice;
  send: (message: { body: string; prompt: string }) => Promise<unknown>;
}): Promise<{ links: CanvasLink[] | null; notice: string }> {
  const [a, b] = linkEndpoints(linkWorktree(source), linkWorktree(target), choice.scope);
  let links: CanvasLink[];
  try {
    links = await call<CanvasLink[]>("canvas:link-add", [a, b]);
  } catch (error) {
    return { links: null, notice: `Could not create the Link: ${(error as Error).message}` };
  }
  const link = Array.isArray(links) ? findLink(links, a, b) : undefined;
  if (choice.grant && link) {
    try {
      await call("linked:grant", [linkChatKey(source), link.id]);
    } catch (error) {
      return { links, notice: `Link created. Could not always allow Delegations: ${(error as Error).message}` };
    }
  }
  const text = choice.text.trim();
  if (!text) return { links, notice: "Link created" };
  try {
    await send(
      linkAskMessage(text, {
        label: target.title,
        chatRef: linkChatKey(target),
        worktreePath: target.worktreePath,
        projectName: target.projectName,
        branch: target.branch,
      }),
    );
  } catch (error) {
    return { links, notice: `Link created. Could not ask “${source.title}”: ${(error as Error).message}` };
  }
  return { links, notice: `Link created. Asked “${source.title}”.` };
}

export const REMOVE_LINK = {
  title: "Remove this Link?",
  message: "Chats on both sides stop seeing each other and can't make Delegations along it.",
  action: "Remove",
} as const;

export async function removeChatLink(call: Call, linkId: string): Promise<{ links: CanvasLink[] | null; notice: string }> {
  try {
    return { links: await call<CanvasLink[]>("canvas:link-remove", [linkId]), notice: "Link removed" };
  } catch (error) {
    return { links: null, notice: `Could not remove the Link: ${(error as Error).message}` };
  }
}

export const linkNoticeIsProblem = (notice: string) => notice.includes("Could not");
