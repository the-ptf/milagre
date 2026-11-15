import { UI_COPY } from "@milagre/shared/model-copy";
import { useCallback, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Platform, View, useWindowDimensions } from "react-native";
import { Stack } from "expo-router";
import { SidebarLeftIcon } from "@hugeicons/core-free-icons";
import { issueChipLabel, type LinearIssue } from "@milagre/shared/linear";
import { useSession } from "./session";
import { useSplit } from "./split-context";
import { chatAreaWidth } from "./split-width";
import { GlassIconButton, HeaderButton, PullDown, type MenuSection } from "./ui";
import { familyMenu } from "./subchat-family";

const HEADER_EDGE = 16;
const HEADER_BUTTON = 44;
const HEADER_BUTTON_PITCH = 44;
const HEADER_GAP = 12;
const HEADER_TITLE_MAX = 230;
function headerTitleWidth(screenWidth: number, actionCount: number) {
  const left = HEADER_EDGE + HEADER_BUTTON + HEADER_GAP;
  const right = HEADER_EDGE + (HEADER_BUTTON + (actionCount - 1) * HEADER_BUTTON_PITCH) + HEADER_GAP;
  return Math.max(0, Math.min(HEADER_TITLE_MAX, screenWidth - left - right));
}

export function HeaderTitleBox({ actionCount, children }: { actionCount: number; children: ReactNode }) {
  const window = useWindowDimensions();
  const { pinned } = useSplit();
  return <View style={{ alignItems: "center", width: "100%", maxWidth: headerTitleWidth(chatAreaWidth(window.width, pinned), actionCount) }}>{children}</View>;
}

/**
 * A pane's native header content, kept apart from its screen options. expo-router publishes a Stack.Screen's options and a
 * Stack.Toolbar's children to the navigator whenever they change, which re-renders the navigator; what changes with every
 * Chat render goes through this slot instead, and the options stay the same object.
 */
