import { useEffect, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type ColorValue, type TextStyle } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  LinearTransition,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { LiquidGlassView } from "@sbaiahmed1/react-native-blur";
import { Icon, type IconData, type Tone } from "./icons";
import { useTheme } from "./theme";

// The Terminal and Ports pills set the size every status pill above the composer shares.
const HEIGHT = 24;
const FONT_SIZE = 11;
const LINE_HEIGHT = 14;
const ICON_SIZE = 12;

const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
const PILL_LAYOUT = LinearTransition.duration(240).easing(EASE_OUT).reduceMotion(ReduceMotion.System);

/** A pill grows in from a slightly smaller size while the pills beside it slide over; it shows once they have started to. */
function pillIn() {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ scale: 0.85 }] },
    animations: {
      opacity: withDelay(90, withTiming(1, { duration: 160 })),
      transform: [{ scale: withDelay(90, withTiming(1, { duration: 260, easing: EASE_OUT })) }],
    },
  };
}
function pillOut() {
  "worklet";
  return {
    initialValues: { opacity: 1, transform: [{ scale: 1 }] },
    animations: {
      opacity: withTiming(0, { duration: 120 }),
      transform: [{ scale: withTiming(0.85, { duration: 160 }) }],
    },
  };
}
/** One letter of a changed label rises into place after the letters before it. */
function letterIn(delay: number) {
  return () => {
    "worklet";
    return {
      initialValues: { opacity: 0, transform: [{ translateY: 4 }] },
      animations: {
        opacity: withDelay(delay, withTiming(1, { duration: 160 })),
        transform: [{ translateY: withDelay(delay, withTiming(0, { duration: 220, easing: EASE_OUT })) }],
      },
    };
  };
}
const COUNT_IN = FadeIn.duration(180).reduceMotion(ReduceMotion.System);
const COUNT_OUT = FadeOut.duration(100).reduceMotion(ReduceMotion.System);

/**
 * The status pills above the composer (Terminal, Ports, Simulators, Browser, Subagents, the PR action): one height,
 * a Liquid Glass body, counts that roll up or down when they change and labels whose letters fade in when they change.
 */
export function StatusPill({
  label,
  count,
  icon,
  leading,
  tone = "ink2",
  tint,
  accessibilityLabel,
  onPress,
  disabled = false,
}: {
  label: string;
  count?: number;
  icon?: IconData;
  leading?: ReactNode;
  tone?: Tone;
  tint?: ColorValue;
  accessibilityLabel?: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const text: TextStyle = { color: colors[tone], fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT, fontVariant: ["tabular-nums"] };
  return (
    <Animated.View entering={pillIn} exiting={pillOut} layout={PILL_LAYOUT}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? (count === undefined ? label : `${label} ${count}`)}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        hitSlop={8}
        style={({ pressed }) => ({
          height: HEIGHT,
          paddingHorizontal: 8,
          borderRadius: HEIGHT / 2,
          borderCurve: "continuous",
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          borderWidth: 1,
          borderColor: colors.line,
          overflow: "hidden",
          opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
          transform: [{ scale: pressed ? 0.96 : 1 }],
        })}
      >
        <LiquidGlassView
          pointerEvents="none"
          glassType="regular"
          glassTintColor={tint}
          isInteractive={false}
          reducedTransparencyFallbackColor={(tint ?? colors.surface) as string}
          style={[StyleSheet.absoluteFill, { borderRadius: HEIGHT / 2, borderCurve: "continuous" }]}
        />
        {leading}
        {icon && <Icon icon={icon} tone={tone} size={ICON_SIZE} />}
        <Animated.View layout={PILL_LAYOUT} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Letters text={label} style={text} />
          {count !== undefined && (
            <Animated.View entering={COUNT_IN} exiting={COUNT_OUT}>
              <RollingNumber value={count} style={text} />
            </Animated.View>
          )}
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
}

/** Shows the label whole; when it changes, the new letters fade up one after another. */
function Letters({ text, style }: { text: string; style: TextStyle }) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState({ text, generation: 0 });
  if (shown.text !== text) setShown({ text, generation: shown.generation + 1 });
  if (!shown.generation || reduced) return <Text style={style}>{text}</Text>;
  return (
    <View key={shown.generation} style={{ flexDirection: "row" }}>
      {[...text].map((letter, index) => (
        // The letters only ever remount together (the parent is keyed by generation), so an index key is stable.
        <Animated.Text key={index} style={style} entering={letterIn(Math.min(index * 18, 300))}>
          {letter}
        </Animated.Text>
      ))}
    </View>
  );
}

/** An odometer: each digit place rolls to its new digit, upward when the number grows and downward when it shrinks. */
function RollingNumber({ value, style }: { value: number; style: TextStyle }) {
  const [last, setLast] = useState({ value, direction: 1 });
  if (last.value !== value) setLast({ value, direction: value > last.value ? 1 : -1 });
  const digits = [...String(value)];
  return (
    <View style={{ flexDirection: "row" }}>
      {digits.map((digit, index) => (
        // Keyed by place from the right, so the ones digit stays the same view when the number gains a digit.
        <Animated.View key={digits.length - index} entering={COUNT_IN} exiting={COUNT_OUT} layout={PILL_LAYOUT}>
          <Digit digit={digit} direction={last.direction} style={style} />
        </Animated.View>
      ))}
    </View>
  );
}

function Digit({ digit, direction, style }: { digit: string; direction: number; style: TextStyle }) {
  const reduced = useReducedMotion();
  const [state, setState] = useState<{ digit: string; previous: string | null; direction: number }>({ digit, previous: null, direction });
  if (state.digit !== digit) setState({ digit, previous: state.digit, direction });
  const progress = useSharedValue(1);
  const travel = useSharedValue(LINE_HEIGHT);
  useEffect(() => {
    if (state.previous === null) return;
    if (reduced) {
      progress.set(1);
      return;
    }
    travel.set(LINE_HEIGHT * state.direction);
    progress.set(0);
    progress.set(withDelay(16, withTiming(1, { duration: 280, easing: EASE_OUT })));
  }, [state, reduced, progress, travel]);
  const incoming = useAnimatedStyle(() => ({
    opacity: progress.get(),
    transform: [{ translateY: (1 - progress.get()) * travel.get() }],
  }));
  const outgoing = useAnimatedStyle(() => ({
    opacity: 1 - progress.get(),
    transform: [{ translateY: -progress.get() * travel.get() }],
  }));
  return (
    <View style={{ height: LINE_HEIGHT, overflow: "hidden" }}>
      <Animated.Text style={[style, incoming]}>{state.digit}</Animated.Text>
      {state.previous !== null && (
        <Animated.Text style={[style, { position: "absolute", left: 0, right: 0, textAlign: "center" }, outgoing]}>{state.previous}</Animated.Text>
      )}
    </View>
  );
}
