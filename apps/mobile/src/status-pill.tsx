import { useEffect, useState, type ReactNode, type Ref } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type ColorValue,
  type LayoutChangeEvent,
  type TextStyle,
  type ViewInstance,
} from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  LinearTransition,
  type EntryOrExitLayoutType,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { Icon, type IconData, type Tone } from "./icons";
import { useReducedMotion } from "./motion";
import { duration, easing, hitSlopFor, lineHeight, radius, type } from "./design-tokens";
import { inkFor, useTheme } from "./theme";
import { DISABLED_OPACITY, PRESSED_OPACITY } from "./ui";

// The Terminal and Ports pills set the size every status pill above the composer shares.
const HEIGHT = 24;
const FONT_SIZE = type.caption2;
const LINE_HEIGHT = lineHeight.caption2;
const ICON_SIZE = 12;
/** Pill text grows with the text size up to this, and the pill with it. */
const MAX_SCALE = 1.5;
/** Status words take their tone's -ink shade (4.5:1); the icon keeps the fill tone. */
const INK_TONES = new Set<Tone>(["accent", "green", "orange", "red", "purple"]);

const EASE_OUT = Easing.bezier(...easing.enter);
type PillKit = {
  layout?: ReturnType<typeof LinearTransition.duration>;
  pillIn?: EntryOrExitLayoutType;
  pillOut?: EntryOrExitLayoutType;
  contentIn?: ReturnType<typeof FadeIn.duration>;
  countIn?: ReturnType<typeof FadeIn.duration>;
  countOut?: ReturnType<typeof FadeOut.duration>;
  letterIn: (delay: number) => EntryOrExitLayoutType | undefined;
  scale: number;
};
const kits = new Map<number, PillKit>();
/** The pills' layout and entering animations for an Animations setting: Fast shortens them, Off drops them. */
function kitFor(scale: number): PillKit {
  let kit = kits.get(scale);
  if (kit) return kit;
  const ms = (value: number) => Math.round(value * scale);
  // Worklets run on the UI thread and cannot call `ms`: every duration they use is computed here and captured as a number.
  const d90 = ms(90);
  const fast = ms(duration.fast);
  const base = ms(duration.base);
  const slow = ms(duration.slow);
  if (scale <= 0) kit = { letterIn: () => undefined, scale };
  else
    kit = {
      scale,
      layout: LinearTransition.duration(slow).easing(EASE_OUT).reduceMotion(ReduceMotion.System),
      // A pill grows in from a slightly smaller size while the pills beside it slide over. Only its contents fade: UIKit
      // drops the Liquid Glass effect for good when an ancestor's alpha animates, so nothing above the glass may fade in.
      pillIn: () => {
        "worklet";
        return {
          initialValues: { transform: [{ scale: 0.85 }] },
          animations: { transform: [{ scale: withDelay(d90, withTiming(1, { duration: slow, easing: EASE_OUT })) }] },
        };
      },
      pillOut: () => {
        "worklet";
        return {
          initialValues: { opacity: 1, transform: [{ scale: 1 }] },
          animations: {
            opacity: withTiming(0, { duration: fast }),
            transform: [{ scale: withTiming(0.85, { duration: base }) }],
          },
        };
      },
      contentIn: FadeIn.delay(d90).duration(base).reduceMotion(ReduceMotion.System),
      countIn: FadeIn.duration(base).reduceMotion(ReduceMotion.System),
      countOut: FadeOut.duration(fast).reduceMotion(ReduceMotion.System),
      /** One letter of a changed label rises into place after the letters before it. */
      letterIn: (delay: number) => {
        const wait = ms(delay);
        return () => {
          "worklet";
          return {
            initialValues: { opacity: 0, transform: [{ translateY: 4 }] },
            animations: {
              opacity: withDelay(wait, withTiming(1, { duration: base })),
              transform: [{ translateY: withDelay(wait, withTiming(0, { duration: base, easing: EASE_OUT })) }],
            },
          };
        };
      },
    };
  kits.set(scale, kit);
  return kit;
}
const useKit = () => kitFor(useTheme().motionScale);

