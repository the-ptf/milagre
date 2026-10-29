import { useRef, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import Swipeable, { type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { CircleIcon, Tick02Icon, Undo02Icon } from "@hugeicons/core-free-icons";
import { Icon, type IconData } from "./icons";
import { radius, type } from "./design-tokens";
import { useTheme } from "./theme";
import { ReduceMotion } from "react-native-reanimated";
import { useReducedMotion } from "./motion";

export type SwipeAction = "done" | "reopen" | "read" | "unread";

/**
 * A released swipe commits one action: left marks the Chat Done, right marks it read or unread. A Done Chat swipes right
 * to reopen and has nothing on the left. The row's ⋯ menu stays the accessible alternative.
 */
export function ChatSwipeRow({
  children,
  unread,
  done = false,
  disabled,
  onAction,
}: {
  children: ReactNode;
  unread: boolean;
  /** The row is in the Done section. */
  done?: boolean;
  disabled: boolean;
  onAction: (action: SwipeAction) => Promise<void>;
}) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const swipeable = useRef<SwipeableMethods>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
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
  const leftAction: SwipeAction = done ? "reopen" : unread ? "read" : "unread";
  return (
    <Swipeable
      ref={swipeable}
      enabled={!disabled && !busy}
      animationOptions={{ reduceMotion: reduced ? ReduceMotion.Always : ReduceMotion.System }}
      leftThreshold={72}
      rightThreshold={72}
      overshootLeft={false}
      overshootRight={false}
      containerStyle={{ borderRadius: radius.control, borderCurve: "continuous" }}
      childrenContainerStyle={{ backgroundColor: colors.page }}
      renderLeftActions={() => (done ? action("Reopen", Undo02Icon) : action(unread ? "Mark as read" : "Mark as unread", unread ? Tick02Icon : CircleIcon))}
      renderRightActions={done ? undefined : () => action("Done", Tick02Icon, true)}
      onSwipeableOpen={(direction) => {
        swipeable.current?.close();
        if (disabled || inFlight.current) return;
        inFlight.current = true;
        setBusy(true);
        void onAction(direction === "left" ? "done" : leftAction).finally(() => {
          inFlight.current = false;
          setBusy(false);
        });
      }}
    >
      {children}
    </Swipeable>
  );
}
