import { useEffect } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { BubbleChatIcon, Cancel01Icon, ComputerTerminal01Icon, CornerDownRightIcon, Globe02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { chatTitle } from "@milagre/shared/chats";
import type { AgentSession } from "@milagre/shared/model";
import {
  closeOtherTabs,
  closeTab,
  keepListedChats,
  MAIN_CHAT_CLOSE_TITLE,
  mainChatCloseMessage,
  newChatTabLabel,
  type TabPlace,
  mainChatId,
  moveTab,
  openTab,
  subchatAnchor,
  tabId,
  workspaceKey,
  type OpenTab,
} from "@milagre/shared/workspace-tabs";
import { useHeaderStripWidth } from "./chat-header";
import { confirm } from "./confirm-store";
import { lineHeight, radius, space, type } from "./design-tokens";
import { Icon } from "./icons";
import { chatMark } from "./indicators";
import { useSession } from "./session";
import { ChatMarkIcon } from "./status-indicators";
import { useTheme } from "./theme";
import { IconButton, PullDown, tap, type MenuSection } from "./ui";
import { inScope, LINK_TABS, type TabScope } from "./workspace-tabs-kinds";
import { tabSet, updateTabSet, useTabSet } from "./workspace-tabs-store";

type Where = { hostId: string; projectPath: string; worktreeId: TabScope };

const placeOf = (where: Where): TabPlace => (where.worktreeId === LINK_TABS ? "link" : "worktree");

function phoneWorkspace(where: Where, chatId: number) {
  return `${where.hostId}|${workspaceKey(where.projectPath, where.worktreeId, chatId)}`;
}

/** Keeps the open Chat's tab in its Worktree's tab set, and drops tabs of Chats that are gone or moved away. */
export function useWorkspaceTabSync(enabled: boolean, where: Where | null, sessions: Record<string, AgentSession> | undefined, chatId: number | undefined) {
  const hostId = where?.hostId;
  const projectPath = where?.projectPath;
  const worktreeId = where?.worktreeId;
  useEffect(() => {
    if (!enabled || hostId === undefined || projectPath === undefined || worktreeId === undefined || !sessions) return;
    const parentOf = (id: number) => sessions[id]?.parent;
    updateTabSet(phoneWorkspace({ hostId, projectPath, worktreeId }, chatId ?? -1), (current) => {
      let next = keepListedChats(current, (id) => {
        const session = sessions[id];
        return Boolean(session && !session.archived && inScope(session, worktreeId));
      });
      const session = chatId === undefined ? undefined : sessions[chatId];
      if (chatId !== undefined && session && !session.archived && inScope(session, worktreeId)) {
        const after = session.parent === undefined ? undefined : subchatAnchor(next, session.parent, parentOf);
        next = openTab(next, { kind: "chat", chatId }, { after });
      }
      return next;
    });
  }, [enabled, hostId, projectPath, worktreeId, sessions, chatId]);
}

function useTabs(where: Where, activeChatId: number | undefined, onDone?: () => void) {
  const session = useSession();
  const workspace = phoneWorkspace(where, activeChatId ?? -1);
  const set = useTabSet(workspace);
  const sessions = session.snapshot?.project.path === where.projectPath ? session.snapshot.project.state.sessions : undefined;
  const runs = session.snapshot?.runs.runs;
  const chatOf = (tab: OpenTab) => (tab.kind === "chat" ? sessions?.[tab.chatId] : undefined);
  const main = mainChatId(Object.values(sessions ?? {}).filter((chat) => inScope(chat, where.worktreeId)));
  const open = (tab: OpenTab) => {
    onDone?.();
    const chatKey = "chatId" in tab ? `${where.projectPath}#${tab.chatId}` : "";
    if (tab.kind === "browser") router.push({ pathname: "/browser-sheet", params: { hostId: where.hostId, chatId: chatKey } });
    else if (tab.kind === "terminal") router.push({ pathname: "/terminal-sheet", params: { hostId: where.hostId, chatId: chatKey } });
    else if (tab.kind === "chat" && tab.chatId !== activeChatId)
      router.replace({ pathname: "/chat", params: { hostId: where.hostId, projectPath: where.projectPath, id: String(tab.chatId) } });
  };
  const newChat = () => {
    onDone?.();
    const worktree = where.worktreeId === LINK_TABS ? {} : { worktreeId: String(where.worktreeId) };
    router.replace({ pathname: "/chat", params: { hostId: where.hostId, projectPath: where.projectPath, ...worktree } });
  };
  const close = async (id: string) => {
    if (main !== undefined && id === `chat:${main}`) {
      const title = sessions?.[main] ? chatTitle(sessions[main]) : "Chat";
      if (!(await confirm(MAIN_CHAT_CLOSE_TITLE, mainChatCloseMessage(title, placeOf(where)), "Close tab"))) return;
    }
    const before = tabSet(workspace);
    const after = closeTab(before, id);
    updateTabSet(workspace, () => after);
    if (id !== `chat:${activeChatId}`) return;
    const next = after.tabs.find((tab) => tabId(tab) === after.active);
    if (next) open(next);
    else newChat();
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
    const page = tab.kind === "browser" ? "Browser" : tab.kind === "terminal" ? "Terminal" : null;
    const title = page ?? (chat ? chatTitle(chat) : "Chat");
    const mark = chat ? chatMark(chat, runs?.[`${where.projectPath}#${chat.id}`]) : "idle";
    return {
      title,
      detail: page && owner ? chatTitle(owner) : null,
      icon: tab.kind === "browser" ? Globe02Icon : tab.kind === "terminal" ? ComputerTerminal01Icon : null,
      mark,
      subchat: chat?.parent !== undefined,
      unread: Boolean(tab.unread || chat?.unread),
    };
  };
  return { set, open, newChat, close, choose, menu, describe };
}

const newTab = (place: TabPlace): MenuSection[] => [{ items: [{ id: "chat", title: newChatTabLabel(place), systemImage: "square.and.pencil" }] }];
const newPanelTab = (place: TabPlace): MenuSection[] => [
  ...newTab(place),
  {
    items: [
      { id: "changes", title: "Diff", systemImage: "plus.forwardslash.minus" },
      { id: "pr", title: "Pull request", systemImage: "arrow.triangle.pull" },
    ],
  },
];

export function WorkspaceTabsView({
  worktreeId,
  activeChatId,
  onDone,
  onPanel,
}: {
  worktreeId: number | undefined;
  activeChatId: number | undefined;
  onDone: () => void;
  onPanel: (tab: "changes" | "pr") => void;
}) {
  const session = useSession();
  const scope = session.snapshot?.project.link ? LINK_TABS : worktreeId;
  if (scope === undefined || !session.client || !session.snapshot) return null;
  return (
    <WorkspaceTabsList
      where={{ hostId: session.client.url, projectPath: session.snapshot.project.path, worktreeId: scope }}
      activeChatId={activeChatId}
      onDone={onDone}
      onPanel={onPanel}
    />
  );
}

/** The phone's right panel Tabs view: the Worktree's open tabs as rows, and + for a new one. */
function WorkspaceTabsList({
  where,
  activeChatId,
  onDone,
  onPanel,
}: {
  where: Where;
  activeChatId: number | undefined;
  onDone: () => void;
  onPanel: (tab: "changes" | "pr") => void;
}) {
  const { colors } = useTheme();
  const tabs = useTabs(where, activeChatId, onDone);
  return (
    <ScrollView contentContainerStyle={{ padding: space.gutter, gap: space.md }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: space.xs }}>
        <Text style={{ flex: 1, color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>{`${tabs.set.tabs.length} open`}</Text>
        <PullDown label="New tab" sections={newPanelTab(placeOf(where))} onSelect={(id) => (id === "chat" ? tabs.newChat() : onPanel(id as "changes" | "pr"))}>
          <View style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
            <Icon icon={PlusSignIcon} tone="ink" size={20} />
          </View>
        </PullDown>
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
      <PullDown label="New tab" sections={newTab(placeOf(where))} onSelect={tabs.newChat}>
        <View style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}>
          <Icon icon={PlusSignIcon} tone="ink" size={20} />
        </View>
      </PullDown>
    </View>
  );
}

/** The phone header's tab count: a rounded square with the number, and a dot while an unopened tab has news. */
export function TabCountAction({ where, activeChatId, onPress }: { where: Where; activeChatId: number | undefined; onPress: () => void }) {
  const { colors } = useTheme();
  const set = useTabSet(phoneWorkspace(where, activeChatId ?? -1));
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
