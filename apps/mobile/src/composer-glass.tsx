import { Platform, StyleSheet, View } from "react-native";
import { BlurView } from "@sbaiahmed1/react-native-blur";
import { withAlpha } from "@milagre/shared/themes";
import { useTheme } from "./theme";

/**
 * Android draws a real blur from 12 (API 31, RenderEffect) up. Older devices re-render the content behind the view on
 * the CPU every frame, which janks the transcript's scroll, so they get the near-opaque surface instead.
 */
const COMPOSER_BLURS = Platform.OS === "ios" || (Platform.OS === "android" && Number(Platform.Version) >= 31);

/**
 * The composer's glass, as on desktop (DESIGN.md › Composer): the surface at 76% over the chip blur, so the transcript
 * reads through it as it scrolls under. Without a blur (older Android, or Reduce Transparency on iOS through the blur's
 * own fallback) the surface is near opaque, so text under it never competes with the prompt. Drawn behind the
 * composer's children; the composer keeps its own border.
 */
export function ComposerGlass({ radius }: { radius: number }) {
  const { colors, scheme } = useTheme();
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius, borderCurve: "continuous", overflow: "hidden" }]}>
      {COMPOSER_BLURS && (
        <BlurView
          blurType={scheme === "dark" ? "dark" : "light"}
          blurAmount={8}
          reducedTransparencyFallbackColor={colors.surface}
          style={StyleSheet.absoluteFill}
        />
      )}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: withAlpha(colors.surface, COMPOSER_BLURS ? 0.76 : 0.95) }]} />
    </View>
  );
}
