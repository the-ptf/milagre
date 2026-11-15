import { Platform, StyleSheet, View } from "react-native";
import { LiquidGlassView } from "@sbaiahmed1/react-native-blur";
import { radius as radii } from "../design-tokens";
import { useTheme } from "../theme";

/**
 * The surface behind a floating control: Liquid Glass on iOS. Android has no Liquid Glass, and the library's stand-in
 * smears the edges into grey blobs, so there the control sits on the raised surface instead.
 */
export function GlassSurface({ radius = radii.full }: { radius?: number }) {
  const { colors } = useTheme();
  const shape = { borderRadius: radius, borderCurve: "continuous" } as const;
  if (Platform.OS !== "ios")
    return <View pointerEvents="none" style={[StyleSheet.absoluteFill, shape, { backgroundColor: colors.surface, boxShadow: colors.shadowRaised }]} />;
  return (
    <LiquidGlassView
      pointerEvents="none"
      glassType="regular"
      isInteractive={false}
      reducedTransparencyFallbackColor={colors.surface}
      style={[StyleSheet.absoluteFill, shape]}
    />
  );
}
