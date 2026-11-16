import { useEffect, useRef, useState } from "react";
import { Text, View, type LayoutRectangle } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSequence, withSpring, withTiming, type SharedValue } from "react-native-reanimated";
import { lineHeight, radius, space, type } from "./design-tokens";
import { Mascot } from "./mascot";
import { useMotionScale, useReducedMotion } from "./motion";
import { useTheme } from "./theme";

const MINI = 12;
const HOP_MS = 320;
const JOBS = [[0, 3], [1], [2]] as const;
const MOVE = Easing.bezier(0.4, 0, 0.2, 1);

type Point = { x: number; y: number };
type MiniValues = { x: SharedValue<number>; y: SharedValue<number>; lift: SharedValue<number>; shown: SharedValue<number> };

function useMini(): MiniValues {
  return { x: useSharedValue(0), y: useSharedValue(0), lift: useSharedValue(0), shown: useSharedValue(0) };
}

function Mini({ values, color }: { values: MiniValues; color: string }) {
  const style = useAnimatedStyle(() => ({
    opacity: values.shown.value,
    transform: [{ translateX: values.x.value }, { translateY: values.y.value + values.lift.value }],
  }));
  return (
    <Animated.View pointerEvents="none" style={[{ position: "absolute", left: 0, top: 0, zIndex: 2 }, style]}>
      <Mascot size={MINI} color={color} mood="thinking" gaze={{ x: 0.2, y: 0.7 }} />
    </Animated.View>
  );
}

