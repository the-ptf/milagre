import { Animated, StyleSheet, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { LEFT, RIGHT, STAR, STAR_BOX } from "./logo";
import { hold, twinkleCurve, useKeyframes } from "./running-logo";
import { useTheme } from "./theme";

/** The splash mark, shared with full-screen loading states. */
export function LoadingLogo({ size = 64 }: { size?: number }) {
  const mark = useTheme().colors.ink;
  const scale = size / 154;
  // splash-star-twinkle: 0%, 55% rest; 75% { scale(0.82) rotate(45deg) }; 100% { rotate(90deg) }, 2400ms.
  const twinkle = useKeyframes([hold(1320), { to: 1, duration: 480, easing: twinkleCurve }, { to: 2, duration: 600, easing: twinkleCurve }], 300);
  const starStyle = {
    transform: [
      { scale: twinkle.interpolate({ inputRange: [0, 1, 2], outputRange: [1, 0.82, 1] }) },
      { rotate: twinkle.interpolate({ inputRange: [0, 1, 2], outputRange: ["0deg", "45deg", "90deg"] }) },
    ],
  };
  const layer = (path: string) => (
    <Svg width={size} height={size} viewBox="-4 -4 154 154" style={StyleSheet.absoluteFill}>
      <Path d={path} fill={mark} />
    </Svg>
  );
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size }}>
      {layer(LEFT)}
      {layer(RIGHT)}
      <Animated.View
        style={[
          { position: "absolute", left: (STAR_BOX.x + 4) * scale, top: (STAR_BOX.y + 4) * scale, width: STAR_BOX.size * scale, height: STAR_BOX.size * scale },
          starStyle,
        ]}
      >
        <Svg width="100%" height="100%" viewBox={`${STAR_BOX.x} ${STAR_BOX.y} ${STAR_BOX.size} ${STAR_BOX.size}`}>
          <Path d={STAR} fill={mark} />
        </Svg>
      </Animated.View>
    </View>
  );
}
