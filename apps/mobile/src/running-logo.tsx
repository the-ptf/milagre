import { memo, useEffect, useMemo, useState, type ComponentType, type ReactElement, type ReactNode } from "react";
import { formatElapsed } from "@milagre/shared/display-clock";
import { AccessibilityInfo, Animated, Easing, Pressable, StyleSheet, Text, View, type EasingFunction, type TextStyle } from "react-native";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { lineHeight, type } from "./design-tokens";
import { Icon } from "./icons";
import { pressStyle } from "./primitives/press-style";
import Svg, { Path } from "react-native-svg";
import RNCMaskedView from "@react-native-masked-view/masked-view";
import { LinearGradient } from "expo-linear-gradient";
import { useDisplayValue, useScreenActive } from "./display-clock";
import { LEFT, RIGHT, STAR, STAR_BOX } from "./logo";
import { fonts, useTheme } from "./theme";
import { backgroundLabel } from "@milagre/shared/chat-activity";

// The library types its class on RN's NativeMethods, which RN 0.88 removed, so JSX rejects it; the props are unchanged.
const MaskedView = RNCMaskedView as unknown as ComponentType<{ maskElement: ReactElement; children?: ReactNode }>;

/** A CSS keyframe segment: move to keyframe `to` over `duration` ms with the segment's timing function. */
type Segment = { to: number; duration: number; easing?: EasingFunction };

/**
 * Loops a CSS @keyframes animation exactly: the value steps through keyframe indices, each segment with its own curve
 * (CSS applies animation-timing-function per segment), so styles interpolate over [0, 1, 2, ...] keyframes.
 */
export function useKeyframes(segments: Segment[], delay = 0) {
  const [value] = useState(() => new Animated.Value(0));
  // Loops stop while another screen covers this one; Animated.delay segments wake JS even on the native driver.
  const active = useScreenActive();
  useEffect(() => {
    if (!active) return;
    let loop: Animated.CompositeAnimation | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (cancelled || reduced) return;
      loop = Animated.loop(
        Animated.sequence([
          ...segments.map(({ to, duration, easing }) =>
            to === -1 ? Animated.delay(duration) : Animated.timing(value, { toValue: to, duration, easing: easing || Easing.linear, useNativeDriver: true }),
          ),
          Animated.timing(value, { toValue: 0, duration: 0, useNativeDriver: true }),
        ]),
      );
      timer = setTimeout(() => loop?.start(), delay);
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      loop?.stop();
    };
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps -- the keyframes are static
  return value;
}

export const hold = (duration: number): Segment => ({ to: -1, duration });
const easeInOut = Easing.bezier(0.42, 0, 0.58, 1);
export const twinkleCurve = Easing.bezier(0.65, 0, 0.35, 1);
const GLOW: Segment[] = [{ to: 1, duration: 288, easing: easeInOut }, hold(240), { to: 2, duration: 432, easing: easeInOut }, hold(1440)];
const TWINKLE: Segment[] = [
  hold(1200),
  { to: 1, duration: 480, easing: twinkleCurve },
  { to: 2, duration: 360, easing: twinkleCurve },
  { to: 3, duration: 360, easing: twinkleCurve },
];

const CYCLE_MS = 2400;
const EASED_STEPS = 24;
const WRAP = 1e-6;

function keyframeAt(segments: Segment[], ms: number) {
  let start = 0;
  let index = 0;
  for (const { to, duration, easing } of segments) {
    if (ms < start + duration) return to === -1 ? index : index + (to - index) * (easing ?? Easing.linear)((ms - start) / duration);
    start += duration;
    if (to !== -1) index = to;
  }
  return index;
}

function bendsOf(segments: Segment[]) {
  const bends = [0];
  let start = 0;
  for (const { to, duration } of segments) {
    const steps = to === -1 ? 1 : EASED_STEPS;
    for (let step = 1; step <= steps; step += 1) bends.push(start + (duration * step) / steps);
    start += duration;
  }
  return bends;
}

function keyframeTrack(segments: Segment[], delayMs = 0) {
  const points: [number, number][] = [];
  const at = (cycles: number) => {
    const ms = (((cycles * CYCLE_MS - delayMs) % CYCLE_MS) + CYCLE_MS) % CYCLE_MS;
    return keyframeAt(segments, ms);
  };
  points.push([0, at(0)], [2, at(2 - WRAP)]);
  for (let cycle = -1; cycle <= 2; cycle += 1)
    for (const ms of bendsOf(segments)) {
      const x = (cycle * CYCLE_MS + delayMs + ms) / CYCLE_MS - (ms === CYCLE_MS ? WRAP : 0);
      if (x > 0 && x < 2) points.push([x, keyframeAt(segments, ms)]);
    }
  points.sort((a, b) => a[0] - b[0]);
  const unique = points.filter((point, i) => i === 0 || point[0] > (points[i - 1]?.[0] ?? -1));
  return { inputRange: unique.map(([x]) => x), index: unique.map(([, index]) => index) };
}

const valueAt = (values: number[], index: number): number => {
  const low = Math.min(Math.floor(index), values.length - 1);
  const from = values[low] ?? 0;
  return from + ((values[low + 1] ?? from) - from) * (index - low);
};

let logoTracks: { left: ReturnType<typeof keyframeTrack>; right: ReturnType<typeof keyframeTrack>; star: ReturnType<typeof keyframeTrack> } | undefined;
// Built on first draw: the curves come from react-native's Easing.
const tracks = () => (logoTracks ??= { left: keyframeTrack(GLOW), right: keyframeTrack(GLOW, 240), star: keyframeTrack(TWINKLE) });

/**
 * One native loop drives a RunningLogo: `progress` runs from where it stood to one cycle on, every 2.4s, and each layer
 * reads its keyframes from it (the right leg 240ms behind), so nothing wakes JS between cycles. It stops where it is
 * while another screen covers this one or the app is in the background, and stays at rest under reduced motion.
 */
function useLogoProgress() {
  const [clock] = useState(() => ({ progress: new Animated.Value(0), from: 0 }));
  const active = useScreenActive();
  useEffect(() => {
    if (!active) return;
    let loop: Animated.CompositeAnimation | undefined;
    let startedAt = 0;
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (cancelled) return null;
      if (reduced) {
        clock.from = 0;
        clock.progress.setValue(0);
        return null;
      }
      startedAt = Date.now();
      clock.progress.setValue(clock.from);
      loop = Animated.loop(
        Animated.timing(clock.progress, { toValue: clock.from + 1, duration: CYCLE_MS, easing: Easing.linear, useNativeDriver: true, isInteraction: false }),
      );
      loop.start();
      return null;
    });
    return () => {
      cancelled = true;
      if (!loop) return;
      loop.stop();
      clock.from = (clock.from + (Date.now() - startedAt) / CYCLE_MS) % 1;
      clock.progress.setValue(clock.from);
    };
  }, [active, clock]);
  return clock.progress;
}