type HeaderSlotStore = { get: () => ReactNode; set: (content: ReactNode) => void; subscribe: (listener: () => void) => () => void };
function headerSlotStore(initial: ReactNode): HeaderSlotStore {
  let content = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => content,
    set(next) {
      if (next === content) return;
      content = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
function HeaderSlot({ slot }: { slot: HeaderSlotStore }) {
  return <>{useSyncExternalStore(slot.subscribe, slot.get)}</>;
}
function useHeaderSlot(content: ReactNode) {
  const [slot] = useState(() => headerSlotStore(content));
  useLayoutEffect(() => slot.set(content), [slot, content]);
  return slot;
}

function chatScreenOptions(title: string, starting: boolean, slot: HeaderSlotStore) {
  return {
    title: starting ? "" : title,
    headerTitle: () => (starting ? null : <HeaderSlot slot={slot} />),
    headerShown: true,
    headerBackVisible: false,
    gestureEnabled: false,
  };
}
export function ChatStackOptions({ title, starting, header }: { title: string; starting: boolean; header: ReactNode }) {
  const slot = useHeaderSlot(header);
  const options = useMemo(() => chatScreenOptions(title, starting, slot), [title, starting, slot]);
  return <Stack.Screen options={options} />;
}

export function HiddenHeaderOptions({ title }: { title: string }) {
  const options = useMemo(() => ({ title, headerShown: false, headerBackVisible: false, gestureEnabled: false }), [title]);
  return <Stack.Screen options={options} />;
}

export function ChatToolbar({ shape, children }: { shape: string; children: ReactNode }) {
  const slot = useHeaderSlot(children);
  const items = useMemo(
    () => (
      <Stack.Toolbar.View key={shape} hidesSharedBackground>
        <HeaderSlot slot={slot} />
      </Stack.Toolbar.View>
    ),
    [shape, slot],
  );
  return <Stack.Toolbar placement="right">{items}</Stack.Toolbar>;
}

export function FamilyTitleMenu({
  sessions,
  chatKey,
  members,
  routines,
  routinesOn,
  now,
  canOpenBeside,
  label,
  title,
  onSelect,
  children,
}: {
  sessions: Parameters<typeof familyMenu>[0]["sessions"];
  chatKey: string;
  members: readonly string[];
  routines: Parameters<typeof familyMenu>[0]["routines"];
  routinesOn: boolean;
  now: number;
  canOpenBeside: boolean;
  label: string;
  title: string;
  onSelect: (id: string) => void;
  children: ReactNode;
}) {
  const runs = useSession().snapshot?.runs.runs;
  const sectionsKey = JSON.stringify(familyMenu({ sessions, key: chatKey, children: members, routines, routinesOn, runs, now, canOpenBeside }));
  const sections = useMemo(() => JSON.parse(sectionsKey) as MenuSection[], [sectionsKey]);
  return (
    <PullDown label={label} title={title} sections={sections} onSelect={onSelect} style={{ maxWidth: "100%" }}>
      {children}
    </PullDown>
  );
}

export function SidebarToolbar({ onOpenNavigation }: { onOpenNavigation: (side: "left") => void }) {
  const { dockable, pinned, toggle } = useSplit();
  const label = dockable ? (pinned ? "Hide sidebar" : "Show sidebar") : "Open navigation";
  const press = useCallback(() => (dockable ? toggle() : onOpenNavigation("left")), [dockable, toggle, onOpenNavigation]);
  // Stack.Toolbar.Button takes SF Symbols only on iOS; Android needs a React child. The same children keep the toolbar's
  const items = useMemo(
    () =>
      Platform.OS === "ios" ? (
        <Stack.Toolbar.Button icon="sidebar.left" accessibilityLabel={label} onPress={press} />
      ) : (
        <Stack.Toolbar.View>
          <HeaderButton label={label} icon={SidebarLeftIcon} onPress={press} />
        </Stack.Toolbar.View>
      ),
    [label, press],
  );
  return <Stack.Toolbar placement="left">{items}</Stack.Toolbar>;
}

export function SidebarButton() {
  const { pinned, toggle } = useSplit();
  return <GlassIconButton label={pinned ? "Hide sidebar" : "Show sidebar"} systemImage="sidebar.left" icon={SidebarLeftIcon} onPress={toggle} />;
}

export function chatPaneMenu({
  chatsHomeOpen,
  diff,
  chat,
  run,
  ownRoutine,
  ownHeartbeat,
  linearIssue,
  linkHint,
  agents,
  busy,
  canLink,
  storedIssue,
}: {
  chatsHomeOpen: boolean;
  diff: { added: number; removed: number } | null | undefined;
  chat: { readOnlyReason?: unknown; archived?: unknown } | null | undefined;
  run: unknown;
  ownRoutine: unknown;
  ownHeartbeat: unknown;
  linearIssue: LinearIssue | null | undefined;
  linkHint: string | null | undefined;
  agents: readonly unknown[];
  busy: boolean;
  canLink: boolean;
  storedIssue: unknown;
}): MenuSection[] {
  return [
    {
      items: [
        ...(chatsHomeOpen
          ? []
          : [
              { id: "changes", title: "View changes", systemImage: "doc.text.magnifyingglass", subtitle: diff ? `+${diff.added} −${diff.removed}` : undefined },
            ]),
        ...(chat
          ? [
              {
                id: chat.readOnlyReason ? "checkpoints" : "undo",
                title: chat.readOnlyReason ? "View checkpoints" : "Undo changes",
                systemImage: "arrow.uturn.backward",
                disabled: !!run,
              },
            ]
          : []),
        ...(ownRoutine ? [{ id: "routine", title: ownHeartbeat ? "Heartbeat" : "Routine", systemImage: ownHeartbeat ? "waveform.path.ecg" : "repeat" }] : []),
        ...(linearIssue ? [{ id: "linear", title: issueChipLabel(linearIssue), systemImage: "link" }] : []),
        ...(linkHint ? [{ id: "link-hint", title: linkHint, systemImage: "info.circle", disabled: true }] : []),
        ...(agents.length > 0 ? [{ id: "agents", title: "Subagents", systemImage: "person.2", subtitle: String(agents.length) }] : []),
      ],
    },
    ...(chat
      ? [
          {
            items: [
              { id: "rename", title: "Rename", systemImage: "pencil" },
              { id: "reload", title: "Reload chat", systemImage: "arrow.clockwise", disabled: busy },
              { id: "report-bug", title: UI_COPY.reportMilagreBug, systemImage: "ladybug" },
              ...(canLink
                ? [
                    {
                      id: storedIssue ? "unlink-issue" : "link-issue",
                      title: storedIssue ? "Unlink issue" : "Link issue…",
                      systemImage: "link",
                      disabled: busy,
                    },
                  ]
                : []),
              {
                id: "archive",
                title: chat.archived ? "Restore" : "Delete",
                systemImage: chat.archived ? "tray.and.arrow.up" : "trash",
                destructive: !chat.archived,
                disabled: busy,
              },
            ],
          },
        ]
      : []),
  ];
}
