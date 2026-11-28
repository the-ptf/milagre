import { useEffect } from "react";
import { Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { router } from "expo-router";
import { BubbleChatIcon, Cancel01Icon, ComputerTerminal01Icon, CornerDownRightIcon, Globe02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { chatTitle, isHiddenRunChat, isHiddenTaskChat } from "@milagre/shared/chats";
import type { AgentSession } from "@milagre/shared/model";
import {
  chatCloseAction,
  closeOtherTabs,
  closeTab,
  keepListedChats,
  MAIN_CHAT_CLOSE_TITLE,
  mainChatCloseMessage,
  moveTab,
  NEW_TAB_LABEL,
  newChatTabLabel,
  openTab,
  RUNNING_CHAT_CLOSE_TITLE,
  runningChatCloseMessage,
  subchatAnchor,
  tabId,
  tabStripShown,
  withLoneChatTabs,
  type OpenTab,
  type TabPlace,
} from "@milagre/shared/workspace-tabs";
import { OPEN_ARTIFACT, OPEN_PARADISE } from "./artifact-pages";
import { useArtifactShortcuts } from "./chat-artifact-shortcuts";
import { closeTabIntoDone } from "./chat-done";
import { useHeaderStripWidth } from "./chat-header";
import type { ChatTab, DesignsTab } from "./panel-tabs";
import { rightDocks } from "./split-width";
import { confirm } from "./confirm-store";
import { lineHeight, radius, space, type } from "./design-tokens";
import { Icon } from "./icons";
import { chatMark } from "./indicators";
import { useSession } from "./session";
import { ChatMarkIcon } from "./status-indicators";
import { useTheme } from "./theme";
import { IconButton, PullDown, tap, type MenuSection } from "./ui";
import { inScope, LINK_TABS, scopeKey, scopeWorktree, tabScope, type TabScope } from "./workspace-tabs-kinds";
import { tabSet, updateTabSet, useTabSet } from "./workspace-tabs-store";

type Where = { hostId: string; projectPath: string; worktreeId: TabScope };

/** The Chat route's `via` param when a Workspace tab opened it: the Chat swaps in place, without the push animation. */
export const TAB_SWITCH = "tab";

const placeOf = (where: Where): TabPlace => (where.worktreeId === LINK_TABS ? "link" : "worktree");

const phoneWorkspace = (where: Where) => `${where.hostId}|${scopeKey(where.projectPath, where.worktreeId)}`;

/** Keeps the open Chat's tab in its Worktree's tab set, and drops tabs of Chats that are gone or moved away. */
/** Keeps the Worktree's tabs in step with its Chats; returns where the header shows them, null for a new Chat drafted where no tab is open. */
export function useWorkspaceTabSync(
  enabled: boolean,
  where: Where | null,
  sessions: Record<string, AgentSession> | undefined,
  chatId: number | undefined,
): Where | null {
  const set = useTabSet(where ? phoneWorkspace(where) : null);
  const hostId = where?.hostId;
  const projectPath = where?.projectPath;
  const worktreeId = where?.worktreeId;
  useEffect(() => {
    if (!enabled || hostId === undefined || projectPath === undefined || worktreeId === undefined || !sessions) return;
    const parentOf = (id: number) => sessions[id]?.parent;
    updateTabSet(phoneWorkspace({ hostId, projectPath, worktreeId }), (current) => {
      const members = Object.values(sessions).filter((session) => !session.archived && inScope(session, worktreeId));
      let next = keepListedChats(current, (id) => members.some((member) => member.id === id && (!member.done_at || id === chatId)));
      next = withLoneChatTabs(next, members, (id) => !isHiddenRunChat(sessions[id]!, false) && !isHiddenTaskChat(sessions[id]!));
      const session = chatId === undefined ? undefined : sessions[chatId];
      if (chatId !== undefined && session && !session.archived && inScope(session, worktreeId)) {
        const after = session.parent === undefined ? undefined : subchatAnchor(next, session.parent, parentOf);
        next = openTab(next, { kind: "chat", chatId }, { after });
      }
      return next;
    });
  }, [enabled, hostId, projectPath, worktreeId, sessions, chatId]);
  return where && tabStripShown(set, chatId === undefined) ? where : null;
}

function useTabs(where: Where, activeChatId: number | undefined, onDone?: () => void, openArtifact?: (target: DesignsTab) => void) {
  const session = useSession();
  const artifacts = useArtifactShortcuts(session.client, where.projectPath, activeChatId === undefined ? undefined : String(activeChatId), openArtifact);
  const workspace = phoneWorkspace(where);
  const set = useTabSet(workspace);
  const sessions = session.snapshot?.project.path === where.projectPath ? session.snapshot.project.state.sessions : undefined;
  const runs = session.snapshot?.runs.runs;
  const chatOf = (tab: OpenTab) => (tab.kind === "chat" ? sessions?.[tab.chatId] : undefined);
  const sheet = (pathname: "/browser-sheet" | "/terminal-sheet", chatId: number) =>
    router.push({ pathname, params: { hostId: where.hostId, chatId: `${where.projectPath}#${chatId}` } });
  const open = (tab: OpenTab) => {
    if (tab.kind === "new") return;
    onDone?.();
    if (tab.kind === "browser") sheet("/browser-sheet", tab.chatId);
    else if (tab.kind === "terminal") sheet("/terminal-sheet", tab.chatId);
    else if (tab.kind === "chat" && tab.chatId !== activeChatId)
      router.replace({ pathname: "/chat", params: { hostId: where.hostId, projectPath: where.projectPath, id: String(tab.chatId), via: TAB_SWITCH } });
  };
  const newChat = () => {
    onDone?.();
    const worktree = scopeWorktree(where.worktreeId, sessions);
    router.replace({
      pathname: "/chat",
      params: { hostId: where.hostId, projectPath: where.projectPath, via: TAB_SWITCH, ...(worktree === undefined ? {} : { worktreeId: String(worktree) }) },
    });
  };
  const launch = (id: string, onPanel?: (tab: "changes" | "pr") => void) => {
    if (id === "chat") newChat();
    else if (id === OPEN_PARADISE || id === OPEN_ARTIFACT) {
      if (!openArtifact) onDone?.();
      artifacts.select(id);
    } else if ((id === "terminal" || id === "browser") && activeChatId !== undefined) {
      onDone?.();
      sheet(id === "browser" ? "/browser-sheet" : "/terminal-sheet", activeChatId);
    } else if (id === "changes" || id === "pr") onPanel?.(id);
  };
  const shut = (id: string) => {
    const after = closeTab(tabSet(workspace), id);
    updateTabSet(workspace, () => after);
    if (id !== `chat:${activeChatId}`) return;
    const next = after.tabs.find((tab) => tabId(tab) === after.active);
    if (next) open(next);
    else newChat();
  };
  const close = async (id: string) => {
    const closing = set.tabs.find((tab) => tabId(tab) === id);
    const chat = closing && chatOf(closing);
    const running = !!chat && !!runs?.[`${where.projectPath}#${chat.id}`];
    const how = chat
      ? chatCloseAction(
          chat.id,
          Object.values(sessions ?? {}).filter((other) => inScope(other, where.worktreeId)),
          running,
        )
      : "close";
    const title = chat ? chatTitle(chat) : "Chat";
    if (how === "confirm-main" && !(await confirm(MAIN_CHAT_CLOSE_TITLE, mainChatCloseMessage(title, placeOf(where)), "Close tab"))) return;
    if (how === "confirm-done" && !(await confirm(RUNNING_CHAT_CLOSE_TITLE, runningChatCloseMessage(title), "Close tab"))) return;
    shut(id);
    if (!chat || (how !== "done" && how !== "confirm-done") || !session.client) return;
    const tab = (reopen: boolean) =>
      updateTabSet(workspace, (current) =>
        reopen ? openTab(current, { kind: "chat", chatId: chat.id }, { focus: false, unread: false }) : closeTab(current, id),
      );
    void closeTabIntoDone({ client: session.client, projectPath: where.projectPath, chatId: chat.id, running, tab });
  };
  const choose = (tab: OpenTab, choice: string) => {
    const id = tabId(tab);
    const at = set.tabs.findIndex((other) => tabId(other) === id);
    if (choice === "close") void close(id);
    else if (choice === "others") updateTabSet(workspace, (current) => closeOtherTabs(current, id));
    else if (choice === "up") updateTabSet(workspace, (current) => moveTab(current, id, at - 1));
    else if (choice === "down") updateTabSet(workspace, (current) => moveTab(current, id, at + 1));
    else if (choice === "parent" && tab.kind === "chat" && sessions?.[tab.chatId]?.parent !== undefined)
      open({ kind: "chat", chatId: sessions[tab.chatId]!.parent! });
  };
  const menu = (tab: OpenTab, index: number): MenuSection[] => [
    ...(chatOf(tab)?.parent !== undefined ? [{ items: [{ id: "parent", title: "Go to parent Chat", systemImage: "arrow.turn.left.up" }] }] : []),
    {
      items: [
        { id: "up", title: "Move up", systemImage: "arrow.up", disabled: index === 0 },
        { id: "down", title: "Move down", systemImage: "arrow.down", disabled: index === set.tabs.length - 1 },
      ],
    },
    {
      items: [
        { id: "close", title: "Close tab", systemImage: "xmark" },
        { id: "others", title: "Close other tabs", systemImage: "square.stack" },
      ],
    },
  ];
  const describe = (tab: OpenTab) => {
    const chat = chatOf(tab);
    const owner = "chatId" in tab ? sessions?.[tab.chatId] : undefined;
    const page = tab.kind === "browser" ? "Browser" : tab.kind === "terminal" ? "Terminal" : tab.kind === "new" ? NEW_TAB_LABEL : null;
    const title = page ?? (chat ? chatTitle(chat) : "Chat");
    const mark = chat ? chatMark(chat, runs?.[`${where.projectPath}#${chat.id}`]) : "idle";
    return {
      title,
      detail: page && owner ? chatTitle(owner) : null,
      icon: tab.kind === "browser" ? Globe02Icon : tab.kind === "terminal" ? ComputerTerminal01Icon : tab.kind === "new" ? PlusSignIcon : null,
      mark,
      subchat: chat?.parent !== undefined,
      unread: Boolean(tab.unread || chat?.unread),
    };
  };
  return { set, open, launch, close, choose, menu, describe, pages: artifacts.items };
}

/** What + opens in a tab set, as the computer's New tab lists it: a New Chat, the open Chat's Terminal and Browser, and the panels this Chat has. */
function launcher(place: TabPlace | null, can: { owner: boolean; changes?: boolean; pr?: number; pages?: MenuSection["items"] }): MenuSection[] {
  const open = [
    ...(place ? [{ id: "chat", title: newChatTabLabel(place), systemImage: "square.and.pencil" }] : []),
    ...(can.owner
      ? [
          { id: "terminal", title: "Terminal", systemImage: "apple.terminal" },
          { id: "browser", title: "Browser", systemImage: "globe" },
        ]
      : []),
  ];
  const panels = [
    ...(can.changes ? [{ id: "changes", title: "Diff", systemImage: "plus.forwardslash.minus" }] : []),
    ...(can.pr !== undefined ? [{ id: "pr", title: `Pull request #${can.pr}`, systemImage: "arrow.triangle.pull" }] : []),
    ...(can.pages ?? []),
  ];
  return [open, panels].filter((items) => items.length).map((items) => ({ items }));
}

function NewTabButton({ sections, onSelect }: { sections: MenuSection[]; onSelect: (id: string) => void }) {
  if (!sections.length) return null;
  return (
    <PullDown label={NEW_TAB_LABEL} sections={sections} onSelect={onSelect}>
      <View style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
        <Icon icon={PlusSignIcon} tone="ink" size={20} />
      </View>
    </PullDown>
  );
}

type PanelScreen = { chatId?: number; worktreeId?: number; pullRequest?: { number: number } };

export function WorkspaceTabsView({
  screen,
  onDone,
  onPanel,
  onArtifact,
}: {
  screen: PanelScreen;
  onDone: () => void;
  onPanel: (tab: "changes" | "pr") => void;
  /** Opens Paradise or the Artifact as a tab of this panel where it docks beside the Chat; elsewhere they open full screen. */
  onArtifact?: (tab: ChatTab) => void;
}) {
  const { colors } = useTheme();
  const session = useSession();
  const project = session.snapshot?.project;
  const worktree = screen.worktreeId === undefined ? undefined : String(screen.worktreeId);
  const scope = tabScope(project, screen.chatId, worktree) ?? tabScope(project, undefined, worktree);
  const panels = { changes: screen.worktreeId !== undefined, pr: screen.pullRequest?.number };
  if (!session.client || !project) return null;
  if (scope !== undefined)
    return (
      <WorkspaceTabsList
        where={{ hostId: session.client.url, projectPath: project.path, worktreeId: scope }}
        activeChatId={screen.chatId}
        panels={panels}
        onDone={onDone}
        onPanel={onPanel}
        onArtifact={onArtifact}
      />
    );
  return (
    <View style={{ padding: space.gutter, flexDirection: "row", alignItems: "center" }}>
      <Text style={{ flex: 1, paddingLeft: space.xs, color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>
        Tabs open once this Chat is sent
      </Text>
      <NewTabButton sections={launcher(null, { owner: false, ...panels })} onSelect={(id) => onPanel(id as "changes" | "pr")} />
    </View>
  );
}

/** The phone's right panel Tabs view: the Worktree's open tabs as rows, and + for a new one. */
function WorkspaceTabsList({
  where,
  activeChatId,
  panels,
  onDone,
  onPanel,
  onArtifact,
}: {
  where: Where;
  activeChatId: number | undefined;
  panels: { changes: boolean; pr?: number };
  onDone: () => void;
  onPanel: (tab: "changes" | "pr") => void;
  onArtifact?: (tab: ChatTab) => void;
}) {
  const { colors } = useTheme();
  const docks = rightDocks(useWindowDimensions().width);
  const tabs = useTabs(where, activeChatId, onDone, docks && onArtifact ? (target) => onArtifact({ kind: "designs", target }) : undefined);
  return (
    <ScrollView contentContainerStyle={{ padding: space.gutter, gap: space.md }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: space.xs }}>
        <Text style={{ flex: 1, color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>{`${tabs.set.tabs.length} open`}</Text>
        <NewTabButton
          sections={launcher(placeOf(where), { owner: activeChatId !== undefined, ...panels, pages: tabs.pages })}
          onSelect={(id) => tabs.launch(id, onPanel)}
        />
      </View>
      <View
        style={{
          borderRadius: radius.card,
          borderCurve: "continuous",
          overflow: "hidden",
          backgroundColor: colors.surface,
          borderWidth: 0.5,
          borderColor: colors.line,
        }}
      >
        {tabs.set.tabs.map((tab, index) => {
          const shown = tabs.describe(tab);
          const active = tab.kind === "chat" && tab.chatId === activeChatId;
          return (
            <View
              key={tabId(tab)}
              style={{
                minHeight: 56,
                flexDirection: "row",
                alignItems: "center",
                paddingRight: space.sm,
                backgroundColor: active ? colors.hover2 : "transparent",
                borderTopWidth: index ? 0.5 : 0,
                borderTopColor: colors.line,
              }}
            >
              <PullDown
                label={shown.title}
                sections={tabs.menu(tab, index)}
                onSelect={(choice) => tabs.choose(tab, choice)}
                onPress={() => tabs.open(tab)}
                style={{ flex: 1, alignSelf: "stretch" }}
              >
                <View
                  accessibilityState={{ selected: active }}
                  style={{
                    minHeight: 56,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: space.lg,
                    paddingLeft: shown.subchat ? 36 : space.gutter,
                    paddingRight: space.sm,
                  }}
                >
                  {shown.subchat && (
                    <View style={{ position: "absolute", left: 12 }}>
                      <Icon icon={CornerDownRightIcon} tone="ink4" size={16} />
                    </View>
                  )}
                  {shown.icon ? (
                    <Icon icon={shown.icon} tone="ink2" size={20} />
                  ) : shown.mark === "idle" || shown.mark === "unread" ? (
                    <Icon icon={BubbleChatIcon} tone="ink2" size={20} />
                  ) : (
                    <ChatMarkIcon mark={shown.mark} />
                  )}
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text
                      numberOfLines={1}
                      style={{ color: colors.ink, fontSize: type.callout, lineHeight: lineHeight.callout, fontWeight: active ? "600" : "400" }}
                    >
                      {shown.title}
                    </Text>

                    {shown.detail && (
                      <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>
                        {shown.detail}
                      </Text>
                    )}
                  </View>
                  {shown.unread && !active && <View style={{ width: 8, height: 8, borderRadius: radius.full, backgroundColor: colors.accent }} />}
                </View>
              </PullDown>
              <IconButton label={`Close ${shown.title}`} icon={Cancel01Icon} size={36} tone="ink3" onPress={() => void tabs.close(tabId(tab))} />
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

/** The iPad's tabs, in the Chat header where the title is: tap to switch, long-press for the tab's menu. */
export function WorkspaceTabStrip({ where, activeChatId, actionCount }: { where: Where; activeChatId: number | undefined; actionCount: number }) {
  const { colors } = useTheme();
  const width = useHeaderStripWidth(actionCount);
  const tabs = useTabs(where, activeChatId);
  return (
    <View style={{ width, flexDirection: "row", alignItems: "center" }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.xs, alignItems: "center" }} style={{ flex: 1 }}>
        {tabs.set.tabs.map((tab, index) => {
          const shown = tabs.describe(tab);
          const active = tab.kind === "chat" && tab.chatId === activeChatId;
          return (
            <View
              key={tabId(tab)}
              style={{
                height: 36,
                maxWidth: 220,
                flexDirection: "row",
                alignItems: "center",
                paddingRight: active ? space.xs : 0,
                borderRadius: radius.control,
                borderCurve: "continuous",
                backgroundColor: active ? colors.hover2 : "transparent",
              }}
            >
              <PullDown
                label={shown.title}
                sections={tabs.menu(tab, index)}
                onSelect={(choice) => tabs.choose(tab, choice)}
                onPress={() => tabs.open(tab)}
                style={{ flexShrink: 1, alignSelf: "stretch" }}
              >
                <View
                  accessibilityState={{ selected: active }}
                  style={{
                    height: 36,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: space.sm,
                    paddingLeft: space.lg,
                    paddingRight: active ? space.sm : space.lg,
                  }}
                >
                  {shown.subchat && <Icon icon={CornerDownRightIcon} tone="ink4" size={12} />}
                  {shown.icon ? (
                    <Icon icon={shown.icon} tone="ink2" size={16} />
                  ) : shown.mark === "idle" || shown.mark === "unread" ? (
                    <Icon icon={BubbleChatIcon} tone="ink2" size={16} />
                  ) : (
                    <ChatMarkIcon mark={shown.mark} />
                  )}
                  <Text
                    numberOfLines={1}
                    style={{
                      flexShrink: 1,
                      color: active ? colors.ink : colors.ink2,
                      fontSize: type.subheadline,
                      lineHeight: lineHeight.subheadline,
                      fontWeight: "500",
                    }}
                  >
                    {shown.title}
                  </Text>
                  {shown.unread && !active && <View style={{ width: 8, height: 8, borderRadius: radius.full, backgroundColor: colors.accent }} />}
                </View>
              </PullDown>
              {active && <IconButton label={`Close ${shown.title}`} icon={Cancel01Icon} size={32} tone="ink3" onPress={() => void tabs.close(tabId(tab))} />}
            </View>
          );
        })}
      </ScrollView>
      <NewTabButton sections={launcher(placeOf(where), { owner: activeChatId !== undefined, pages: tabs.pages })} onSelect={(id) => tabs.launch(id)} />
    </View>
  );
}

/** The phone header's tab count: a rounded square with the number, and a dot while an unopened tab has news. */
export function TabCountAction({ where, onPress }: { where: Where; onPress: () => void }) {
  const { colors } = useTheme();
  const set = useTabSet(phoneWorkspace(where));
  const count = Math.max(1, set.tabs.length);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Tabs, ${count} open`}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: radius.full,
        backgroundColor: pressed ? colors.hover : "transparent",
      })}
    >
      <View
        style={{
          minWidth: 22,
          height: 22,
          paddingHorizontal: 4,
          borderRadius: radius.chip,
          borderWidth: 1.8,
          borderColor: colors.ink,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Text style={{ color: colors.ink, fontSize: type.caption1, lineHeight: lineHeight.caption1, fontWeight: "600" }}>{count}</Text>
      </View>
    </Pressable>
  );
}
