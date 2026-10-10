import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useSafeAreaFrame, useSafeAreaInsets } from "react-native-safe-area-context";
import { GestureDetector, usePanGesture, useTapGesture, useCompetingGestures } from "react-native-gesture-handler";
import Animated, { cancelAnimation, ReduceMotion, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { BubbleChatIcon } from "@hugeicons/core-free-icons";
import type { InboxStatus } from "@milagre/shared/attention";
import { Icon, SpinnerRing } from "./icons";
import { useTheme } from "./theme";

const SIZE = 56;
const GAP = 12;
const PEEK = 16;
const SPRING = { duration: 300, dampingRatio: 0.85, overshootClamping: true, reduceMotion: ReduceMotion.System };
type Edge = 0 | 1 | 2;
type Position = { x: number; y: number; edge: Edge };
// Keep the placement while moving between Chats. Coordinates are fractions, so rotation stays reachable.
let placement: Position = { x: 1, y: 0, edge: 0 };

export function floatingInboxStatus(agents: { status: InboxStatus }[]): InboxStatus | undefined {
  return (["approval", "question", "working", "failed", "completed"] as const).find((status) => agents.some((agent) => agent.status === status));
}

function clamp(value: number, low: number, high: number) {
  "worklet";
  return Math.max(low, Math.min(high, value));
}

/** A slow move stays where released; only a side flick or a drop at a side edge tucks it away. */
function landInboxButton(x: number, y: number, vx: number, vy: number, width: number, height: number): Position {
  "worklet";
  const maxX = Math.max(0, width - SIZE),
    maxY = Math.max(0, height - SIZE);
  const px = x + vx * 0.18;
  const horizontal = Math.abs(vx) >= Math.abs(vy);
  let edge: Edge = 0;
  if (horizontal && Math.abs(vx) > 650 && (px < 0 || px > maxX)) edge = vx < 0 ? 1 : 2;
  else if (x <= GAP / 2) edge = 1;
  else if (x >= maxX - GAP / 2) edge = 2;
  return {
    x: edge === 1 ? 0 : edge === 2 ? maxX : clamp(x, GAP, Math.max(GAP, maxX - GAP)),
    y: clamp(y, GAP, Math.max(GAP, maxY - GAP)),
    edge,
  };
}

function StatusBadge({ status, small = false }: { status?: InboxStatus; small?: boolean }) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  if (!status) return null;
  if (status === "working" && !reduced) return <SpinnerRing size={small ? 10 : 12} stroke={1.5} tone="accentInk" />;
  const color = status === "approval" ? colors.orange : status === "failed" ? colors.red : status === "completed" ? colors.green : colors.accentInk;
  return <View style={{ width: small ? 6 : 8, height: small ? 6 : 8, borderRadius: 5, backgroundColor: color }} />;
}

