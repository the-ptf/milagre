import { lineHeight, space, type } from "./design-tokens";
import { ChatSwipeRow } from "./chat-swipe-row";
import { retentionOf } from "./done-retention";
import { doneCountdown } from "@milagre/shared/done";
import { snoozeWakeLabel } from "@milagre/shared/snooze";
import { WAKE } from "./snooze-actions";
import { memo, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import {
  Add01Icon,
  ArrowDown01Icon,
  AlarmClockIcon,
  HourglassIcon,
  ArrowRight01Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  SearchRemoveIcon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";
import { type SettingsRoute } from "./settings-index";
import type { AgentSession } from "@milagre/shared/model";
import type { Client } from "./client";
import { CHATS_GROUP_LABEL } from "@milagre/shared/chats-home";
import { type MobilePendingChat } from "./session";
import { chatsGroupNeedsAttention } from "./chats-group";
import { useLinks } from "./use-links";
import { Icon } from "./icons";
import { DISABLED_OPACITY, EmptyState, IconButton, PullDown } from "./ui";
import { ChatsHomeIcon, ProjectIcon, ProjectIcons } from "./project-icon";
import { useBesideChat } from "./split-chats";
import { useArchiveActivity } from "./archive-progress";
import { AttentionDot } from "./attention";
import { projectOfKey } from "@milagre/shared/agent-runs";
import { useTheme } from "./theme";
import { useChatRowShow } from "./chat-row-store";
import { useChatList } from "./chat-display-setting";
import { allComputers } from "./all-computers";
import type { ProjectCopy } from "./all-computers-store";
import { type Row } from "./navigation-build";
import { useS } from "./navigation-styles";
import { useActivityClock } from "./chat-row-store";
import { OfflineLine, ComputerTag } from "./navigation-chrome";
import { NavigationProjectRow } from "./navigation-project-row";
import { NavigationChatRow } from "./navigation-chat-row";

/** The Chats group header's menu, on a long press and on its ⋯. */
const CHATS_GROUP_MENU = [{ items: [{ id: "new", title: "New Chat", systemImage: "square.and.pencil" }] }];
/** A Done row's menu: it only leaves Done. */
const DONE_MENU = [
  {
    items: [{ id: "reopen", title: "Reopen", systemImage: "arrow.uturn.backward" }],
  },
];

/** A snoozed row's menu: Wake, or Mark Done on a computer that keeps Done. */
const snoozedMenu = (doneable: boolean) => [
  {
    items: [{ id: WAKE, title: "Wake", systemImage: "alarm" }, ...(doneable ? [{ id: "done", title: "Mark Done", systemImage: "checkmark.circle" }] : [])],
  },
];

/** A Project header the sidebar can measure while it is on screen. */
export type ProjectHeaderEntry = { hostId: string; path: string; measure: () => Promise<{ top: number; bottom: number }> };
export type RowActions = {
  enter: (hostId: string, projectPath: string, chatId?: number, pending?: MobilePendingChat, prefill?: string) => Promise<void>;
  act: (row: { hostId: string; path: string; chat: AgentSession }, action: string) => Promise<void>;
  projectAction: (hostId: string, projectPath: string, name: string, action: string) => Promise<void>;
  startNewChat: (prefill?: string) => void;
  startWithoutProject: () => Promise<void>;
  /** Opens a Settings page, scrolled to the row titled `find` and lit up when given. */
  openSetting: (page: SettingsRoute, find?: string) => void;
  foldChats: () => void;
  foldDone: () => void;
  foldSnoozed: () => void;
  /** Folds or unfolds the subchats under the parent row `key`. */
  foldSubchats: (key: string) => void;
  load: (hostId: string, projectPath: string) => Promise<unknown>;
  /** A Project header on screen, or null once it leaves: a drag measures them to find its drop. */
  registerHeader: (key: string, entry: ProjectHeaderEntry | null) => void;
  /** A Project header dragged and released with the finger at window-Y `y`: its computer's Projects take the new order. */
  reorderProjects: (hostId: string, path: string, y: number) => void;
};
/** What every row reads besides its own item; a change re-renders the rows on screen. */
export type RowView = {
  currentHostId?: string;
  currentPath?: string;
  activeChatId?: number;
  /** The open Chat's family root (`<project>#<chat>`), when it is a subchat: a folded family's row stands in for it. */
  openRoot?: string;
  busy: boolean;
  wide: boolean;
  beside: ReturnType<typeof useBesideChat>;
  rowShow: ReturnType<typeof useChatRowShow>;
  chatList: ReturnType<typeof useChatList>[0];
  selectedFill: string;
  attention: string[];
  links: ReturnType<typeof useLinks>;
  archivingChats: ReturnType<typeof useArchiveActivity>["chats"];
  archiveRequests: Set<string>;
  clientOf: (hostId: string) => Client | null;
  worktreeForLinks: (projectPath: string, worktreePath?: string) => { project_id: string; worktree_path: string } | undefined;
  /** Each computer's Done retention in hours (done-retention.ts); a computer missing from it can't keep Done. */
  doneHours: Record<string, number>;
  /** This phone's default snooze in minutes (snooze-setting.ts), for the row menus' Snooze for. */
  snoozeMinutes: number;
  /** The list's own color, under every row. */
  background: string;
  actions: RowActions;
};
/** A row's props: its item, what every row reads, and its Project's copy. */
export type RowProps<Kind extends Row["kind"]> = { item: Extract<Row, { kind: Kind }>; view: RowView; copy: ProjectCopy | undefined };
/**
 * Each list cell. A Project header's cell sits above the Chat rows from the start, so a header dragged over them stays
 * on top; the stacking never changes during a drag, which would re-order native views and cancel the touch.
 */
export function HeaderOverCell({ item, style, children, ...rest }: { item: Row; style?: StyleProp<ViewStyle>; children?: ReactNode }) {
  return (
    <View {...rest} style={[style, item.kind === "project" ? { zIndex: 1 } : null]}>
      {children}
    </View>
  );
}

/** Keep each cell's item and copy independent of other computers' publishes. */
export function createNavigationRowCache<Item extends { key: string }, View, Copy>() {
  const rows = new Map<string, { encoded: string; props: { item: Item; view: View; copy: Copy | undefined } }>();
  return {
    pick(item: Item, view: View, copy: Copy | undefined) {
      const previous = rows.get(item.key);
      const encoded = JSON.stringify(item);
      const held = previous?.encoded === encoded ? previous.props.item : item;
      if (previous && held === previous.props.item && view === previous.props.view && copy === previous.props.copy) return previous.props;
      const props = { item: held, view, copy };
      rows.set(item.key, { encoded, props });
      return props;
    },
    prune(keys: ReadonlySet<string>) {
      for (const key of rows.keys()) if (!keys.has(key)) rows.delete(key);
    },
  };
}

/** One row of the list; memoized, so only a row whose item or view changed renders again. */
export const NavigationRow = memo(function NavigationRow({ item, view, copy }: { item: Row; view: RowView; copy: ProjectCopy | undefined }) {
  const s = useS();
  const { colors } = useTheme();
  const {
    busy,
    clientOf,
    actions: { enter, startNewChat, openSetting, foldDone, foldSnoozed, load },
  } = view;
  if (item.kind === "section")
    return (
      <Text
        style={[
          s.detail,
          {
            paddingHorizontal: 16,
            paddingTop: 16,
            paddingBottom: 6,
            fontWeight: "500",
          },
        ]}
      >
        {item.name}
      </Text>
    );
  if (item.kind === "offline") return <OfflineLine hostIds={item.hostIds} />;
  if (item.kind === "chatsGroup") return <NavigationChatsGroupRow item={item} view={view} copy={copy} />;
  if (item.kind === "doneHeader" || item.kind === "snoozedHeader") {
    const name = item.kind === "doneHeader" ? "Done" : "Snoozed";
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${name}, ${item.count} ${item.count === 1 ? "chat" : "chats"}`}
        accessibilityState={{ expanded: item.expanded }}
        onPress={item.kind === "doneHeader" ? foldDone : foldSnoozed}
        style={[
          s.project,
          {
            marginTop: 8,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: colors.line,
          },
        ]}
      >
        <View style={s.projectTitle}>
          <Icon icon={item.expanded ? ArrowDown01Icon : ArrowRight01Icon} tone="ink3" size={12} />
          <Text style={[s.secondary, { fontWeight: "600", color: colors.ink2 }]}>{name}</Text>
          <Text style={[s.secondary, { color: colors.ink3, fontVariant: ["tabular-nums"] }]}>{item.count}</Text>
        </View>
      </Pressable>
    );
  }
  // A Done or snoozed Chat: its title with the time left beside it (to its archive, or to when it wakes), and its computer
  // under it when several are listed.
  if (item.kind === "done" || item.kind === "snoozed") return <NavigationDoneRow item={item} view={view} copy={copy} />;
  if (item.kind === "start")
    return (
      <EmptyState
        icon={SearchRemoveIcon}
        title={`No Chat matches “${item.query.trim()}”`}
        action={{
          title: "Start a new Chat with your search",
          icon: PencilEdit02Icon,
          onPress: () => !busy && startNewChat(item.query.trim()),
        }}
      />
    );
  if (item.kind === "settingHit")
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={item.trail === item.title ? item.title : `${item.title}. ${item.trail}`}
        onPress={() => openSetting(item.page, item.find)}
        style={({ pressed }) => [s.projectHit, { backgroundColor: pressed ? colors.hover : "transparent" }]}
      >
        <Icon icon={Settings01Icon} tone="ink2" size={18} />
        <View style={{ flex: 1, gap: 2, paddingVertical: 8 }}>
          <Text numberOfLines={1} style={[s.secondary, { color: colors.ink }]}>
            {item.title}
          </Text>
          {item.trail !== item.title && (
            <Text numberOfLines={1} style={s.detail}>
              {item.trail}
            </Text>
          )}
        </View>
      </Pressable>
    );
  const offline = item.reach === "offline";
  if (item.kind === "projectHit")
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`New Chat in ${item.name}${item.many ? `, ${item.hostName}` : ""}`}
        disabled={busy || offline}
        onPress={() => void enter(item.hostId, item.path)}
        style={({ pressed }) => [
          s.projectHit,
          {
            opacity: offline ? DISABLED_OPACITY.row : 1,
            backgroundColor: pressed ? colors.hover : "transparent",
          },
        ]}
      >
        {item.members ? (
          <ProjectIcons client={clientOf(item.hostId)} projects={item.members} />
        ) : (
          <ProjectIcon client={clientOf(item.hostId)} path={item.path} />
        )}
        <Text numberOfLines={1} style={[s.secondary, { flex: 1, color: colors.ink }]}>
          {item.name}
        </Text>
        {item.many && <Text style={s.detail}>{item.hostName}</Text>}
      </Pressable>
    );
  if (item.kind === "project") return <NavigationProjectRow item={item} view={view} copy={copy} />;
  if (item.kind === "message") {
    const [start, end] = item.highlight;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${item.snippet}, in ${item.title}, ${item.project}`}
        onPress={() => void enter(item.hostId, item.path, item.chat.id)}
        style={({ pressed }) => [s.chat, { backgroundColor: pressed ? colors.hover : "transparent" }]}
      >
        <View style={[s.chatBody, { flex: 1 }]}>
          <View style={{ flex: 1, gap: space.xs }}>
            <Text numberOfLines={2} style={s.chatTitle}>
              {item.snippet.slice(0, start)}
              <Text style={{ fontWeight: "600" }}>{item.snippet.slice(start, end)}</Text>
              {item.snippet.slice(end)}
            </Text>
            <Text numberOfLines={1} style={s.detail}>
              {[item.title, item.project, item.many ? item.hostName : ""].filter(Boolean).join(" · ")}
            </Text>
          </View>
        </View>
      </Pressable>
    );
  }
  if (item.kind === "worktree")
    return (
      <View
        accessible
        accessibilityLabel={`${item.name}${item.running ? ", running" : ""}`}
        style={[s.worktree, { opacity: offline ? DISABLED_OPACITY.row : 1 }]}
      >
        <View style={[s.worktreeDot, { backgroundColor: item.running ? colors.green : colors.ink4 }]} />
        <Text numberOfLines={1} style={[s.detail, { flexShrink: 1, color: colors.ink2 }]}>
          {item.name}
        </Text>
      </View>
    );
  if (item.kind === "notice")
    return (
      <Pressable
        accessibilityRole={item.failed ? "button" : "text"}
        disabled={!item.failed}
        onPress={() => void (item.retry === "project" ? load(item.hostId, item.path) : allComputers.refreshAll())}
        style={s.notice}
      >
        <Text style={s.detail}>{item.message}</Text>
      </Pressable>
    );
  return <NavigationChatRow item={item} view={view} copy={copy} />;
});

