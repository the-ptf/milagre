import { PARADISE_NAME } from "@milagre/shared/prompt-parts";
import { useEffect, useRef } from "react";
import { ComputerTerminal01Icon, FileDiffIcon, Globe02Icon, GitPullRequestIcon, PaintBoardIcon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { chatOf, closeTab, keepListedChats, openTab, subchatAnchor, tabForDigit, tabId, type OpenTab, type TabSet } from "@milagre/shared/workspace-tabs";
import type { AgentSession } from "../../model";
import { sessionIdFromKey } from "../../lib/agent-runs";
import { addressText, chatBrowser, openedByAgent, useAllChatBrowsers } from "../../lib/browser-panel";
import { chatTerminals } from "../../lib/terminal-store";
import { hostTabs, onTabRequest, setStage } from "../../lib/workspace-stage";
import { isModalOpen } from "../../lib/modal";
import { tabSet, updateTabSet } from "../../lib/workspace-tabs-store";
import type { SidePanel } from "./PanelToggles";

export type TabPanels = { changes?: SidePanel; pullRequest?: SidePanel & { number: number } };

/** What the tabs read of a Chat: a local Chat or a Link Chat. */
export type TabSession = Pick<AgentSession, "id" | "parent" | "archived"> & { worktree_id?: AgentSession["worktree_id"] };

type Sources = {
  workspace: string;
  projectPath: string;
  sessions: Record<string, TabSession> | undefined;
  belongs: (session: TabSession) => boolean;
  set: TabSet;
  activeChatId: number | null;
  panels: TabPanels;
  onOpenChat: (chatId: number) => void;
  onFocus: (tab: OpenTab) => void;
};

const KIND_ICON: Record<Exclude<OpenTab["kind"], "chat">, IconSvgElement> = {
  browser: Globe02Icon,
  designs: PaintBoardIcon,
  terminal: ComputerTerminal01Icon,
  diff: FileDiffIcon,
  pr: GitPullRequestIcon,
};

export const pageIcon = (tab: OpenTab) => (tab.kind === "chat" ? undefined : KIND_ICON[tab.kind]);

/** A page tab's name: the Browser page's title or address, the design page, the Terminal, Changes or the PR. */
export function pageLabel(projectPath: string, tab: OpenTab): string {
  const chatKey = "chatId" in tab ? `${projectPath}#${tab.chatId}` : null;
  switch (tab.kind) {
    case "browser": {
      const page = chatKey ? chatBrowser(chatKey).tabs.find((item) => item.id === tab.pageId) : undefined;
      return page?.title || (page && page.url !== "about:blank" ? addressText(page.url) : "New page");
    }
    case "designs":
      return tab.page === "canvas" ? PARADISE_NAME : tab.page === "page" ? "Artifact" : "Design library";
    case "terminal":
      return (chatKey && chatTerminals(chatKey).terminals.find((terminal) => terminal.id === tab.terminalId)?.title) || "Terminal";
    case "diff":
      return "Changes";
    case "pr":
      return `Pull request #${tab.number}`;
    default:
      return "Chat";
  }
}

/**
 * What feeds the strip besides the open Chat: the Browser pages of the Worktree's Chats (the Browser panel's store is
 * their source, so a page the agent opens lands as an unread tab), what the panels ask for, the stage the panels follow,
 * and the Changes or PR panel while its tab is in front.
 */
export function useWorkspaceTabSources({ workspace, projectPath, sessions, belongs, set, activeChatId, panels, onOpenChat, onFocus }: Sources) {
  const latest = useRef({ sessions, belongs, activeChatId, onOpenChat, onFocus });
  latest.current = { sessions, belongs, activeChatId, onOpenChat, onFocus };
  const ownChat = (chatKey: string) => {
    if (!chatKey.startsWith(`${projectPath}#`)) return undefined;
    const chatId = sessionIdFromKey(chatKey);
    const session = latest.current.sessions?.[chatId];
    return session && !session.archived && latest.current.belongs(session) ? chatId : undefined;
  };

  useEffect(() => hostTabs(), []);

  useEffect(() => {
    if (!sessions) return;
    const parentOf = (chatId: number) => sessions[chatId]?.parent;
    updateTabSet(workspace, (current) => {
      let next = keepListedChats(current, (chatId) => {
        const session = sessions[chatId];
        return Boolean(session && !session.archived && belongs(session));
      });
      const session = activeChatId === null ? undefined : sessions[activeChatId];
      if (activeChatId === null || !session || session.archived || !belongs(session)) return next;
      const shown = next.tabs.find((tab) => tabId(tab) === next.active);
      const page = shown && shown.kind !== "chat" && chatOf(shown) === activeChatId;
      const after = session.parent === undefined ? undefined : subchatAnchor(next, session.parent, parentOf);
      next = openTab(next, { kind: "chat", chatId: activeChatId }, page ? { focus: false, unread: false, after } : { after });
      return next;
    });
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- belongs reads the same sessions
  }, [workspace, activeChatId, sessions]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isModalOpen() || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (!/^[1-9]$/.test(event.key)) return;
      const tab = tabForDigit(tabSet(workspace), Number(event.key));
      if (!tab) return;
      event.preventDefault();
      latest.current.onFocus(tab);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [workspace]);

  const browsers = useAllChatBrowsers();
  const seen = useRef(new Set<string>());
  useEffect(() => {
    if (!sessions) return;
    let focused: number | undefined;
    updateTabSet(workspace, (current) => {
      let next = current;
      const pages = new Set<string>();
      const owners = new Set<number>();
      for (const [chatKey, chat] of browsers) {
        const chatId = ownChat(chatKey);
        if (chatId === undefined) continue;
        owners.add(chatId);
        for (const page of chat.tabs) {
          const tab = { kind: "browser" as const, chatId, pageId: page.id };
          const id = tabId(tab);
          pages.add(id);
          if (next.tabs.some((open) => tabId(open) === id)) continue;
          const settled = seen.current.has(workspace);
          const focus = settled && chat.open && chat.active === page.id && !openedByAgent(page.id);
          next = openTab(next, tab, settled ? { focus } : { focus: false, unread: false });
          if (focus) focused = chatId;
        }
      }
      for (const open of next.tabs) if (open.kind === "browser" && owners.has(open.chatId) && !pages.has(tabId(open))) next = closeTab(next, tabId(open));
      return next;
    });
    seen.current.add(workspace);
    if (focused !== undefined && focused !== latest.current.activeChatId) latest.current.onOpenChat(focused);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- ownChat reads the latest sessions through a ref
  }, [browsers, sessions, workspace]);

  useEffect(
    () =>
      onTabRequest((request) => {
        const chatId = ownChat(request.chatKey);
        if (chatId === undefined) return;
        if ("close" in request) {
          updateTabSet(workspace, (current) => closeTab(current, tabId(request.close)));
          return;
        }
        updateTabSet(workspace, (current) => openTab(current, request.tab, { focus: request.focus }));
        if (request.focus && chatId !== latest.current.activeChatId) latest.current.onOpenChat(chatId);
      }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- ownChat reads the latest sessions through a ref
    [workspace, projectPath],
  );

  const active = activeChatId === null ? undefined : set.tabs.find((tab) => tabId(tab) === set.active);
  const owner = active ? chatOf(active) : undefined;
  const stageKey = active && active.kind !== "chat" && (owner === undefined || owner === activeChatId) ? JSON.stringify(active) : null;
  useEffect(() => {
    if (!stageKey) return setStage(null);
    const { unread: _unread, beside, ...tab } = JSON.parse(stageKey) as OpenTab;
    const chat = chatOf(tab);
    setStage({ chatKey: chat === undefined ? null : `${projectPath}#${chat}`, tab, beside: Boolean(beside) });
  }, [stageKey, projectPath]);
  useEffect(() => () => setStage(null), []);

  const showing = active?.kind === "diff" ? "changes" : active?.kind === "pr" ? "pullRequest" : null;
  const shown = useRef<typeof showing>(null);
  useEffect(() => {
    const before = shown.current;
    shown.current = showing;
    if (before && before !== showing && panels[before]?.open) panels[before]!.toggle();
    if (showing && !panels[showing]?.open) panels[showing]?.toggle();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- follows the tab in front; the panels' toggles change every render
  }, [showing]);
}