function Chip({ label, landed, onLayout }: { label: string; landed: boolean; onLayout: (frame: LayoutRectangle) => void }) {
  const { colors } = useTheme();
  const shown = useSharedValue(0);
  useEffect(() => {
    shown.set(landed ? withSpring(1, { damping: 11, stiffness: 260 }) : 0);
  }, [landed, shown]);
  const style = useAnimatedStyle(() => ({ opacity: Math.min(1, shown.value * 2), transform: [{ scale: 0.3 + shown.value * 0.7 }] }));
  return (
    <Animated.View
      onLayout={(event) => onLayout(event.nativeEvent.layout)}
      style={[
        { height: 24, paddingHorizontal: space.md, borderRadius: radius.full, justifyContent: "center", maxWidth: "100%" },
        { backgroundColor: colors.field, borderWidth: 1, borderColor: colors.line },
        style,
      ]}
    >
      <Text numberOfLines={1} style={{ color: colors.ink, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>
        {label}
      </Text>
    </Animated.View>
  );
}

/** The mascot beside a title splits into three that hop onto the picked chips at once, then merge back. */
export function SplitPicker({
  title,
  chips,
  picked,
  color,
  onDone,
}: {
  title: string;
  chips: readonly string[];
  picked: boolean;
  color: string;
  onDone?: () => void;
}) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const scale = useMotionScale();
  const minis = [useMini(), useMini(), useMini()];
  const main = useSharedValue(1);
  const [landed, setLanded] = useState<ReadonlySet<number>>(() => new Set());
  const [merged, setMerged] = useState(false);
  const [measured, setMeasured] = useState(0);
  const frames = useRef<{ header: LayoutRectangle | null; mascot: LayoutRectangle | null; row: LayoutRectangle | null; chips: (LayoutRectangle | null)[] }>({
    header: null,
    mascot: null,
    row: null,
    chips: [],
  });
  const started = useRef(false);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  }, [onDone]);
  const instant = picked && (reduced || scale === 0);
  const mainStyle = useAnimatedStyle(() => ({ transform: [{ scale: main.value }] }));
  const remeasure = () => setMeasured((count) => count + 1);
  useEffect(() => {
    if (!picked || started.current) return;
    const { header, mascot, row } = frames.current;
    const chipFrames = chips.map((_, index) => frames.current.chips[index] ?? null);
    if (!header || !mascot || !row || chipFrames.some((frame) => !frame)) return;
    started.current = true;
    const all = new Set(chips.map((_, index) => index));
    if (instant) {
      done.current?.();
      return;
    }
    let live = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const wait = (ms: number) => new Promise<void>((resolve) => timers.push(setTimeout(resolve, ms * scale)));
    const origin: Point = { x: header.x + mascot.x + (mascot.width - MINI) / 2, y: header.y + mascot.y + (mascot.height - MINI) / 2 };
    const over = (index: number, lift = 0): Point => {
      const frame = chipFrames[index]!;
      return { x: row.x + frame.x + frame.width / 2 - MINI / 2, y: row.y + frame.y + (frame.height - MINI) / 2 - lift };
    };
    const hop = (mini: MiniValues, to: Point) => {
      mini.x.set(withTiming(to.x, { duration: HOP_MS * scale, easing: MOVE }));
      mini.y.set(withTiming(to.y, { duration: HOP_MS * scale, easing: MOVE }));
      mini.lift.set(withSequence(withTiming(-10, { duration: HOP_MS * 0.45 * scale }), withTiming(0, { duration: HOP_MS * 0.55 * scale })));
    };
    void (async () => {
      minis.forEach((mini) => {
        mini.x.set(origin.x);
        mini.y.set(origin.y);
        mini.shown.set(1);
      });
      main.set(withTiming(0, { duration: 140 * scale }));
      await wait(120);
      minis.forEach((mini, index) => hop(mini, { x: origin.x + (index - 1) * 14, y: origin.y - 6 }));
      await wait(260);
      await Promise.all(
        JOBS.map(async (list, index) => {
          await wait(index * 90);
          for (const chip of list) {
            if (!live || chip >= chips.length) continue;
            hop(minis[index]!, over(chip));
            await wait(HOP_MS);
            if (!live) return;
            setLanded((current) => new Set(current).add(chip));
            hop(minis[index]!, over(chip, 14));
            await wait(240);
          }
        }),
      );
      if (!live) return;
      setLanded(all);
      minis.forEach((mini) => hop(mini, origin));
      await wait(HOP_MS);
      if (!live) return;
      minis.forEach((mini) => mini.shown.set(0));
      main.set(withSpring(1, { damping: 10, stiffness: 240 }));
      setMerged(true);
      await wait(400);
      if (live) done.current?.();
    })();
    return () => {
      live = false;
      timers.forEach(clearTimeout);
    };
  }, [picked, measured, instant, scale, chips]);
  return (
    <View style={{ gap: space.sm }}>
      <View
        style={{ flexDirection: "row", alignItems: "center", gap: space.md }}
        onLayout={(event) => {
          frames.current.header = event.nativeEvent.layout;
          remeasure();
        }}
      >
        <Animated.View
          style={mainStyle}
          onLayout={(event) => {
            frames.current.mascot = event.nativeEvent.layout;
            remeasure();
          }}
        >
          <Mascot size={20} color={color} mood={merged || instant ? "happy" : "thinking"} gaze={merged || instant ? null : { x: 0.2, y: 0.8 }} />
        </Animated.View>
        <Text numberOfLines={1} style={{ flex: 1, color: colors.ink, fontSize: type.callout, lineHeight: lineHeight.callout, fontWeight: "600" }}>
          {title}
        </Text>
      </View>
      {picked ? (
        <View
          style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs, paddingLeft: 20 + space.md }}
          onLayout={(event) => {
            frames.current.row = event.nativeEvent.layout;
            remeasure();
          }}
        >
          {chips.map((label, index) => (
            <Chip
              key={label}
              label={label}
              landed={instant || landed.has(index)}
              onLayout={(frame) => {
                frames.current.chips[index] = frame;
                remeasure();
              }}
            />
          ))}
        </View>
      ) : null}
      {minis.map((mini, index) => (
        <Mini key={index} values={mini} color={color} />
      ))}
    </View>
  );
}
