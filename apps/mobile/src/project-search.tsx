import { useEffect, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { Search01Icon } from "@hugeicons/core-free-icons";
import { useSession } from "./session";
import { Icon } from "./icons";
import { ProjectIcon } from "./project-icon";
import { Field, useStyles } from "./ui";
import { createStylesHook, useTheme, type Palette } from "./theme";

type Found = { path: string; name: string };
type Results = { query: string; items: Found[]; error?: string };

/** A home-folder path as the Mac's Finder would show it. */
const shortPath = (value: string) => value.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");

/**
 * Finds a Project on the computer by name: the Git repositories in its home folder (project:find). A full path still
 * opens directly, for a folder outside the home or a Mac whose Milagre can't search yet.
 */
export function ProjectSearch({ onOpen }: { onOpen: (path: string) => void }) {
  const s = useS();
  const { colors } = useTheme();
  const styles = useStyles();
  const session = useSession();
  const client = session.client;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Results | null>(null);
  useEffect(() => {
    if (!client) return;
    let live = true;
    // Typing waits a beat; the Mac scans once and answers later queries from that scan.
    const timer = setTimeout(
      () => {
        void client
          .call<Found[]>("project:find", [query.trim()])
          .then((items) => {
            if (live) setResults({ query, items: Array.isArray(items) ? items : [] });
          })
          .catch((e) => {
            if (live)
              setResults({
                query,
                items: [],
                error: /not available from mobile/i.test((e as Error).message)
                  ? "Update Milagre on your Mac to search its projects. You can still type a full path."
                  : (e as Error).message,
              });
          });
      },
      query ? 220 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, query]);
  const typed = query.trim();
  const path = typed.startsWith("/") ? typed : "";
  const recent = new Set(session.recent.map((item) => item.path));
  const current = results?.query === query ? results : null;
  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 16, paddingBottom: 12, gap: 10 }}>
        <View style={s.search}>
          <Icon icon={Search01Icon} tone="ink3" size={18} />
          <View style={{ flex: 1 }}>
            <Field
              label="Search projects on your computer"
              hideLabel
              placeholder="Search projects on your computer"
              value={query}
              onChangeText={setQuery}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              autoComplete="off"
              clearButtonMode="while-editing"
              returnKeyType="go"
              onSubmitEditing={() => {
                if (path) onOpen(path);
                else if (current?.items[0]) onOpen(current.items[0].path);
              }}
              style={{ backgroundColor: "transparent", paddingHorizontal: 0, paddingVertical: 8 }}
            />
          </View>
        </View>
        {current?.error ? <Text style={[styles.muted, { color: colors.orange }]}>{current.error}</Text> : null}
      </View>
      <FlatList
        data={current?.items ?? []}
        keyExtractor={(item) => item.path}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 24 }}
        ListHeaderComponent={path ? <Row title={`Open ${shortPath(path)}`} detail="Full path" onPress={() => onOpen(path)} /> : undefined}
        ListEmptyComponent={
          path ? undefined : (
            <Text style={[styles.muted, { padding: 16 }]}>
              {!current
                ? "Searching your computer…"
                : current.error
                  ? ""
                  : typed
                    ? "No Git repository matches."
                    : "No Git repositories found in your home folder."}
            </Text>
          )
        }
        renderItem={({ item }) => (
          <Row
            icon={<ProjectIcon client={client} path={item.path} />}
            title={item.name}
            detail={`${shortPath(item.path)}${recent.has(item.path) ? " · In your list" : ""}`}
            onPress={() => onOpen(item.path)}
          />
        )}
      />
    </View>
  );
}

function Row({ icon, title, detail, onPress }: { icon?: React.ReactNode; title: string; detail: string; onPress: () => void }) {
  const s = useS();
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${detail}`}
      onPress={onPress}
      style={({ pressed }) => [s.row, { backgroundColor: pressed ? colors.hover : "transparent" }]}
    >
      {icon}
      <View style={{ flex: 1, gap: 3 }}>
        <Text numberOfLines={1} style={{ color: colors.ink, fontSize: 15, fontWeight: "500" }}>
          {title}
        </Text>
        <Text numberOfLines={1} ellipsizeMode="head" style={{ color: colors.ink2, fontSize: 12 }}>
          {detail}
        </Text>
      </View>
    </Pressable>
  );
}

const makeS = (colors: Palette) =>
  StyleSheet.create({
    search: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
      borderRadius: 10,
      borderCurve: "continuous",
      backgroundColor: colors.field,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      minHeight: 56,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 8,
      borderCurve: "continuous",
    },
  });
const useS = createStylesHook(makeS);
