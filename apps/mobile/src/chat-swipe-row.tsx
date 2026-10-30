import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import Swipeable, { type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { Archive02Icon, CircleIcon, Tick02Icon, Undo02Icon } from "@hugeicons/core-free-icons";
import { Icon, type IconData } from "./icons";
import { type } from "./design-tokens";
import { useTheme } from "./theme";
import { ReduceMotion } from "react-native-reanimated";
import { useReducedMotion } from "./motion";

export type SwipeAction = "done" | "archive" | "reopen" | "read" | "unread";

/**
 * A released swipe commits one action: left marks the Chat Done, right marks it read or unread. A Done Chat swipes right
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
  const swipeable = useRef<SwipeableMethods>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  // What a release does, read when it happens: the callbacks below never change, so the gestures are built once.
  const latest = useRef({
    disabled,
    onAction,
    left: (done ? "reopen" : unread ? "read" : "unread") as SwipeAction,
    right: (doneable ? "done" : "archive") as SwipeAction,
  });
  latest.current = { disabled, onAction, left: done ? "reopen" : unread ? "read" : "unread", right: doneable ? "done" : "archive" };
  const action = (label: string, icon: IconData, solid = false) => (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: 96, minHeight: 44, alignItems: "center", justifyContent: "center", gap: 4, backgroundColor: solid ? colors.green : colors.accentTint }}
    >
      <Icon icon={icon} tone={solid ? "onAccent" : "accentInk"} size={20} />
      <Text style={{ color: solid ? colors.onAccent : colors.accentInk, fontSize: type.caption1, fontWeight: "600" }}>{label}</Text>
    </View>
  );
  const leftLabel = done ? "Reopen" : unread ? "Mark as read" : "Mark as unread";
  const renderLeft = useCallback(
    () => action(leftLabel, done ? Undo02Icon : unread ? Tick02Icon : CircleIcon),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `action` only reads the theme's colors.
    [leftLabel, done, unread, colors],
  );
  const renderRight = useCallback(
    () => (doneable ? action("Done", Tick02Icon, true) : action("Archive", Archive02Icon)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `action` only reads the theme's colors.
    [doneable, colors],
  );
  const animationOptions = useMemo(() => ({ reduceMotion: reduced ? ReduceMotion.Always : ReduceMotion.System }), [reduced]);
  const childrenContainerStyle = useMemo(() => ({ backgroundColor: background }), [background]);
  const onOpen = useCallback((direction: "left" | "right") => {
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
  return (
    <Swipeable
      ref={swipeable}
      enabled={!disabled && !busy}
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
