import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, Text } from "react-native";
import Swipeable, { type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { Archive02Icon, CircleIcon, Tick02Icon, Undo02Icon } from "@hugeicons/core-free-icons";
import { Icon, type IconData } from "./icons";
import { type } from "./design-tokens";
import { useTheme } from "./theme";
import { ReduceMotion, useDerivedValue, type SharedValue } from "react-native-reanimated";
import { useReducedMotion } from "./motion";

export type SwipeAction = "done" | "archive" | "reopen" | "read" | "unread";

/**
 * The list sits in the slide-over sidebar, which a leftward drag closes. A drag meant to close it lands on a row more often
 * than not, so there a row's leftward swipe only reveals Done, which a tap then commits, and the rows leave their last 32
 * points, an edge nothing marks, to the close.
 */
export const ClosesLeftContext = createContext<SharedValue<boolean> | null>(null);
// Kept as one object: a new hitSlop each render would rebuild the row's gestures.
const CLOSE_EDGE = { right: -32 };
// The one row showing Done in the sidebar. A revealed Done waits for a tap, so it must not outlive the moment: another
// row revealing, the list scrolling or the sidebar closing hides it.
let revealed: SwipeableMethods | null = null;
export function hideRevealed() {
  revealed?.close();
  revealed = null;
}

/**
 * A released swipe commits one action: left marks the Chat Done (in the sidebar, reveals it), right marks it read or unread. A Done Chat swipes right
 * to reopen and has nothing on the left. A Mac too old to keep Done (`doneable` false) archives on the left swipe, as
 * before Done. The row's ⋯ menu stays the accessible alternative.
 *
 * Every prop handed to the Swipeable keeps its identity across renders: a changed callback, style or option rebuilds the
 * row's native gestures, and the list re-renders all its rows whenever the selected Chat changes, which made a tap slow.
 */
export function ChatSwipeRow({
  children,
  unread,
  done = false,
  doneable = true,
  disabled,
  background,
  onAction,
}: {
  children: ReactNode;
  unread: boolean;
  /** The row is in the Done section. */
  done?: boolean;
  /** The Chat's Mac can mark it Done; an older one archives instead. */
  doneable?: boolean;
  disabled: boolean;
  /** The list's own color under the row, so a row reads as part of the list rather than a tile of its own. */
  background: string;
  onAction: (action: SwipeAction) => Promise<void>;
}) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  // In the sidebar, whether it is all the way open: while it slides, a swipe must not reach a moving row. Read on the UI
  // thread, so opening and closing re-render no row.
  const sidebar = useContext(ClosesLeftContext);
  const closesLeft = sidebar !== null;
  const swipeable = useRef<SwipeableMethods>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const idle = !disabled && !busy;
  const enabled = useDerivedValue(() => idle && (sidebar?.get() ?? true), [idle, sidebar]);
  // What a release does, read when it happens: the callbacks below never change, so the gestures are built once.
  const latest = useRef({
    disabled,
    onAction,
    left: (done ? "reopen" : unread ? "read" : "unread") as SwipeAction,
    right: (doneable ? "done" : "archive") as SwipeAction,
  });
  latest.current = { disabled, onAction, left: done ? "reopen" : unread ? "read" : "unread", right: doneable ? "done" : "archive" };
  const commit = useCallback((direction: "left" | "right") => {
    if (revealed === swipeable.current) revealed = null;
    swipeable.current?.close();
    const { disabled: off, onAction: run, left, right } = latest.current;
    if (off || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    void run(direction === "left" ? right : left).finally(() => {
      inFlight.current = false;
      setBusy(false);
    });
  }, []);
  // A revealed action commits on a tap; the row's ⋯ menu stays the accessible way, so it is hidden from screen readers.
  const action = (label: string, icon: IconData, solid = false, onPress?: () => void) => (
    <Pressable
      disabled={!onPress}
      onPress={onPress}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: 96, minHeight: 44, alignItems: "center", justifyContent: "center", gap: 4, backgroundColor: solid ? colors.green : colors.accentTint }}
    >
      <Icon icon={icon} tone={solid ? "onAccent" : "accentInk"} size={20} />
      <Text style={{ color: solid ? colors.onAccent : colors.accentInk, fontSize: type.caption1, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
  const leftLabel = done ? "Reopen" : unread ? "Mark as read" : "Mark as unread";
  const renderLeft = useCallback(
    () => action(leftLabel, done ? Undo02Icon : unread ? Tick02Icon : CircleIcon),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `action` only reads the theme's colors.
    [leftLabel, done, unread, colors],
  );
  const renderRight = useCallback(
    () => {
      const tap = closesLeft ? () => commit("left") : undefined;
      return doneable ? action("Done", Tick02Icon, true, tap) : action("Archive", Archive02Icon, false, tap);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `action` only reads the theme's colors.
    [doneable, colors, closesLeft, commit],
  );
  const animationOptions = useMemo(() => ({ reduceMotion: reduced ? ReduceMotion.Always : ReduceMotion.System }), [reduced]);
  const childrenContainerStyle = useMemo(() => ({ backgroundColor: background }), [background]);
  const onOpen = useCallback(
    (direction: "left" | "right") => {
      // In the sidebar, Done stays revealed until it is tapped or the row is touched again.
      if (direction === "left" && closesLeft) {
        if (revealed !== swipeable.current) hideRevealed();
        revealed = swipeable.current;
        return;
      }
      commit(direction);
    },
    [closesLeft, commit],
  );
  return (
    <Swipeable
      ref={swipeable}
      enabled={enabled}
      hitSlop={closesLeft ? CLOSE_EDGE : undefined}
      animationOptions={animationOptions}
      leftThreshold={72}
      rightThreshold={72}
      overshootLeft={false}
      overshootRight={false}
      childrenContainerStyle={childrenContainerStyle}
      renderLeftActions={renderLeft}
      renderRightActions={done ? undefined : renderRight}
      onSwipeableOpen={onOpen}
    >
      {children}
    </Swipeable>
  );
}
