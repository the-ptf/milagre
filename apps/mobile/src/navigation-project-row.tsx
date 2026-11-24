import { radius } from "./design-tokens";
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { Pressable, Text, View, type ViewInstance } from "react-native";
import { Add01Icon, ArrowDown01Icon, ArrowRight01Icon, MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, type SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { savedFoldedProjects } from "./hosts-native";
import { Icon } from "./icons";
import { DISABLED_OPACITY, IconButton, PRESSED_OPACITY, PullDown } from "./ui";
import { ProjectIcon, ProjectIcons } from "./project-icon";
import { AttentionDot } from "./attention";
import { projectOfKey } from "@milagre/shared/agent-runs";
import { useTheme } from "./theme";
import { TREE_INDENT } from "./navigation-rows";
import { useS } from "./navigation-styles";
import { type RowActions, type RowProps } from "./navigation-row";

// Built outside render: the React Compiler lint rules ban capitalized calls and ref reads in a component body.
function headerDragGesture({
  lifted,
  offset,
  drop,
  onFold,
}: {
  lifted: SharedValue<number>;
  offset: SharedValue<number>;
  drop: (y: number) => void;
  onFold: () => void;
}) {
  const pan = Gesture.Pan()
    .activateAfterLongPress(220)
    .onStart(() => {
      "worklet";
      lifted.set(1);
    })
    .onUpdate((event) => {
      "worklet";
      offset.set(event.translationY);
    })
    .onEnd((event) => {
      "worklet";
      scheduleOnRN(drop, event.absoluteY);
    })
    .onFinalize(() => {
      "worklet";
      lifted.set(0);
      offset.set(0);
    });
  const tapFold = Gesture.Tap().onEnd((_event, success) => {
    "worklet";
    if (success) scheduleOnRN(onFold);
  });
  return Gesture.Exclusive(pan, tapFold);
}

function ProjectHeaderDrag({
  hostId,
  path,
  rowKey,
  label,
  onFold,
  registerHeader,
  reorderProjects,
  background,
  children,
}: {
  hostId: string;
  path: string;
  rowKey: string;
  label: string;
  onFold: () => void;
  background: string;
  registerHeader: RowActions["registerHeader"];
  reorderProjects: RowActions["reorderProjects"];
  children: ReactNode;
}) {
  const { colors } = useTheme();
  const ref = useRef<ViewInstance>(null);
  const lifted = useSharedValue(0);
  const offset = useSharedValue(0);
  useEffect(() => {
    const measure = () =>
      new Promise<{ top: number; bottom: number }>((resolve) => {
        const node = ref.current;
        if (!node) return resolve({ top: 0, bottom: 0 });
        node.measureInWindow((_x: number, y: number, _width: number, height: number) => resolve({ top: y, bottom: y + height }));
      });
    registerHeader(rowKey, { hostId, path, measure });
    return () => registerHeader(rowKey, null);
  }, [rowKey, hostId, path, registerHeader]);
  const drop = useCallback((y: number) => reorderProjects(hostId, path, y), [hostId, path, reorderProjects]);
  const gesture = headerDragGesture({ lifted, offset, drop, onFold });
  const lift = useAnimatedStyle(() => ({
    transform: [{ translateY: offset.get() }, { scale: 1 + lifted.get() * 0.02 }],
    borderRadius: radius.control,
    shadowColor: colors.media,
    shadowOpacity: lifted.get() * 0.14,
    // oxlint-disable-next-line milagre-design/shadow-token -- the drag lift fades its shadow in with the spring, which a static boxShadow token cannot
    shadowRadius: 10,
    // oxlint-disable-next-line milagre-design/shadow-token -- same animated drag-lift shadow as shadowRadius above
    shadowOffset: { width: 0, height: 3 },
    zIndex: lifted.get() ? 2 : 0,
  }));
  return (
    <GestureDetector gesture={gesture}>
      <Animated.View ref={ref} accessibilityRole="button" accessibilityLabel={label} style={[{ flex: 1 }, lift]}>
        <View style={{ backgroundColor: background, borderRadius: radius.control }}>{children}</View>
      </Animated.View>
    </GestureDetector>
  );
}

export function NavigationProjectRow({ item, view, copy }: RowProps<"project">) {
  const offline = item.reach === "offline";
  const s = useS();
  const { colors } = useTheme();
  const {
    currentHostId,
    busy,
    attention,
    clientOf,
    background,
    actions: { enter, projectAction, registerHeader, reorderProjects },
  } = view;
  const linked = item.link;
  const client = clientOf(item.hostId);
  const unsaved = copy?.project.state.persistence;
  const menu = [
    {
      items: [
        { id: "new", title: "New Chat", systemImage: "square.and.pencil" },
        {
          id: "copy",
          title: linked ? "Copy Link name" : "Copy path",
          systemImage: "doc.on.doc",
        },
        ...(linked && item.hostId === currentHostId ? [{ id: "edit", title: "Edit Link", systemImage: "pencil" }] : []),
        ...(!linked ? [{ id: "design-library", title: "Design library", systemImage: "books.vertical" }] : []),
      ],
    },
    ...(linked && item.hostId === currentHostId ? [{ items: [{ id: "delete", title: "Delete Link", systemImage: "trash", destructive: true }] }] : []),
    ...(!linked ? [{ items: [{ id: "remove", title: "Remove Project", systemImage: "minus.circle", destructive: true }] }] : []),
  ];
  const choose = (action: string) => void projectAction(item.hostId, item.path, item.name, action);
  const canReorder = !linked && item.hostId === currentHostId && !offline;
  const header = (
    <View style={s.projectTitle}>
      {item.members ? <ProjectIcons client={client} projects={item.members} /> : <ProjectIcon client={client} path={item.path} />}
      <Text numberOfLines={1} style={[s.secondary, { flexShrink: 1, fontWeight: "500", color: colors.ink }]}>
        {item.name}
      </Text>
      {(item.chip || !item.expanded) && (
        <Text numberOfLines={1} style={[s.detail, { flexShrink: 100 }]}>
          {[item.chip ? item.hostName + (offline ? ", offline" : "") : "", item.expanded ? "" : `${item.count} ${item.count === 1 ? "chat" : "chats"}`]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      )}
      <View style={{ flex: 1 }} />
      {unsaved && (
        <Text accessibilityLabel="Changes not saved" style={[s.detail, { color: colors.redInk }]}>
          Unsaved
        </Text>
      )}
      {item.hostId === currentHostId && attention.some((key) => projectOfKey(key) === item.path) && <AttentionDot />}
      <Icon icon={item.expanded ? ArrowDown01Icon : ArrowRight01Icon} tone="ink3" size={12} />
    </View>
  );
  return (
    <View style={[s.project, item.member ? { marginTop: 4, paddingLeft: 8 + TREE_INDENT } : null, { opacity: offline ? DISABLED_OPACITY.row : 1 }]}>
      {canReorder ? (
        <ProjectHeaderDrag
          hostId={item.hostId}
          path={item.path}
          rowKey={item.key}
          label={`${item.expanded ? "Collapse" : "Expand"} ${item.name}. Press and hold to reorder.`}
          onFold={() => void savedFoldedProjects.toggle(item.hostId, item.path)}
          registerHeader={registerHeader}
          background={background}
          reorderProjects={reorderProjects}
        >
          {header}
        </ProjectHeaderDrag>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${item.expanded ? "Collapse" : "Expand"} ${item.name}${item.chip ? `, ${item.hostName}${offline ? ", offline" : ""}` : ""}`}
          onPress={() => void savedFoldedProjects.toggle(item.hostId, item.path)}
          style={({ pressed }) => [{ flex: 1 }, { opacity: pressed ? PRESSED_OPACITY : 1 }]}
        >
          {header}
        </Pressable>
      )}
      <PullDown label={`${item.name} actions`} title={item.name} sections={menu} onSelect={choose}>
        <View style={s.projectMore}>
          <Icon icon={MoreHorizontalIcon} tone="ink3" size={20} />
        </View>
      </PullDown>
      <IconButton label={`New Chat in ${item.name}`} icon={Add01Icon} size={44} disabled={busy || offline} onPress={() => void enter(item.hostId, item.path)} />
    </View>
  );
}
