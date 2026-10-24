import type { Palette } from "./theme";

/** The header every Stack in the app shares: inline titles in a transparent bar, content blurring softly under it (iOS 26 scroll edge effect). */
export const stackScreenOptions = (palette: Palette) =>
  ({
    headerTransparent: true,
    headerStyle: { backgroundColor: "transparent" },
    scrollEdgeEffects: { top: "soft" },
    headerTintColor: palette.ink,
    headerTitleStyle: { color: palette.ink, fontWeight: "600", fontSize: 17 },
    contentStyle: { backgroundColor: palette.page },
    headerShadowVisible: false,
    headerBackButtonDisplayMode: "minimal",
  }) as const;
