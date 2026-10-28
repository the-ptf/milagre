import { memo, useEffect, useMemo, useState, type ComponentType, type ReactElement, type ReactNode } from "react";
import { formatElapsed } from "@milagre/shared/display-clock";
import { AccessibilityInfo, Animated, Easing, Pressable, StyleSheet, Text, View, type EasingFunction, type TextStyle } from "react-native";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { Icon } from "./icons";
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
// running-logo-glow: 0%, 40%, 100% { opacity: 0.15 } 12%, 22% { opacity: 0.55 }, ease-in-out, 2400ms.
const GLOW: Segment[] = [{ to: 1, duration: 288, easing: easeInOut }, hold(240), { to: 2, duration: 432, easing: easeInOut }, hold(1440)];
// running-logo-twinkle: 0%, 50% rest; 70% swell and turn 45°; 85% 80°; 100% rest at 90°.
const TWINKLE: Segment[] = [
  hold(1200),
  { to: 1, duration: 480, easing: twinkleCurve },
  { to: 2, duration: 360, easing: twinkleCurve },
  { to: 3, duration: 360, easing: twinkleCurve },
];

/** Desktop's RunningLogo: the legs take turns lighting up while the sparkle swells and turns a quarter. */
const RunningLogo = memo(function RunningLogo({ size = 16 }: { size?: number }) {
  const { colors } = useTheme();
  const ink = colors.ink;
  const left = useKeyframes(GLOW);
  const right = useKeyframes(GLOW, 240);
  const star = useKeyframes(TWINKLE);
  // Built once so re-renders do not detach and recreate the native animated nodes.
  const motion = useMemo(() => {
    const glow = (value: Animated.Value) => ({ opacity: value.interpolate({ inputRange: [0, 1, 2], outputRange: [0.15, 0.55, 0.15] }) });
    const steps = [0, 1, 2, 3];
    return {
      left: glow(left),
      right: glow(right),
      star: {
        opacity: star.interpolate({ inputRange: steps, outputRange: [0.45, 1, 1, 0.45] }),
        transform: [
          { scale: star.interpolate({ inputRange: steps, outputRange: [1, 1.3, 1.12, 1] }) },
          { rotate: star.interpolate({ inputRange: steps, outputRange: ["0deg", "45deg", "80deg", "90deg"] }) },
        ],
      },
    };
  }, [left, right, star]);
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
  // Measured from the clock, so the time is still right after the ticks pause under another screen.
  const [start] = useState(() => Date.now());
  return useDisplayValue(250, (now) => formatElapsed(now - (startedAt ?? start)));
}

/** Desktop's ThinkingIndicator: the running mark and the elapsed time; the label is for screen readers unless shown. */
export function ThinkingIndicator({ label, showLabel = false, startedAt }: { label: string; showLabel?: boolean; startedAt?: number }) {
  const { colors } = useTheme();
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 4, paddingVertical: 4 }}
    >
      <RunningLogo />
      {showLabel && (
        <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: 12, flexShrink: 1 }}>
          {label}
        </Text>
      )}
      <Elapsed startedAt={startedAt} />
    </View>
  );
}

/**
 * Desktop's BackgroundIndicator: the Chat's turn ended, but background work goes on (chat-activity.mjs). How many
 * tasks, and for how long the oldest has run; no running mark, since no turn runs.
 */
export function BackgroundIndicator({ count, startedAt, mark, onPress }: { count: number; startedAt?: number; mark: ReactNode; onPress: () => void }) {
  const { colors } = useTheme();
  const label = `${backgroundLabel(count)} running`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}. Show background tasks`}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        minHeight: 36,
        paddingHorizontal: 4,
        paddingVertical: 4,
        opacity: pressed ? 0.5 : 1,
      })}
    >
      {mark}
      <Text numberOfLines={1} style={{ color: colors.ink2, fontSize: 12, flexShrink: 1 }}>
        {label}
      </Text>
      <Elapsed startedAt={startedAt} color={colors.ink2} />
      <Icon icon={ArrowRight01Icon} tone="ink3" size={12} />
    </Pressable>
  );
}

/** Only this Text re-renders on each tick. */
function Elapsed({ startedAt, color }: { startedAt?: number; color?: string }) {
  const { colors } = useTheme();
  return <Text style={{ color: color ?? colors.ink3, fontSize: 12, fontFamily: fonts.mono, fontVariant: ["tabular-nums"] }}>{useElapsed(startedAt)}</Text>;
}

// step-shimmer: a 320px tile (ink-3 to 110px, ink at 160px, ink-3 from 210px) slides one tile right every 1.2s.
const TILE = 320;
const SWEEP_PERIOD_MS = 1200;
const TILES = 4;

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
      // Permission learned on a previous screen visit cannot authorize motion on the next one.
      setReduced(true);
    };
  }, [active]);
  return reduced || motionScale === 0;
}

/** Sweeps while mounted; ActivityTitle mounts it only while its step runs, the screen is active and motion is allowed. */
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
              flexDirection: "row",
              transform: [{ translateX: shift }],
            }}
          >
            {Array.from({ length: TILES }, (_, index) => (
              <LinearGradient
                key={index}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                colors={[colors.ink3, colors.ink3, colors.ink, colors.ink3, colors.ink3]}
                locations={[0, 110 / TILE, 160 / TILE, 210 / TILE, 1]}
                style={{ width: TILE, height: "100%" }}
              />
            ))}
          </Animated.View>
        </MaskedView>
      </View>
    </View>
  );
}
