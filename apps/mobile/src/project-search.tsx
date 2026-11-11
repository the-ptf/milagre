import { useEffect, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { Folder01Icon, GitBranchIcon, GitForkIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { useSession } from "./session";
import { Icon } from "./icons";
import { ProjectIcon } from "./project-icon";
import { lineHeight, radius, type } from "./design-tokens";
import { Field, InlineError, PillButton, RowCheckbox, pressStyle, useStyles } from "./ui";
import { createStylesHook, useTheme, type Palette } from "./theme";
import { treeLayout } from "@milagre/shared/chat-display";
import { useChatList } from "./chat-display-setting";
import type { FolderScan } from "@milagre/shared/project-list";

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
  // A typed folder with repositories inside: the step that adds them takes the search's place.
  const [scan, setScan] = useState<FolderScan | null>(null);
  const [checking, setChecking] = useState(false);
  // A typed path is checked for repositories inside it first (the Mac's Settings › Worktrees › Detect repositories in a
  // folder can turn that off); a computer whose Milagre can't check opens it as one Project, as before.
  async function openTyped(folder: string) {
    if (!client || checking) return;
    setChecking(true);
    const found = await client.call<FolderScan>("project:scan-children", [folder]).catch(() => null);
    setChecking(false);
    // A repository with repositories inside (submodules, a monorepo) opens as one Project.
    if (found?.detect && !found.git && found.children.some((child) => child.git)) setScan(found);
    else onOpen(folder);
  }
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
  if (scan) return <ImportFolderForm scan={scan} onBack={() => setScan(null)} onOpen={onOpen} />;
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
            if (path) void openTyped(path);
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
            {path ? (
              <Row title={`Open ${shortPath(path)}`} detail={checking ? "Checking the folder…" : "Full path"} onPress={() => void openTyped(path)} />
            ) : null}
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

/**
 * Adds a folder that holds repositories, as desktop's Add Project does: repositories start checked, other folders
 * unchecked. The checked ones open as Projects and, two or more, get a Named Link named after the folder; the Tree
 * layout comes on to draw it. "Open as one Project" opens the folder itself.
 */
function ImportFolderForm({ scan, onBack, onOpen }: { scan: FolderScan; onBack: () => void; onOpen: (path: string) => void }) {
  const client = useSession().client;
  const styles = useStyles();
  const { colors } = useTheme();
  const [selected, setSelected] = useState<string[]>(() => scan.children.filter((child) => child.chosen).map((child) => child.path));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [chatList, setChatList] = useChatList();
  const name = scan.folder.split("/").findLast(Boolean) ?? scan.folder;
  const chosen = scan.children.map((child) => child.path).filter((path) => selected.includes(path));
  const toggle = (path: string) => setSelected((current) => (current.includes(path) ? current.filter((item) => item !== path) : [...current, path]));
  async function add(grouped: boolean) {
    if (!client || busy) return;
    setBusy(true);
    setError("");
    try {
      if (!grouped) {
        onOpen(scan.folder);
        return;
      }
      const opened: string[] = [];
      for (const folder of chosen) opened.push((await client.call<{ path: string }>("project:open", [folder])).path);
      if (opened.length > 1) {
        const registered = await client.call<{ id: string; path: string }[]>("project:registry", []);
        const projectIds = opened.map((path) => registered.find((entry) => entry.path === path)?.id).filter((id): id is string => !!id);
        if (projectIds.length > 1) await client.call("link:create", [{ name, projectIds }]);
        const layout = treeLayout(chatList);
        if (layout) setChatList(layout);
      }
      onOpen(opened[0]!);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <View style={{ flex: 1 }}>
      <Text style={[styles.muted, { paddingHorizontal: 16, paddingBottom: 12 }]}>
        {`${name} holds ${scan.children.filter((child) => child.git).length} repositories. Add the ones you check as Projects, grouped by a Link named ${name}.`}
      </Text>
      <FlatList
        data={scan.children}
        keyExtractor={(item) => item.path}
        contentContainerStyle={{ paddingHorizontal: 4, paddingBottom: 12 }}
        renderItem={({ item }) => (
          <Row
            icon={<Icon icon={item.git ? GitBranchIcon : Folder01Icon} tone="ink3" size={20} />}
            title={item.name}
            detail={item.relative === item.name ? (item.git ? "Git repository" : "Folder") : item.relative}
            onPress={() => toggle(item.path)}
            trailing={<RowCheckbox label={item.name} selected={selected.includes(item.path)} disabled={busy} onPress={() => toggle(item.path)} />}
          />
        )}
      />
      <View style={{ paddingHorizontal: 16, paddingBottom: 16, gap: 12 }}>
        <InlineError warning message={error} />
        <Text style={{ color: colors.ink2, fontSize: type.caption1 }}>{`${chosen.length} of ${scan.children.length} selected`}</Text>
        <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <PillButton title="Back" variant="plain" muted disabled={busy} onPress={onBack} />
          <PillButton title="Open as one Project" variant="plain" disabled={busy} onPress={() => void add(false)} />
          <PillButton
            title={`Add ${chosen.length} Project${chosen.length === 1 ? "" : "s"}`}
            loading={busy}
            disabled={!chosen.length}
            onPress={() => void add(true)}
          />
        </View>
      </View>
    </View>
  );
}

function Row({
  icon,
  title,
  detail,
  onPress,
  trailing,
}: {
  icon?: React.ReactNode;
  title: string;
  detail: string;
  onPress: () => void;
  trailing?: React.ReactNode;
}) {
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
      {trailing}
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
