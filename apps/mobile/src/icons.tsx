import { use, useCallback, useEffect, useId, useMemo, useState, useSyncExternalStore, type Context } from "react";
import { Animated, AppState, Easing, View } from "react-native";
import Svg, { Circle, Defs, FeGaussianBlur, Filter, G, LinearGradient, Mask, Path, Stop } from "react-native-svg";
import {
  ANTIGRAVITY_LOGO,
  CLAUDE_LOGO,
  CODEX_LOGO,
  GITHUB_LOGO,
  GROK_LOGO,
  KIRO_LOGO,
  LINEAR_LOGO,
  PI_LOGO,
  providerLogoPath,
} from "@milagre/shared/provider-logos";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react-native";
import type { ModelProvider } from "@milagre/shared/model";
import { useTheme, type Palette } from "./theme";
import { useReducedMotion } from "./motion";

export type Tone = { [K in keyof Palette]: Palette[K] extends string ? K : never }[keyof Palette];
export type IconData = IconSvgElement;

export function Icon({
  icon,
  tone = "ink2",
  color,
  size = 18,
  strokeWidth,
}: {
  icon: IconData;
  tone?: Tone;
  color?: string;
  size?: number;
  strokeWidth?: number;
}) {
  const { colors } = useTheme();
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <HugeiconsIcon icon={icon} size={size} color={color ?? colors[tone]} strokeWidth={strokeWidth ?? (size <= 12 ? 1.6 : 1.8)} />
    </View>
  );
}

export function ProviderLogo({
  provider,
  size = 16,
  dim = false,
  inverted = false,
}: {
  provider: ModelProvider;
  size?: number;
  dim?: boolean;
  inverted?: boolean;
}) {
  const id = `logo${useId().replace(/[^\w-]/g, "")}`;
  const { settings, colors } = useTheme();
  const simplified = settings.providerIcons === "simplified";
  const monochrome = inverted ? colors.onInk : colors.ink;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" opacity={dim ? 0.6 : 1} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {simplified ? (
        <Path d={providerLogoPath(provider)} fill={monochrome} fillRule="evenodd" clipRule="evenodd" />
      ) : (
        <>
          {provider === "claude" && <Path d={CLAUDE_LOGO.d} fill={CLAUDE_LOGO.fill} />}
          {provider === "kiro" && <Path d={KIRO_LOGO.d} fill={KIRO_LOGO.fill} fillRule="evenodd" clipRule="evenodd" />}
          {provider === "grok" && <Path d={GROK_LOGO.d} fill={monochrome} fillRule="evenodd" clipRule="evenodd" />}
          {provider === "pi" && <Path d={PI_LOGO.d} fill={monochrome} />}
          {provider === "codex" && (
            <>
              <Defs>
                <LinearGradient id={`${id}-codex`} gradientUnits="userSpaceOnUse" x1="12" x2="12" y1="0" y2="24">
                  {CODEX_LOGO.stops.map((stop) => (
                    <Stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />
                  ))}
                </LinearGradient>
              </Defs>
              <Path d={CODEX_LOGO.d} fill={`url(#${id}-codex)`} fillRule="evenodd" clipRule="evenodd" />
            </>
          )}
          {provider === "antigravity" && (
            <>
              <Defs>
                <Mask id={`${id}-arch`} maskUnits="userSpaceOnUse" x="0" y="1" width="24" height="23">
                  {/* oxlint-disable-next-line milagre-design/no-raw-color -- SVG mask: white is "show", the same in every theme */}
                  <Path d={ANTIGRAVITY_LOGO.d} fill="#fff" />
                </Mask>
                {ANTIGRAVITY_LOGO.blobs.map((blob) => (
                  <Filter
                    key={blob.id}
                    id={`${id}-${blob.id}`}
                    filterUnits="userSpaceOnUse"
                    x={blob.region[0]}
                    y={blob.region[1]}
                    width={blob.region[2]}
                    height={blob.region[3]}
                  >
                    <FeGaussianBlur stdDeviation={blob.blur} />
                  </Filter>
                ))}
              </Defs>
              <G mask={`url(#${id}-arch)`}>
                {ANTIGRAVITY_LOGO.blobs.map((blob) => (
                  <Path key={blob.id} d={blob.d} fill={blob.fill} filter={`url(#${id}-${blob.id})`} />
                ))}
              </G>
            </>
          )}
        </>
      )}
    </Svg>
  );
}

/**
 * One clock for every ring of a kind: a native loop that runs while at least one ring on an active screen is mounted.
 * The value goes from `from` to `from + 1` each turn (rings read it modulo 1 turn), so stopping and starting again
 * continues where it was instead of jumping back. Where it is comes from the time it started, so no native read.
 */
