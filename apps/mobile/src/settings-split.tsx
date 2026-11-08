import React, { useEffect, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useKeyboardState } from "react-native-keyboard-controller";
import { router } from "expo-router";
import { Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HeaderButton } from "./ui";
import { SettingsResults, SettingsView } from "./app/(settings)/settings";
import { Field } from "./primitives/field";
import { Icon } from "./icons";
import { useTheme } from "./theme";
import { lineHeight, radius, type } from "./design-tokens";
import { narrowSettingsRoutes, selectedSettingsRow, wideSettingsRoutes, type SettingsStackRoute } from "./settings-split-routes";

/** From this card width the list sits beside the page, as desktop's Settings modal; narrower, it is the Stack's first page. */
export const SETTINGS_SPLIT_MIN = 700;
const SIDEBAR_WIDTH = 320;
/** Desktop's Settings modal: at most 1120 × 800, kept 24 pt off the window's edges. */
const CARD_MAX = { width: 1120, height: 800 };
const CARD_MARGIN = 24;

type StackState = { key: string; index: number; routeNames: string[]; routeKeySeq: number; routes: SettingsStackRoute[] };
type Props = {
  state: StackState;
  // The navigator's reset: a route without a key gets one when the state is complete (`stale: false`).
  navigation: { reset(state: never): void };
  children: React.ReactNode;
};

/**
 * The Settings sheet's Stack. A phone keeps the native one-column sheet. An iPad gets a card over a scrim (the root layout
 * presents the group as a transparent modal) with the list beside the Stack once the card is wide enough: a tap in the
 * list replaces the page, and a page's own rows (a computer, the speech model) still push inside it.
 */
export function SettingsSplit({ state, navigation, children }: Props) {
  const pad = Platform.OS === "ios" && Platform.isPad;
  if (!pad) return <>{children}</>;
  return (
    <SettingsCard state={state} navigation={navigation}>
      {children}
    </SettingsCard>
  );
}

function SettingsCard({ state, navigation, children }: Props) {
  const { colors } = useTheme();
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const width = Math.min(CARD_MAX.width, window.width - 2 * CARD_MARGIN);
  // With the keyboard up (search, a field on a page) the card fits the space above it instead of hiding under it.
  const keyboard = useKeyboardState((shown) => (shown.isVisible ? shown.height : 0));
  const edge = Math.max(CARD_MARGIN, insets.top);
  const height = Math.min(CARD_MAX.height, window.height - edge - Math.max(edge, insets.bottom, keyboard + CARD_MARGIN));
  const wide = width >= SETTINGS_SPLIT_MIN;
  const next = wide ? wideSettingsRoutes(state.routes) : narrowSettingsRoutes(state.routes);
  // The router takes only a complete state: the Stack's own, with the new routes (a route without a key gets one).
  const reset = (routes: SettingsStackRoute[]) => navigation.reset({ ...state, index: routes.length - 1, routes, stale: false } as never);
  useEffect(() => {
    if (next) reset(next);
  });
  const open = (page: string, params?: object) => {
    // Routines is a full page of the app, not a page of Settings: close Settings, then open it over the Chat.
    if (page === "routines") {
      router.back();
      router.push("/routines");
      return;
    }
    reset([{ name: page, ...(params ? { params } : {}) }]);
  };
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingBottom: keyboard }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close Settings"
        onPress={() => router.back()}
        style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }]}
      />
      <View
        accessibilityViewIsModal
        style={{
          width,
          height,
          flexDirection: "row",
          overflow: "hidden",
          borderRadius: radius.sheet,
          borderCurve: "continuous",
          backgroundColor: colors.page,
          boxShadow: colors.shadowOverlay,
        }}
      >
        {wide ? (
          <View style={{ width: SIDEBAR_WIDTH, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.line, backgroundColor: colors.page }}>
            <SettingsSidebar selected={selectedSettingsRow(state.routes)} onOpen={open} />
          </View>
        ) : null}
        {/* Until the Stack drops the list, the page side would draw the list beside itself for a frame. */}
        <View style={{ flex: 1, opacity: next ? 0 : 1 }}>{children}</View>
      </View>
    </View>
  );
}

function SettingsSidebar({ selected, onOpen }: { selected?: string; onOpen: (page: string, params?: object) => void }) {
  const { colors } = useTheme();
  const [query, setQuery] = useState("");
  return (
    <ScrollView
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 20, paddingBottom: 32, gap: 16 }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      {/* The pages beside start without a Back, so the card's one way out besides the scrim sits here, as desktop's ×. */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: type.title3, lineHeight: lineHeight.title3, fontWeight: "600" }}>
          Settings
        </Text>
        <HeaderButton label="Close Settings" icon={Cancel01Icon} onPress={() => router.back()} />
      </View>
      <Field
        label="Search settings"
        hideLabel
        placeholder="Search settings"
        value={query}
        onChangeText={setQuery}
        returnKeyType="search"
        clearButtonMode="while-editing"
        leading={<Icon icon={Search01Icon} tone="ink3" size={18} />}
      />
      {query.trim() ? (
        <SettingsResults query={query} onOpen={(page, find) => onOpen(page, find ? { find, findAt: String(Date.now()) } : undefined)} />
      ) : (
        <SettingsView selected={selected} onOpen={(page) => onOpen(page)} onOpenProject={(path, name) => onOpen("project-settings", { path, name })} />
      )}
    </ScrollView>
  );
}