/** The Chats group's header, styled like a Project group. */
function NavigationChatsGroupRow({ item, view }: RowProps<"chatsGroup">) {
  const s = useS();
  const { colors } = useTheme();
  const {
    currentHostId,
    busy,
    attention,
    actions: { startWithoutProject, foldChats },
  } = view;
  // Styled like a Project group: a tap folds it, a long press or ⋯ opens its menu, + starts a Chat without a Project.
  // Its ⋯ keeps the chevron and attention dot in the same column as every Project header's.
  return (
    <View style={[s.project, { opacity: item.offline ? DISABLED_OPACITY.row : 1 }]}>
      <PullDown
        label={`${item.expanded ? "Collapse" : "Expand"} ${CHATS_GROUP_LABEL}`}
        title={CHATS_GROUP_LABEL}
        sections={CHATS_GROUP_MENU}
        onSelect={() => void startWithoutProject()}
        onPress={foldChats}
        style={{ flex: 1 }}
      >
        <View style={s.projectTitle}>
          <ChatsHomeIcon />
          <Text numberOfLines={1} style={[s.secondary, { flexShrink: 1, fontWeight: "500", color: colors.ink }]}>
            {CHATS_GROUP_LABEL}
          </Text>
          {!item.expanded && (
            <Text numberOfLines={1} style={[s.detail, { flexShrink: 1 }]}>
              {`${item.count} ${item.count === 1 ? "chat" : "chats"}`}
            </Text>
          )}
          <View style={{ flex: 1 }} />
          {chatsGroupNeedsAttention(item.homes, currentHostId, attention.map(projectOfKey)) && <AttentionDot />}
          <Icon icon={item.expanded ? ArrowDown01Icon : ArrowRight01Icon} tone="ink3" size={12} />
        </View>
      </PullDown>
      <PullDown label={`${CHATS_GROUP_LABEL} actions`} title={CHATS_GROUP_LABEL} sections={CHATS_GROUP_MENU} onSelect={() => void startWithoutProject()}>
        <View style={s.projectMore}>
          <Icon icon={MoreHorizontalIcon} tone="ink3" size={20} />
        </View>
      </PullDown>
      <IconButton label="New Chat without a Project" icon={Add01Icon} size={44} disabled={busy} onPress={() => void startWithoutProject()} />
    </View>
  );
}

