import { useSafeAreaInsets } from "react-native-safe-area-context";
import { chrome, type } from "./design-tokens";
import type { Palette } from "./theme";

/** Where the floating chat header ends: overlays go at `+ 8`, message navigation `+ 20`, the transcript `+ 32`. */
export function useHeaderBottom() {
  return useSafeAreaInsets().top + chrome.header;
}

/** The header every Stack in the app shares: inline titles in a transparent bar, content blurring softly under it (iOS 26 scroll edge effect). */
export const stackScreenOptions = (palette: Palette) =>
  ({
    headerTransparent: true,
    headerStyle: { backgroundColor: "transparent" },
    scrollEdgeEffects: { top: "soft" },
    headerTintColor: palette.ink,
    headerTitleStyle: { color: palette.ink, fontWeight: "600", fontSize: type.body },
    contentStyle: { backgroundColor: palette.page },
    headerShadowVisible: false,
    headerBackButtonDisplayMode: "minimal",
  }) as const;
