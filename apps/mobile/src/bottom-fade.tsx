import { StyleSheet, View } from "react-native";
import { ProgressiveBlurView } from "@sbaiahmed1/react-native-blur";
import { LinearGradient } from "expo-linear-gradient";
import { useTheme } from "./theme";

/**
 * Desktop's .progressive-blur (styles.css): content softens into the page at a screen edge. A native variable blur,
 * whose radius grows toward the edge, so no crisp copy shows through the way it does under one masked blur. The blur
 * and page-colored tint build linearly across the whole overlay, reaching full strength only at the screen edge.
 */
export function EdgeFade({ edge, height, width }: { edge: "top" | "bottom"; height: number; width?: number }) {
  const page = useTheme().colors.page;
  // Gradients run from the open side toward the screen edge.
  const flip = edge === "top" ? { start: { x: 0, y: 1 }, end: { x: 0, y: 0 } } : {};
  // A fixed `width` keeps the fade its size while the view under it grows or shrinks (the iPad's Chat as the sidebar
  // slides): resized, the blur and gradient are redrawn on the CPU every frame of the slide.
  const across = width === undefined ? { right: 0 } : { width };
  return (
    <View pointerEvents="none" style={{ position: "absolute", left: 0, ...across, [edge]: 0, height }}>
      <ProgressiveBlurView
        direction={edge === "top" ? "blurredTopClearBottom" : "blurredBottomClearTop"}
        startOffset={0}
        blurAmount={10}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient {...flip} colors={[`${page}00`, `${page}${edge === "bottom" ? "99" : "e6"}`]} style={StyleSheet.absoluteFill} />
    </View>
  );
}
export const BottomFade = ({ height, width }: { height: number; width?: number }) => <EdgeFade edge="bottom" height={height} width={width} />;
