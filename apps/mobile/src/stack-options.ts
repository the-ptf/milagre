import { Platform } from "react-native";
import { type } from "./design-tokens";
import type { Palette } from "./theme";

/**
 * The header every Stack in the app shares: inline titles in a transparent bar, content blurring softly under it (iOS 26
 * scroll edge effect). Android has neither the scroll edge effect nor the automatic content inset under a transparent
 * bar, so there the bar is solid page and the content starts below it.
 */
export const stackScreenOptions = (palette: Palette) =>
  ({
    headerTransparent: Platform.OS === "ios",
    headerStyle: { backgroundColor: Platform.OS === "ios" ? "transparent" : palette.page },
    scrollEdgeEffects: { top: "soft" },
    headerTintColor: palette.ink,
    headerTitleStyle: { color: palette.ink, fontWeight: "600", fontSize: type.body },
    contentStyle: { backgroundColor: palette.page },
    headerShadowVisible: false,
    headerBackButtonDisplayMode: "minimal",
  }) as const;