/** A Done or snoozed Chat. */
function NavigationDoneRow({ item, view, copy }: RowProps<"done" | "snoozed">) {
  const s = useS();
  const { colors } = useTheme();
  const now = useActivityClock(true);
  const {
    doneHours,
    background,
    actions: { enter, act },
  } = view;
  const offline = item.reach === "offline";
  const done = item.kind === "done";
  const countdown = done
    ? doneCountdown(item.chat, retentionOf(doneHours, item.hostId), now)
    : item.chat.snoozed_until
      ? snoozeWakeLabel(item.chat.snoozed_until, now)
      : "";
  const menu = done ? DONE_MENU : snoozedMenu(doneHours[item.hostId] !== undefined);
  return (
    <ChatSwipeRow done={done} snoozed={!done} unread={false} disabled={offline || !copy} background={background} onAction={(action) => act(item, action)}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          opacity: offline ? DISABLED_OPACITY.row : 1,
        }}
      >
        {/* A long press or the ⋯ button offers Reopen or Wake, so leaving the section needn't be found by swiping. */}
        <PullDown
          label={`${item.title}, ${done ? "Done" : "Snoozed"}${item.many ? `, on ${item.hostName}` : ""}${countdown ? `, ${done ? "archived" : "wakes"} in ${countdown}` : ""}`}
          title={item.title}
          sections={offline ? [] : menu}
          onSelect={(action) => void act(item, action)}
          onPress={() => void enter(item.hostId, item.path, item.chat.id)}
          style={{ flex: 1 }}
        >
          <View style={[s.doneRow, { paddingRight: 0 }]}>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text numberOfLines={1} style={{ flex: 1, fontSize: type.callout, lineHeight: lineHeight.callout, color: colors.ink3 }}>
                  {item.title}
                </Text>
                {countdown ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                    <Icon icon={done ? HourglassIcon : AlarmClockIcon} tone="ink3" size={12} />
                    <Text style={[s.detail, { fontWeight: "500", fontVariant: ["tabular-nums"] }]}>{countdown}</Text>
                  </View>
                ) : null}
              </View>
              {item.many && <ComputerTag name={item.hostName} offline={offline} />}
            </View>
          </View>
        </PullDown>
        {!offline && (
          <PullDown label={`Actions for ${item.title}`} title={item.title} sections={menu} onSelect={(action) => void act(item, action)}>
            <View
              style={{
                width: 40,
                height: 44,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon icon={MoreHorizontalIcon} tone="ink3" size={18} />
            </View>
          </PullDown>
        )}
      </View>
    </ChatSwipeRow>
  );
}
