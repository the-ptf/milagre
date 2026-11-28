import { ComputerTerminal01Icon, FileDiffIcon, Globe02Icon, GitPullRequestIcon } from "@hugeicons/core-free-icons";
import { PARADISE_NAME } from "@milagre/shared/prompt-parts";
import { chatBookmark } from "@milagre/shared/subchats";
import { tabWorktree, workspaceKey } from "@milagre/shared/workspace-tabs";
import { fullChatTitle } from "../../lib/chat-list";
import { shortcutLabel, useKeybindings } from "../../lib/keybindings";
import { useSettings } from "../../lib/settings";
import type { AgentSession, ChatMessage } from "../../model";
import type { SidebarRecent } from "../sidebar/ChatRow";
import type { SubchatSource } from "../../lib/subchat-track";
import { ChatIdentity } from "./ChatIdentity";
import { useDesignOffer } from "./designs-stage";
import { useSidePanels, type SidePanel } from "./PanelToggles";
import { SubchatBookmark } from "./SubchatBookmark";
import { designPageIcon } from "./use-workspace-tab-sources";
import { WorkspaceTabStrip, type TabMenuEntry } from "./WorkspaceTabStrip";

type Family = Omit<SubchatSource, "parentKey" | "runs"> & {
  onOpen: (key: string) => void;
  onBeside: (parent: string) => void;
  onShowAll: () => void;
};

type Tabs = {
  state: { sessions: Record<string, AgentSession>; worktrees: Record<string, { id: number; path: string }> } | null;
  worktree: number | undefined;
  rows: readonly SidebarRecent[];
  panels: { changes?: SidePanel; pullRequest?: SidePanel & { number: number } };
  onOpen: (chatId: number) => void;
  onStart: (worktreeId: number) => void;
};

/**
 * What the top bar shows for the open Chat: the Worktree's Workspace tabs when that setting is on, otherwise the Chat's
 * title (ChatIdentity) or, for a Subchat, its way up (SubchatBookmark).
 */
export function ChatTopBar({
  shown,
  projectPath,
  chatKey,
  session,
  messages,
  project,
  corner,
  family,
  tabs,
}: {
  shown: boolean;
  projectPath: string;
  chatKey: string | null;
  session: AgentSession | null | undefined;
  messages: readonly ChatMessage[];
  project?: string;
  corner: number;
  family: Family;
  tabs: Tabs;
}) {
  const { workspaceTabs } = useSettings();
  const menu = useTabMenu(tabs.panels, projectPath, session?.id ?? null);
  if (!shown) return null;
  const worktreeId = session ? session.worktree_id : tabs.worktree;
  if (workspaceTabs && worktreeId !== null && worktreeId !== undefined) {
    const keyOf = (id: number | undefined, chatId: number) => workspaceKey(projectPath, tabWorktree(projectPath, tabs.state?.worktrees[id ?? -1]), chatId);
    const workspace = keyOf(worktreeId, session?.id ?? -1);
    return (
      <WorkspaceTabStrip
        workspace={workspace}
        projectPath={projectPath}
        panels={tabs.panels}
        sessions={tabs.state?.sessions}
        belongs={(other) => keyOf(other.worktree_id, other.id) === workspace}
        rows={tabs.rows}
        activeChatId={session?.id ?? null}
        corner={corner}
        menu={menu}
        onOpenChat={tabs.onOpen}
        onNewChat={() => tabs.onStart(worktreeId)}
      />
    );
  }
  if (!chatKey || !session) return null;
  if (chatBookmark(family.sessions, chatKey))
    return (
      <SubchatBookmark
        chatKey={chatKey}
        reads={{ sessions: family.sessions, work: family.work }}
        corner={corner}
        onOpen={family.onOpen}
        onBeside={family.onBeside}
        onShowAll={family.onShowAll}
      />
    );
  return <ChatIdentity title={fullChatTitle(session, messages)} project={project} corner={corner} />;
}

/** What a New tab offers besides a New Chat: the open Chat's Terminal and Browser, the Diff and PR, and its designs. */
export function useTabMenu(panels: Tabs["panels"], projectPath: string, chatId: number | null): TabMenuEntry[] {
  const shown = useSidePanels();
  const { rules } = useKeybindings();
  const designs = useDesignOffer(chatId === null ? null : `${projectPath}#${chatId}`);
  const entries: (TabMenuEntry | null)[] = [
    shown.terminal
      ? { key: "terminal", title: "Terminal", icon: ComputerTerminal01Icon, shortcut: shortcutLabel(rules, "terminal.toggle"), onSelect: shown.terminal.toggle }
      : null,
    shown.browser
      ? { key: "browser", title: "Browser", icon: Globe02Icon, shortcut: shortcutLabel(rules, "browser.toggle"), onSelect: shown.browser.toggle }
      : null,
    panels.changes
      ? {
          key: "diff",
          title: "Diff",
          icon: FileDiffIcon,
          shortcut: shortcutLabel(rules, "changes.toggle"),
          tab: { kind: "diff" },
          onSelect: panels.changes.toggle,
        }
      : null,
    panels.pullRequest
      ? {
          key: "pr",
          title: `Pull request #${panels.pullRequest.number}`,
          icon: GitPullRequestIcon,
          tab: { kind: "pr", number: panels.pullRequest.number },
          onSelect: panels.pullRequest.toggle,
        }
      : null,
    chatId !== null && designs && designs.designs !== null
      ? {
          key: "canvas",
          title: PARADISE_NAME,
          icon: designPageIcon("canvas"),
          detail: designs.designs ? `${designs.designs} design${designs.designs === 1 ? "" : "s"}` : undefined,
          tab: { kind: "designs", chatId, page: "canvas" },
        }
      : null,
    chatId !== null && designs && designs.page !== null
      ? { key: "page", title: "Artifact", icon: designPageIcon("page"), detail: designs.page || undefined, tab: { kind: "designs", chatId, page: "page" } }
      : null,
  ];
  return entries.filter((entry): entry is TabMenuEntry => entry !== null);
}