type RingClock = { value: Animated.Value; period: number; users: number; from: number; startedAt: number; loop?: Animated.CompositeAnimation };
const ringClocks: { spin?: RingClock; pulse?: RingClock } = {};

function ringClock(kind: "spin" | "pulse") {
  return (ringClocks[kind] ??= { value: new Animated.Value(0), period: kind === "spin" ? 1100 : 1600, users: 0, from: 0, startedAt: 0 });
}

const ringPhase = (clock: RingClock) => (clock.loop ? (clock.from + (Date.now() - clock.startedAt) / clock.period) % 1 : clock.from);

function joinRingClock(clock: RingClock) {
  clock.users += 1;
  if (clock.loop) return;
  clock.startedAt = Date.now();
  clock.value.setValue(clock.from);
  clock.loop = Animated.loop(
    Animated.timing(clock.value, { toValue: clock.from + 1, duration: clock.period, easing: Easing.linear, useNativeDriver: true, isInteraction: false }),
  );
  clock.loop.start();
}

function leaveRingClock(clock: RingClock) {
  const at = ringPhase(clock);
  clock.users -= 1;
  if (clock.users <= 0 && clock.loop) {
    clock.users = 0;
    clock.loop.stop();
    clock.loop = undefined;
    clock.from = at;
    clock.value.setValue(at);
  }
  return at;
}

type ScreenNavigation = { isFocused(): boolean; addListener(event: "focus" | "blur", listener: () => void): () => void };
let navigationContext: Context<ScreenNavigation | undefined> | undefined;
function screenNavigationContext() {
  return (navigationContext ??= (require("expo-router/react-navigation") as { NavigationContext: Context<ScreenNavigation | undefined> }).NavigationContext);
}
const subscribeAppState = (listener: () => void) => {
  const subscription = AppState.addEventListener("change", listener);
  return () => subscription.remove();
};
const appActive = () => AppState.currentState === "active";
const NO_SCREEN = () => () => {};
const PULSE_LOW = 0.45;

/**
 * display-clock's useScreenActive, for a ring that may also draw outside any screen (the side panels and the iPad's
 * sidebar sit beside the Stack), where useIsFocused throws: there only the app's state counts.
 */
function useRingActive() {
  const navigation = use(screenNavigationContext());
  const subscribeFocus = useCallback(
    (listener: () => void) => {
      if (!navigation) return () => {};
      const offFocus = navigation.addListener("focus", listener);
      const offBlur = navigation.addListener("blur", listener);
      return () => {
        offFocus();
        offBlur();
      };
    },
    [navigation],
  );
  const focused = useSyncExternalStore(navigation ? subscribeFocus : NO_SCREEN, () => navigation?.isFocused() ?? true);
  return useSyncExternalStore(subscribeAppState, appActive, appActive) && focused;
}

export function SpinnerRing({ size = 16, stroke = 2, tone = "ink3", color }: { size?: number; stroke?: number; tone?: Tone; color?: string }) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const active = useRingActive();
  const kind = reduced ? "pulse" : "spin";
  const [stopped, setStopped] = useState(0);
  useEffect(() => {
    if (!active) return;
    const clock = ringClock(kind);
    joinRingClock(clock);
    return () => setStopped(leaveRingClock(clock));
  }, [active, kind]);
  const motion = useMemo(() => {
    if (!active) return reduced ? { opacity: stopped < 0.5 ? 1 : PULSE_LOW } : { transform: [{ rotate: `${stopped * 360}deg` }] };
    const value = ringClock(kind).value;
    return reduced
      ? { opacity: Animated.modulo(value, 1).interpolate({ inputRange: [0, 0.5, 0.5001, 1], outputRange: [1, 1, PULSE_LOW, PULSE_LOW] }) }
      : { transform: [{ rotate: value.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }] };
  }, [active, reduced, kind, stopped]);
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <Animated.View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[{ width: size, height: size }, motion]}>
      <Svg width={size} height={size}>
        <Circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={color ?? colors.line} strokeOpacity={color ? 0.2 : 1} strokeWidth={stroke} />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color ?? colors[tone]}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference * 0.28} ${circumference * 0.72}`}
        />
      </Svg>
    </Animated.View>
  );
}

export function LinearLogo({ size = 12, tone = "ink2" }: { size?: number; tone?: Tone }) {
  const { colors } = useTheme();
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Path d={LINEAR_LOGO.d} fill={colors[tone]} />
    </Svg>
  );
}

export function GithubLogo({ size = 12, tone = "ink2" }: { size?: number; tone?: Tone }) {
  const { colors } = useTheme();
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Path d={GITHUB_LOGO.d} fill={colors[tone]} />
    </Svg>
  );
}
