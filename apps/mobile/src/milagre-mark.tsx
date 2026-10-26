import { View } from "react-native";
import Svg, { Path } from "react-native-svg";
import type { Tone } from "./icons";
import { LEFT, RIGHT, STAR } from "./logo";
import { useTheme } from "./theme";

/** The Milagre mark at rest, in the ink color: desktop's MilagreMark, the same paths as the splash. */
export function MilagreMark({ size = 22, tone = "ink" }: { size?: number; tone?: Tone }) {
  const { colors } = useTheme();
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Svg width={size} height={size} viewBox="-4 -4 154 154">
        {[LEFT, RIGHT, STAR].map((d) => (
          <Path key={d} d={d} fill={colors[tone]} />
        ))}
      </Svg>
    </View>
  );
}