export function FloatingInboxButton({ status, label, open, bottom }: { status?: InboxStatus; label: string; open: () => void; bottom?: number }) {
  const { scheme } = useTheme();
  const frame = useSafeAreaFrame(),
    insets = useSafeAreaInsets();
  const top = insets.top + 52;
  const width = Math.max(SIZE + GAP * 2, frame.width - insets.left - insets.right);
  const height = Math.max(SIZE + GAP * 2, frame.height - top - (bottom ?? Math.max(insets.bottom, 16) + 120));
  const [hidden, setHidden] = useState<Edge>(placement.edge);
  const x = useSharedValue(placement.edge === 1 ? 0 : placement.edge === 2 ? width - SIZE : GAP + placement.x * (width - SIZE - GAP * 2));
  const y = useSharedValue(GAP + placement.y * (height - SIZE - GAP * 2));
  const edge = useSharedValue<Edge>(placement.edge);
  const fromX = useSharedValue(0),
    fromY = useSharedValue(0),
    fromEdge = useSharedValue<Edge>(0);
  const dragging = useSharedValue(false);
  const tuckX = useSharedValue(placement.edge === 1 ? PEEK - SIZE : placement.edge === 2 ? SIZE - PEEK : 0);
  const remember = useCallback(
    (position: Position) => {
      placement = {
        x: clamp((position.x - GAP) / Math.max(1, width - SIZE - GAP * 2), 0, 1),
        y: clamp((position.y - GAP) / Math.max(1, height - SIZE - GAP * 2), 0, 1),
        edge: position.edge,
      };
      setHidden(position.edge);
    },
    [width, height],
  );
  const animateTo = useCallback(
    (position: Position) => {
      x.set(withSpring(position.x, SPRING));
      y.set(withSpring(position.y, SPRING));
      edge.set(position.edge);
      tuckX.set(withSpring(position.edge === 1 ? PEEK - SIZE : position.edge === 2 ? SIZE - PEEK : 0, SPRING));
    },
    [x, y, edge, tuckX],
  );
  const move = useCallback(
    (position: Position) => {
      animateTo(position);
      remember(position);
    },
    [animateTo, remember],
  );
  useEffect(() => {
    animateTo({
      x: placement.edge === 1 ? 0 : placement.edge === 2 ? width - SIZE : GAP + placement.x * (width - SIZE - GAP * 2),
      y: GAP + placement.y * (height - SIZE - GAP * 2),
      edge: placement.edge,
    });
  }, [width, height, animateTo]);
  const activate = useCallback(() => {
    if (edge.get()) {
      move({ x: clamp(x.get(), GAP, width - SIZE - GAP), y: clamp(y.get(), GAP, height - SIZE - GAP), edge: 0 });
    } else open();
  }, [edge, x, y, move, width, height, open]);
  const pan = usePanGesture({
    minDistance: 6,
    maxPointers: 1,
    onActivate: () => {
      "worklet";
      dragging.set(true);
      cancelAnimation(x);
      cancelAnimation(y);
      cancelAnimation(tuckX);
      fromX.set(x.get());
      fromY.set(y.get());
      fromEdge.set(edge.get());
      edge.set(0);
      tuckX.set(withSpring(0, SPRING));
    },
    onUpdate: (event) => {
      "worklet";
      x.set(clamp(fromX.get() + event.translationX, 0, width - SIZE));
      y.set(clamp(fromY.get() + event.translationY, 0, height - SIZE));
    },
    onDeactivate: (event) => {
      "worklet";
      if (event.canceled) return;
      const position = landInboxButton(x.get(), y.get(), event.velocityX, event.velocityY, width, height);
      edge.set(position.edge);
      x.set(withSpring(position.x, { ...SPRING, velocity: event.velocityX }));
      y.set(withSpring(position.y, { ...SPRING, velocity: event.velocityY }));
      tuckX.set(withSpring(position.edge === 1 ? PEEK - SIZE : position.edge === 2 ? SIZE - PEEK : 0, SPRING));
      scheduleOnRN(remember, position);
    },
    onFinalize: (event) => {
      "worklet";
      if (event.canceled && dragging.get()) {
        x.set(withSpring(fromX.get(), SPRING));
        y.set(withSpring(fromY.get(), SPRING));
        edge.set(fromEdge.get());
        tuckX.set(withSpring(fromEdge.get() === 1 ? PEEK - SIZE : fromEdge.get() === 2 ? SIZE - PEEK : 0, SPRING));
      }
      dragging.set(false);
    },
  });
  const tap = useTapGesture({
    maxDistance: 6,
    onDeactivate: (event) => {
      "worklet";
      if (!event.canceled) scheduleOnRN(activate);
    },
  });
  const gesture = useCompetingGestures(pan, tap);
  const positionStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() }, { translateY: y.get() }] }));
  const bodyStyle = useAnimatedStyle(() => ({ transform: [{ translateX: tuckX.get() }] }));
  const badgeStyle = useAnimatedStyle(() => ({ opacity: edge.get() ? 0 : 1 }));
  const tabStyle = useAnimatedStyle(() => ({
    opacity: edge.get() ? 1 : 0,
    transform: [{ translateX: edge.get() === 1 ? -20 : edge.get() === 2 ? 20 : 0 }],
  }));
  const background = scheme === "dark" ? "#000" : "#fff";
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", left: insets.left, right: insets.right, top, height, overflow: "hidden", zIndex: 2 }}>
      <GestureDetector gesture={gesture}>
        <Animated.View
          accessible
          accessibilityRole="button"
          accessibilityLabel={hidden ? `Show inbox button. ${label}` : `Open inbox. ${label}`}
          accessibilityHint={hidden ? "Tap to bring the button back, or drag it away from the edge." : "Drag to move. Flick left or right to tuck away."}
          onAccessibilityTap={activate}
          accessibilityActions={[{ name: "activate" }, { name: "hide", label: "Tuck into nearest side edge" }]}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === "activate") activate();
            else if (event.nativeEvent.actionName === "hide")
              move({ x: x.get() < width / 2 ? 0 : width - SIZE, y: y.get(), edge: x.get() < width / 2 ? 1 : 2 });
          }}
          style={[{ position: "absolute", width: SIZE, height: SIZE }, positionStyle]}
        >
          <Animated.View
            pointerEvents="none"
            style={[
              { width: SIZE, height: SIZE, borderRadius: SIZE / 2, backgroundColor: background, alignItems: "center", justifyContent: "center" },
              bodyStyle,
            ]}
          >
            <Icon icon={BubbleChatIcon} size={23} color={scheme === "dark" ? "#fff" : "#000"} />
            <Animated.View
              style={[
                {
                  position: "absolute",
                  top: 0,
                  right: 0,
                  width: 18,
                  height: 18,
                  borderRadius: 9,
                  backgroundColor: background,
                  alignItems: "center",
                  justifyContent: "center",
                },
                badgeStyle,
              ]}
            >
              <StatusBadge status={status} />
            </Animated.View>
          </Animated.View>
          <Animated.View
            pointerEvents="none"
            style={[{ position: "absolute", left: 22, top: 22, width: 12, height: 12, alignItems: "center", justifyContent: "center" }, tabStyle]}
          >
            <StatusBadge status={status} small />
          </Animated.View>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}
