import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Svg, { Path } from "react-native-svg";
import { router } from "expo-router";
import { QrCodeIcon } from "@hugeicons/core-free-icons";
import { LEFT, RIGHT, STAR } from "./logo";
import { lineHeight, radius, space, type } from "./design-tokens";
import { PillButton } from "./ui";
import { useTheme } from "./theme";

const STEPS = [
  { title: "Get Milagre on your computer", detail: "From milagre.cloud, for macOS, Windows and Linux" },
  { title: "Open Settings › Devices", detail: "Milagre on the computer shows a pairing code" },
  { title: "Scan it with this phone", detail: "Or open the code with the Camera app" },
];

/** The light behind the walkthrough: desktop's onboarding sky, a faint wash of the intro's day over the page. */
function Sky() {
  const { colors, scheme } = useTheme();
  const top = scheme === "dark" ? "#1d2d4a" : "#c6dcf4";
  return (
    <LinearGradient
      pointerEvents="none"
      colors={[top, `${colors.bg}00`]}
      locations={[0, 1]}
      style={[StyleSheet.absoluteFill, { bottom: undefined, height: 420 }]}
    />
  );
}

/**
 * The phone's first screen with no computer paired (desktop onboarding's phone half): how to get a pairing code, and the
 * way to scan it. Scan opens Add computer; "Enter address instead" opens it on its manual form. The light runs under the
 * transparent header; `topInset` keeps the content below it, and `children` (an error) sits above the mark.
 */
export function PairWalkthrough({ topInset, children }: { topInset: number; children?: ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1 }}>
      <Sky />
      <View style={{ flex: 1, paddingHorizontal: space.gutter, paddingTop: topInset + space.xl }}>
        {children}
        <Svg width={40} height={40} viewBox="-4 -4 154 154" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {[LEFT, RIGHT, STAR].map((path) => (
            <Path key={path.slice(0, 12)} d={path} fill={colors.ink} />
          ))}
        </Svg>
        <Text
          accessibilityRole="header"
          style={{ marginTop: space.xl, color: colors.ink, fontSize: type.largeTitle, lineHeight: lineHeight.largeTitle, fontWeight: "700" }}
        >
          Connect your computer
        </Text>
        <Text style={{ marginTop: space.md, color: colors.ink2, fontSize: type.callout, lineHeight: lineHeight.callout }}>
          Milagre on your phone drives the agents on your computer. Pair them once, then pick up any Chat from here.
        </Text>
        <View
          style={{
            marginTop: space.section,
            backgroundColor: colors.surface,
            borderRadius: radius.card,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.line,
            overflow: "hidden",
          }}
        >
          {STEPS.map((step, index) => (
            <View
              key={step.title}
              style={{
                flexDirection: "row",
                gap: space.lg,
                paddingHorizontal: space.xl,
                paddingVertical: space.lg,
                borderTopWidth: index ? StyleSheet.hairlineWidth : 0,
                borderTopColor: colors.line,
              }}
            >
              <View
                style={{
                  width: 26,
                  height: 26,
                  marginTop: 1,
                  borderRadius: radius.full,
                  backgroundColor: colors.ink,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ color: colors.bg, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontWeight: "600" }}>{index + 1}</Text>
              </View>
              <View style={{ flex: 1, gap: space.xxs }}>
                <Text style={{ color: colors.ink, fontSize: type.callout, lineHeight: lineHeight.callout, fontWeight: "600" }}>{step.title}</Text>
                <Text style={{ color: colors.ink2, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>{step.detail}</Text>
              </View>
            </View>
          ))}
        </View>
        <View style={{ marginTop: "auto", paddingBottom: space.xl, gap: space.xs }}>
          <PillButton title="Scan pairing code" icon={QrCodeIcon} size="large" onPress={() => router.push("/add-computer")} />
          <PillButton title="Enter address instead" variant="plain" muted onPress={() => router.push({ pathname: "/add-computer", params: { manual: "1" } })} />
        </View>
      </View>
    </View>
  );
}