/** A pill's frame and the gap between its icon and text, shared with the Tasks panel that grows out of one. */
export const STATUS_PILL = { height: HEIGHT, paddingHorizontal: 8, gap: 6 } as const;

/**
 * The status pills above the composer (Terminal, Ports, Tasks, Simulators, Browser, Subagents, the PR action): one
 * height, a solid body, counts that roll up or down when they change and labels whose letters fade in when they change.
 * `count` and `total` show as "count" or "count/total", after the label when there is one.
 */
export function StatusPill({
  label,
  count,
  total,
  icon,
  leading,
  tone = "ink2",
  tint,
  accessibilityLabel,
  accessibilityHint,
  expanded,
  hidden = false,
  chipRef,
  onLayout,
  onPress,
  disabled = false,
}: {
  label?: string;
  count?: number;
  total?: number;
  icon?: IconData;
  leading?: ReactNode;
  tone?: Tone;
  tint?: ColorValue;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** Set on a pill that opens a panel: whether it is open. */
  expanded?: boolean;
  /** Keeps the pill's place in the row while something drawn over it stands in for it. */
  hidden?: boolean;
  chipRef?: Ref<ViewInstance>;
  onLayout?: (event: LayoutChangeEvent) => void;
  onPress: () => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const kit = useKit();
  const ink = INK_TONES.has(tone) ? inkFor(colors, tone as Parameters<typeof inkFor>[1]) : colors[tone];
  const text: TextStyle = { color: ink, fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT, fontVariant: ["tabular-nums"] };
  const spoken = [label, count === undefined ? undefined : total === undefined ? count : `${count}/${total}`].filter((part) => part !== undefined).join(" ");
  return (
    <Animated.View entering={kit.pillIn} exiting={kit.pillOut} layout={kit.layout} onLayout={onLayout} style={hidden ? { opacity: 0 } : undefined}>
      <Pressable
        ref={chipRef}
        collapsable={false}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? spoken}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled: disabled || hidden, ...(expanded === undefined ? {} : { expanded }) }}
        accessibilityElementsHidden={hidden}
        importantForAccessibility={hidden ? "no-hide-descendants" : "auto"}
        disabled={disabled || hidden}
        onPress={onPress}
        hitSlop={hitSlopFor(HEIGHT)}
        style={({ pressed }) => ({
          minHeight: HEIGHT,
          paddingHorizontal: STATUS_PILL.paddingHorizontal,
          borderRadius: radius.full,
          borderCurve: "continuous",
          flexDirection: "row",
          alignItems: "center",
          gap: STATUS_PILL.gap,
          borderWidth: 1,
          borderColor: colors.line,
          overflow: "hidden",
          transform: [{ scale: pressed ? 0.97 : 1 }],
        })}
      >
        {({ pressed }) => (
          <>
            {/* Solid like the composer under it: the surface, then the pill's own tint over it. */}
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: colors.surface }]} />
            {tint && <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: tint }]} />}
            {/* Pressed and disabled dim the contents only, so the pill's fill stays as it is. */}
            <View style={{ opacity: disabled ? DISABLED_OPACITY.control : pressed ? PRESSED_OPACITY : 1 }}>
              <Animated.View entering={kit.contentIn} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                {leading}
                {icon && <Icon icon={icon} tone={tone} size={ICON_SIZE} />}
                <Animated.View layout={kit.layout} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                  {label !== undefined && <Letters text={label} style={text} />}
                  {count !== undefined && (
                    <Animated.View entering={kit.countIn} exiting={kit.countOut} style={{ flexDirection: "row", alignItems: "center" }}>
                      <RollingNumber value={count} style={text} />
                      {total !== undefined && (
                        <>
                          <Text style={text}>/</Text>
                          <RollingNumber value={total} style={text} />
                        </>
                      )}
                    </Animated.View>
                  )}
                </Animated.View>
              </Animated.View>
            </View>
          </>
        )}
      </Pressable>
    </Animated.View>
  );
}

