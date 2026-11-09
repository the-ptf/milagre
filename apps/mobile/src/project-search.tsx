import { useEffect, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { GitForkIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { useSession } from "./session";
import { Icon } from "./icons";
import { ProjectIcon } from "./project-icon";
import { lineHeight, radius, type } from "./design-tokens";
import { Field, InlineError, PillButton, pressStyle, useStyles } from "./ui";
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
  const styles = useStyles();
  const session = useSession();
  const client = session.client;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Results | null>(null);
  const [cloning, setCloning] = useState(false);
  useEffect(() => {
    if (!client || cloning) return;
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
                  ? "Update Milagre on your Mac to search its Projects. You can still type a full path."
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
  }, [client, query, cloning]);
  if (cloning) return <CloneForm onBack={() => setCloning(false)} onOpen={onOpen} />;
  const typed = query.trim();
  const path = typed.startsWith("/") ? typed : "";
  const recent = new Set(session.recent.map((item) => item.path));
  const current = results?.query === query ? results : null;
  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 16, paddingBottom: 12, gap: 12 }}>
        <Field
          label="Search Projects on your computer"
          hideLabel
          leading={<Icon icon={Search01Icon} tone="ink3" size={18} />}
          placeholder="Search Projects on your computer"
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
        />
        <InlineError warning message={current?.error} />
      </View>
      <FlatList
        data={current?.items ?? []}
        keyExtractor={(item) => item.path}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingHorizontal: 4, paddingBottom: 24 }}
        ListHeaderComponent={
          <>
            <Row
              icon={<Icon icon={GitForkIcon} tone="ink3" size={20} />}
              title="Clone a repository"
              detail="From a GitHub or Git address"
              onPress={() => setCloning(true)}
            />
            {path ? <Row title={`Open ${shortPath(path)}`} detail="Full path" onPress={() => onOpen(path)} /> : null}
          </>
        }
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

/**
 * Clones a repository on the computer (onboarding:clone, as desktop's Add Project) and opens it. The folder is typed, since
 * a phone can't browse the computer's folders; empty is ~/Code, where the computer makes it when missing.
 */
function CloneForm({ onBack, onOpen }: { onBack: () => void; onOpen: (path: string) => void }) {
  const client = useSession().client;
  const [url, setUrl] = useState("");
  const [parent, setParent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function clone() {
    if (!client || busy || !url.trim()) return;
    setBusy(true);
    setError("");
    try {
      const opened = await client.call<{ path: string }>("onboarding:clone", [url.trim(), parent.trim() || undefined]);
      onOpen(opened.path);
    } catch (e) {
      const message = (e as Error).message;
      setError(/not available from mobile/i.test(message) ? "Update Milagre on your computer to clone repositories from your phone." : message);
      setBusy(false);
    }
  }
  return (
    <View style={{ flex: 1, paddingHorizontal: 16, gap: 12 }}>
      <Field
        label="Repository address"
        placeholder="https://github.com/owner/repository"
        value={url}
        onChangeText={setUrl}
        editable={!busy}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        keyboardType="url"
        clearButtonMode="while-editing"
        returnKeyType="next"
      />
      <Field
        label="Clone into"
        placeholder="~/Code"
        value={parent}
        onChangeText={setParent}
        editable={!busy}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        clearButtonMode="while-editing"
        returnKeyType="go"
        onSubmitEditing={() => void clone()}
      />
      <InlineError warning message={error} />
      <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
        <PillButton title="Back" variant="plain" muted disabled={busy} onPress={onBack} />
        <PillButton title="Clone" loading={busy} disabled={!url.trim()} onPress={() => void clone()} />
      </View>
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
      style={({ pressed }) => [s.row, pressStyle({ pressed, kind: "row" })]}
    >
      {icon}
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={{ color: colors.ink, fontSize: type.callout, lineHeight: lineHeight.callout, fontWeight: "500" }}>
          {title}
        </Text>
        <Text numberOfLines={1} ellipsizeMode="head" style={{ color: colors.ink2, fontSize: type.caption1, lineHeight: lineHeight.caption1 }}>
          {detail}
        </Text>
      </View>
    </Pressable>
  );
}

const makeS = (_colors: Palette) =>
  StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      minHeight: 56,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: radius.control,
      borderCurve: "continuous",
    },
  });
const useS = createStylesHook(makeS);