const RunningLogo = memo(function RunningLogo({ size = 16 }: { size?: number }) {
  const { colors } = useTheme();
  const ink = colors.ink;
  const progress = useLogoProgress();
  // Built once so re-renders do not detach and recreate the native animated nodes.
  const motion = useMemo(() => {
    const { left, right, star } = tracks();
    const read = (track: ReturnType<typeof keyframeTrack>, values: number[]) =>
      progress.interpolate({ inputRange: track.inputRange, outputRange: track.index.map((index) => valueAt(values, index)) });
    const glow = [0.15, 0.55, 0.15];
    return {
      left: { opacity: read(left, glow) },
      right: { opacity: read(right, glow) },
      star: {
        opacity: read(star, [0.45, 1, 1, 0.45]),
        transform: [
          { scale: read(star, [1, 1.3, 1.12, 1]) },
          {
            rotate: progress.interpolate({
              inputRange: star.inputRange,
              outputRange: star.index.map((index) => `${valueAt([0, 45, 80, 90], index)}deg`),
            }),
          },
        ],
      },
    };
  }, [progress]);
  const scale = size / 154;
  const layer = (path: string) => (
    <Svg width={size} height={size} viewBox="-4 -4 154 154">
      <Path d={path} fill={ink} />
    </Svg>
  );
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size }}>
      <Animated.View style={[StyleSheet.absoluteFill, motion.left]}>{layer(LEFT)}</Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, motion.right]}>{layer(RIGHT)}</Animated.View>
      <Animated.View
        style={[
          { position: "absolute", left: (STAR_BOX.x + 4) * scale, top: (STAR_BOX.y + 4) * scale, width: STAR_BOX.size * scale, height: STAR_BOX.size * scale },
          motion.star,
        ]}
      >
        <Svg width="100%" height="100%" viewBox={`${STAR_BOX.x} ${STAR_BOX.y} ${STAR_BOX.size} ${STAR_BOX.size}`}>
          <Path d={STAR} fill={ink} />
        </Svg>
      </Animated.View>
    </View>
  );
});

function useElapsed(startedAt?: number) {
  const [start] = useState(() => Date.now());
  return useDisplayValue(250, (now) => formatElapsed(now - (startedAt ?? start)));
}

function RunningLabel({ label }: { label: string }) {
  const { colors } = useTheme();
  const active = useScreenActive();
  const reduced = useShimmerReducedMotion(active);
  const style = { color: colors.ink3, fontSize: type.caption1, lineHeight: lineHeight.caption1 };
  return (
    <View style={{ flexShrink: 1 }}>
      {active && !reduced ? (
        <ShimmerText settledChildren={label} style={style}>
          {label}
        </ShimmerText>
      ) : (
        <Text numberOfLines={1} style={style}>
          {label}
        </Text>
      )}
    </View>
  );
}

