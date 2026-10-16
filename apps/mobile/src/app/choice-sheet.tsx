import { useEffect, useRef, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { Stack, router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GitBranchIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { EdgeFade } from "../bottom-fade";
import { currentChoice } from "../choice-store";
import { Icon } from "../icons";
import { useStyles } from "../ui";
import { useTheme } from "../theme";

/** The grabber and title bar of the sheet, which content scrolls under. */
const SHEET_HEADER_HEIGHT = 76;

function ChoiceSeparator() {
  const { colors } = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: 40 }} />;
}

/** Long choice lists use a native sheet with the system search toolbar. */
export default function ChoiceSheet() {
  const { colors } = useTheme();
  const styles = useStyles();
  const [entry] = useState(currentChoice);
  const [query, setQuery] = useState("");
  const [allItems, setAllItems] = useState(() => entry?.items ?? []);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [tab, setTab] = useState(() => entry?.tab);
  const [switching, setSwitching] = useState(false);
  const chosen = useRef<string | null>(null);
  const closing = useRef(false);
  const insets = useSafeAreaInsets();
  useEffect(() => {
    if (!entry) {
      router.back();
      return;
    }
    // Apply after dismissal, like the confirmation sheet: worktree selection changes the Chat's route params.
    return () => entry.choose(chosen.current);
  }, [entry]);
  if (!entry) return null;
  const search = query.trim().toLowerCase();
  const load = entry.load;
  const items = switching ? [] : allItems.filter((item) => `${item.title}\n${item.keywords ?? ""}`.toLowerCase().includes(search));
  const tabs = entry.tabs && entry.tabs.length > 1 ? entry.tabs : null;
  // A pull reads the shown tab from Linear again; a tab reads what the Mac kept, with no rows meanwhile.
  async function reload(next: string | undefined, fresh: boolean) {
    if (!load) return;
    if (fresh) setRefreshing(true);
    else setSwitching(true);
    try {
      const loaded = await load(next, fresh);
      setAllItems(loaded);
      setRefreshError("");
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : String(error));
      if (!fresh) setAllItems([]);
    } finally {
      setRefreshing(false);
      setSwitching(false);
    }
  }
  function chooseTab(next: string) {
    if (next === tab) return;
    setTab(next);
    void reload(next, false);
  }
  const close = (id: string | null) => {
    if (closing.current) return;
    closing.current = true;
    chosen.current = id;
    router.back();
  };
  return (
    <>
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        style={styles.screen}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        refreshControl={load ? <RefreshControl refreshing={refreshing} onRefresh={() => void reload(tab, true)} tintColor={colors.ink3} /> : undefined}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: Math.max(insets.bottom, 16) }}
        ListHeaderComponent={
          <View style={{ paddingTop: 16, paddingBottom: 12, gap: 12 }}>
            {tabs && (
              <View accessibilityRole="tablist" style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                {tabs.map((item) => {
                  const selected = item.id === tab;
                  return (
                    <Pressable
                      key={item.id}
                      accessibilityRole="tab"
                      accessibilityState={{ selected }}
                      onPress={() => chooseTab(item.id)}
                      style={({ pressed }) => ({
                        paddingHorizontal: 12,
                        paddingVertical: 7,
                        borderRadius: 999,
                        borderWidth: StyleSheet.hairlineWidth,
                        borderColor: selected ? colors.ink3 : colors.line,
                        backgroundColor: selected ? colors.hover : pressed ? colors.hover : "transparent",
                      })}
                    >
                      <Text style={{ color: selected ? colors.ink : colors.ink2, fontSize: 13, fontWeight: "500" }}>{item.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            )}
            <Text style={styles.caption}>
              {switching ? "Loading…" : `${items.length} ${items.length === 1 ? "result" : "results"}`}
              {load ? " · Pull to refresh" : ""}
            </Text>
            {refreshError ? <Text style={[styles.caption, { color: colors.error, marginTop: 4 }]}>{refreshError}</Text> : null}
          </View>
        }
        ItemSeparatorComponent={ChoiceSeparator}
        ListEmptyComponent={switching ? undefined : <Text style={[styles.muted, { paddingVertical: 24, textAlign: "center" }]}>{entry.emptyLabel}</Text>}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="radio"
            accessibilityLabel={item.subtitle ? `${item.title}. ${item.subtitle}` : item.title}
            accessibilityState={{ checked: !!item.checked, disabled: !!item.disabled }}
            disabled={item.disabled}
            onPress={() => close(item.id)}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              minHeight: 60,
              paddingHorizontal: 10,
              paddingVertical: 14,
              borderRadius: 10,
              borderCurve: "continuous",
              // The chosen row shows only its tick, like the Linear issue rows; no fill.
              backgroundColor: pressed ? colors.hover : "transparent",
              opacity: item.disabled ? 0.4 : 1,
            })}
          >
            {entry.leading ?? <Icon icon={entry.icon ?? GitBranchIcon} tone={item.checked ? "accent" : "ink3"} size={18} />}
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: colors.ink, fontSize: 15, lineHeight: 20 }}>{item.title}</Text>
              {item.subtitle && (
                <Text numberOfLines={1} ellipsizeMode="middle" style={styles.caption}>
                  {item.subtitle}
                </Text>
              )}
            </View>
            <View style={{ width: 18 }}>{item.checked && <Icon icon={Tick02Icon} tone="accent" size={18} />}</View>
          </Pressable>
        )}
      />
      {/* Rows blur and fade under the transparent title bar, as in the Chat: the sheet doesn't get iOS's soft scroll edge. */}
      <EdgeFade edge="top" height={SHEET_HEADER_HEIGHT} />
      <Stack.Title>{entry.title}</Stack.Title>
      <Stack.SearchBar
        placeholder={entry.placeholder}
        placement="integrated"
        allowToolbarIntegration
        autoCapitalize="none"
        hideWhenScrolling={false}
        hideNavigationBar={false}
        obscureBackground={false}
        onChangeText={(event) => setQuery(event.nativeEvent.text)}
        onCancelButtonPress={() => setQuery("")}
      />
      {/* HIG: a sheet's close button sits on the leading edge. */}
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button icon="xmark" onPress={() => close(null)}>
          Close
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Stack.Toolbar placement="bottom">
        <Stack.Toolbar.SearchBarSlot />
      </Stack.Toolbar>
    </>
  );
}
