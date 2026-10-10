import { useEffect, useId, useState } from "react";
import { Animated, Easing, View } from "react-native";
import Svg, { Circle, Defs, FeGaussianBlur, Filter, G, LinearGradient, Mask, Path, Stop } from "react-native-svg";
import { ANTIGRAVITY_LOGO, CLAUDE_LOGO, CODEX_LOGO, LINEAR_LOGO } from "@milagre/shared/provider-logos";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react-native";
import type { ModelProvider } from "@milagre/shared/model";
import { useTheme, type Palette } from "./theme";

export type Tone = { [K in keyof Palette]: Palette[K] extends string ? K : never }[keyof Palette];
export type IconData = IconSvgElement;

/** Desktop's icon set (Hugeicons), so the same action looks the same on both apps. */
export function Icon({
  icon,
  tone = "ink2",
  color,
  size = 18,
  strokeWidth = 1.8,
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
      <HugeiconsIcon icon={icon} size={size} color={color ?? colors[tone]} strokeWidth={strokeWidth} />
    </View>
  );
}

/** Each agent's brand mark in its own colors, the same shapes as desktop's ProviderLogo (@milagre/shared/provider-logos). */
export function ProviderLogo({ provider, size = 15, dim = false }: { provider: ModelProvider; size?: number; dim?: boolean }) {
  // Gradient, mask and filter ids are per instance: two logos on one screen must not share them.
  const id = `logo${useId().replace(/[^\w-]/g, "")}`;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" opacity={dim ? 0.6 : 1} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {provider === "claude" && <Path d={CLAUDE_LOGO.d} fill={CLAUDE_LOGO.fill} />}
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
    </Svg>
  );
}

/** Desktop's SpinnerRing: a line-colored track with a short ink-3 arc turning once every 1.1s. */
export function SpinnerRing({ size = 14, stroke = 2, tone = "ink3", color }: { size?: number; stroke?: number; tone?: Tone; color?: string }) {
  const { colors } = useTheme();
  const [spin] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 1100, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [spin]);
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size, transform: [{ rotate }] }}>
      <Svg width={size} height={size}>
        <Circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={color ?? colors.lineStrong} strokeOpacity={color ? 0.2 : 1} strokeWidth={stroke} />
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

/** Linear's mark, on Linear issue chips and pickers (same shape as desktop's LinearLogo), in the color of the text beside it. */
export function LinearLogo({ size = 12, tone = "ink2" }: { size?: number; tone?: Tone }) {
  const { colors } = useTheme();
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Path d={LINEAR_LOGO.d} fill={colors[tone]} />
    </Svg>
  );
}