export function ThinkingIndicator({
  label,
  showLabel = false,
  startedAt,
  detail,
  onPress,
}: {
  label: string;
  showLabel?: boolean;
  startedAt?: number;
  detail?: ReactNode;
  onPress?: () => void;
}) {
  if (detail && onPress)
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}. Show activity`}
        // 36 tall in the transcript; the slop makes up the 44pt touch.
        hitSlop={4}
        onPress={onPress}
        style={({ pressed }) => [
          { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 36, paddingHorizontal: 4, paddingVertical: 4 },
          pressStyle({ pressed }),
        ]}
      >
        <RunningLogo />
        {detail}
        <Elapsed startedAt={startedAt} />
        <Icon icon={ArrowRight01Icon} tone="ink3" size={12} />
      </Pressable>
    );
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4, paddingVertical: 4 }}
    >
      <RunningLogo />
      {showLabel && <RunningLabel label={label} />}
      <Elapsed startedAt={startedAt} />
    </View>
  );
}

export function BackgroundIndicator({ count, startedAt, mark, onPress }: { count: number; startedAt?: number; mark: ReactNode; onPress: () => void }) {
  const { colors } = useTheme();
  const label = `${backgroundLabel(count)} running`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}. Show background tasks`}
      // 36 tall in the transcript; the slop makes up the 44pt touch.
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          minHeight: 36,
          paddingHorizontal: 4,
          paddingVertical: 4,
        },
        pressStyle({ pressed }),
      ]}
    >
      {mark}
      <Text numberOfLines={1} style={{ color: colors.ink2, fontSize: type.caption1, lineHeight: lineHeight.caption1, flexShrink: 1 }}>
        {label}
      </Text>
      <Elapsed startedAt={startedAt} color={colors.ink2} />
      <Icon icon={ArrowRight01Icon} tone="ink3" size={12} />
    </Pressable>
  );
}

function Elapsed({ startedAt, color }: { startedAt?: number; color?: string }) {
  const { colors } = useTheme();
  return (
    <Text
      style={{ color: color ?? colors.ink3, fontSize: type.caption1, lineHeight: lineHeight.caption1, fontFamily: fonts.mono, fontVariant: ["tabular-nums"] }}
    >
      {useElapsed(startedAt)}
    </Text>
  );
}

const TILE = 320;
const SWEEP_PERIOD_MS = 1200;
const TILES = 4;
const BAND_STOPS = [
  0,
  ...Array.from({ length: TILES }, (_, tile) => [110, 160, 210].map((at) => (tile * TILE + at) / (TILE * TILES))).flat(),
  1,
] as number[] as [number, number, ...number[]];

/** Recheck on screen activation and listen while mounted; Reanimated's reduced-motion value is startup-only. */
export function useShimmerReducedMotion(active: boolean) {
  const [reduced, setReduced] = useState(true);
  const { motionScale } = useTheme();
  useEffect(() => {
    if (!active) return;
    let live = true;
    let changed = false;
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (value) => {
      changed = true;
      setReduced(value);
    });
    void AccessibilityInfo.isReduceMotionEnabled().then(
      (value) => {
        if (live && !changed) setReduced(value);
        return null;
      },
      () => null,
    );
    return () => {
      live = false;
      subscription.remove();
      setReduced(true);
    };
  }, [active]);
  return reduced || motionScale === 0;
}

export function ShimmerText({
  children,
  settledChildren,
  style,
  numberOfLines = 1,
}: {
  children: ReactNode;
  settledChildren: ReactNode;
  style?: TextStyle;
  numberOfLines?: number;
}) {
  const { colors } = useTheme();
  const band = useMemo(
    () => ({
      colors: [colors.ink3, ...Array.from({ length: TILES }, () => [colors.ink3, colors.ink, colors.ink3]).flat(), colors.ink3] as string[] as [
        string,
        string,
        ...string[],
      ],
    }),
    [colors.ink3, colors.ink],
  );
  const [shift] = useState(() => new Animated.Value(0));
  useEffect(() => {
    // One native loop: the tile slides one width per period and wraps without waking JS.
    const animation = Animated.loop(
      Animated.timing(shift, { toValue: TILE, duration: SWEEP_PERIOD_MS, easing: Easing.linear, useNativeDriver: true, isInteraction: false }),
    );
    animation.start();
    return () => animation.stop();
  }, [shift]);
  const text = (
    <Text numberOfLines={numberOfLines} style={style}>
      {children}
    </Text>
  );
  return (
    <View>
      <Text numberOfLines={numberOfLines} style={[style, { color: colors.ink3 }]}>
        {settledChildren}
      </Text>
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <MaskedView maskElement={text}>
          <Text numberOfLines={numberOfLines} style={[style, { opacity: 0 }]}>
            {children}
          </Text>
          <Animated.View
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: -TILE,
              width: TILE * TILES,
              transform: [{ translateX: shift }],
            }}
          >
            <LinearGradient
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              colors={band.colors}
              locations={BAND_STOPS}
              style={{ width: TILE * TILES, height: "100%" }}
            />
          </Animated.View>
        </MaskedView>
      </View>
    </View>
  );
}
