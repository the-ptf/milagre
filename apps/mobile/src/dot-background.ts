import type { ViewStyle } from "react-native";
import { useTheme } from "./theme";

/**
 * Desktop's DotBackground as a background style: a 20px grid of 1px dots (line-strong, line in dark mode), covered by
 * the page color everywhere except a soft ellipse in the middle. It is painted on the screen's own background rather
 * than as a view, because iOS finds the transcript for its native top edge blur only through each view's first child.
 */
export function useDotBackground(): ViewStyle {
  const { colors: palette, scheme, settings } = useTheme();
  if (settings.dots === "off") return { backgroundColor: palette.page };
  const dot = scheme === "dark" ? palette.line : palette.lineStrong;
  return {
    backgroundColor: palette.page,
    experimental_backgroundImage: `radial-gradient(ellipse at center, ${palette.page}00 20%, ${palette.page} 100%), radial-gradient(circle, ${dot} 1px, ${dot}00 1px)`,
    experimental_backgroundSize: "100% 100%, 20px 20px",
    experimental_backgroundRepeat: "no-repeat, repeat",
  };
}