/**
 * A pill's contents without its body or motion, for a stand-in drawn where the pill is (the Tasks panel fades one out as
 * it grows). Sized exactly like StatusPill's.
 */
export function StatusPillFace({ label, icon, tone = "ink2" }: { label: string; icon?: IconData; tone?: Tone }) {
  const { colors } = useTheme();
  return (
    <View style={{ height: HEIGHT, paddingHorizontal: STATUS_PILL.paddingHorizontal + 1, flexDirection: "row", alignItems: "center", gap: STATUS_PILL.gap }}>
      {icon && <Icon icon={icon} tone={tone} size={ICON_SIZE} />}
      <Text style={{ color: colors[tone], fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT, fontVariant: ["tabular-nums"] }}>{label}</Text>
    </View>
  );
}

/** Shows the label whole; when it changes, the new letters fade up one after another. */
function Letters({ text, style }: { text: string; style: TextStyle }) {
  const reduced = useReducedMotion();
  const kit = useKit();
  const [shown, setShown] = useState({ text, generation: 0 });
  if (shown.text !== text) setShown({ text, generation: shown.generation + 1 });
  if (!shown.generation || reduced)
    return (
      <Text maxFontSizeMultiplier={MAX_SCALE} style={style}>
        {text}
      </Text>
    );
  return (
    <View key={shown.generation} style={{ flexDirection: "row" }}>
      {[...text].map((letter, index) => (
        // The letters only ever remount together (the parent is keyed by generation), so an index key is stable.
        <Animated.Text key={index} maxFontSizeMultiplier={MAX_SCALE} style={style} entering={kit.letterIn(Math.min(index * 18, 300))}>
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
  const kit = useKit();
  const digits = [...String(value)];
  return (
    <View style={{ flexDirection: "row" }}>
      {digits.map((digit, index) => (
        // Keyed by place from the right, so the ones digit stays the same view when the number gains a digit.
        <Animated.View key={digits.length - index} entering={kit.countIn} exiting={kit.countOut} layout={kit.layout}>
          <Digit digit={digit} direction={last.direction} style={style} />
        </Animated.View>
      ))}
    </View>
  );
}

function Digit({ digit, direction, style }: { digit: string; direction: number; style: TextStyle }) {
  const reduced = useReducedMotion();
  const { scale } = useKit();
  // The digit's box is its line, grown with the text so a large digit isn't clipped.
  const line = LINE_HEIGHT * Math.min(useWindowDimensions().fontScale, MAX_SCALE);
  const [state, setState] = useState<{ digit: string; previous: string | null; direction: number }>({ digit, previous: null, direction });
  if (state.digit !== digit) setState({ digit, previous: state.digit, direction });
  const progress = useSharedValue(1);
  const travel = useSharedValue<number>(line);
  useEffect(() => {
    if (state.previous === null) return;
    if (reduced) {
      progress.set(1);
      return;
    }
    travel.set(line * state.direction);
    progress.set(0);
    progress.set(withDelay(16, withTiming(1, { duration: Math.round(duration.slow * scale), easing: EASE_OUT })));
  }, [state, reduced, scale, line, progress, travel]);
  const incoming = useAnimatedStyle(() => ({
    opacity: progress.get(),
    transform: [{ translateY: (1 - progress.get()) * travel.get() }],
  }));
  const outgoing = useAnimatedStyle(() => ({
    opacity: 1 - progress.get(),
    transform: [{ translateY: -progress.get() * travel.get() }],
  }));
  return (
    <View style={{ height: line, overflow: "hidden" }}>
      <Animated.Text maxFontSizeMultiplier={MAX_SCALE} style={[style, incoming]}>
        {state.digit}
      </Animated.Text>
      {state.previous !== null && (
        <Animated.Text maxFontSizeMultiplier={MAX_SCALE} style={[style, { position: "absolute", left: 0, right: 0, textAlign: "center" }, outgoing]}>
          {state.previous}
        </Animated.Text>
      )}
    </View>
  );
}
