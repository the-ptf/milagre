import { LINK_CHAT_WORKTREES_TEXT, LINK_UPDATE_WORKTREES_TEXT } from "@milagre/shared/worktree-link";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { scopeKey } from "@milagre/shared/chat-scopes";
import type { NamedProjectLink } from "@milagre/shared/model";
import type { RegisteredProject } from "../client";
import { useSession } from "../session";
import { usePanelNavigation } from "../side-panels";
import { ProjectIcon } from "../project-icon";
import { useRpc } from "../use-rpc";
import { ErrorNotice, Field, PageScroll, useStyles } from "../ui";
import { useTheme } from "../theme";

/** Creates a Link, or with `linkId` edits that Link's name and member Projects. Chats already started keep their Worktrees. */
export default function LinkProjects() {
  const { colors } = useTheme();
  const styles = useStyles();
  const session = useSession();
  const { linkId } = useLocalSearchParams<{ linkId?: string }>();
  const editing = linkId ? session.recent.find((item) => item.link?.id === linkId) : undefined;
  const navigate = usePanelNavigation();
  const current = useRef(session.client);
  useEffect(() => {
    current.current = session.client;
  }, [session.client]);
  const { data, loading, error: loadError } = useRpc<RegisteredProject[]>(session.client, "project:registry", []);
  // A member whose folder is gone is still listed, so it can be removed.
  const projects = [
    ...(data ?? []),
    ...(data
      ? (editing?.projects ?? []).filter((member) => !data.some((project) => project.id === member.id)).map((member) => ({ ...member, path: "Unavailable" }))
      : []),
  ];
  const [selected, setSelected] = useState<string[]>(() => editing?.link?.projectIds ?? []);
  const [name, setName] = useState(editing?.name ?? "");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ready = !loading && !busy && name.trim() && selected.length >= 2 && selected.every((id) => projects.some((project) => project.id === id));
  const failure =
    error ||
    (linkId && !editing ? "This Link no longer exists." : "") ||
    (/not available from mobile/i.test(loadError) ? "Update Milagre on your Mac to link Projects from your phone." : loadError);
  async function create() {
    const client = session.client;
    if (!client || !ready) return;
    setBusy(true);
    setError("");
    try {
      if (linkId) {
        await client.call<NamedProjectLink>("link:update", [{ id: linkId, name: name.trim(), projectIds: selected }]);
        if (current.current !== client) return;
        await session.reloadProjects();
        await session.refresh().catch(() => {});
        router.back();
        return;
      }
      const link = await client.call<NamedProjectLink>("link:create", [{ name: name.trim(), projectIds: selected }]);
      if (current.current !== client) {
        setError("The Link was created on the previous computer. Switch back to open it.");
        return;
      }
      await session.reloadProjects();
      navigate({ pathname: "/chat", params: { projectPath: scopeKey({ kind: "link", linkId: link.id }), hostId: client.url } });
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const choices = projects.filter((project) => `${project.name} ${project.path}`.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <PageScroll style={styles.screen} contentContainerStyle={{ gap: 20, padding: 20 }} automaticallyAdjustKeyboardInsets>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => router.back()} style={{ minHeight: 44, justifyContent: "center" }}>
          <Text style={[styles.text, { color: colors.ink2 }]}>Cancel</Text>
        </Pressable>
        <Text accessibilityRole="header" style={{ flex: 1, textAlign: "center", color: colors.ink, fontSize: 17, fontWeight: "600" }}>
          {linkId ? "Edit Link" : "Link projects"}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={linkId ? (busy ? "Saving Link" : "Save Link") : busy ? "Creating Link" : "Create Link"}
          disabled={!ready}
          onPress={() => void create()}
          style={{ minHeight: 44, justifyContent: "center", opacity: ready ? 1 : 0.4 }}
        >
          <Text style={[styles.text, { fontWeight: "600" }]}>{linkId ? (busy ? "Saving..." : "Save") : busy ? "Creating..." : "Create"}</Text>
        </Pressable>
      </View>
      <Text style={styles.muted}>{linkId ? LINK_UPDATE_WORKTREES_TEXT : LINK_CHAT_WORKTREES_TEXT}</Text>
      <Field label="Link name" value={name} onChangeText={setName} placeholder="e.g. RDFood" autoFocus editable={!busy} returnKeyType="next" />
      <Field
        label="Search projects"
        hideLabel
        value={query}
        onChangeText={setQuery}
        placeholder="Search projects"
        editable={!busy}
        clearButtonMode="while-editing"
      />
      <PageScroll
        accessibilityLabel="Projects"
        contentInsetAdjustmentBehavior="never"
        style={{ maxHeight: 264, borderRadius: 12, backgroundColor: colors.surface }}
        contentContainerStyle={{ padding: 4, paddingBottom: 4, gap: 0 }}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
      >
        {loading
          ? Array.from({ length: 4 }, (_, index) => (
              <View
                key={index}
                accessible={index === 0}
                accessibilityLabel="Loading Projects"
                style={{ height: 64, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12 }}
              >
                <View style={{ width: 28, height: 28, borderRadius: 7, backgroundColor: colors.field }} />
                <View style={{ flex: 1, gap: 8 }}>
                  <View style={{ width: "60%", height: 12, borderRadius: 4, backgroundColor: colors.field }} />
                  <View style={{ width: "80%", height: 10, borderRadius: 4, backgroundColor: colors.field }} />
                </View>
              </View>
            ))
          : choices.map((project) => {
              const checked = selected.includes(project.id);
              return (
                <Pressable
                  key={project.id}
                  accessibilityRole="checkbox"
                  accessibilityLabel={project.name}
                  accessibilityState={{ checked, disabled: busy }}
                  disabled={busy}
                  onPress={() => setSelected((previous) => (checked ? previous.filter((id) => id !== project.id) : [...previous, project.id]))}
                  style={({ pressed }) => ({
                    height: 64,
                    paddingHorizontal: 12,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 12,
                    backgroundColor: pressed ? colors.hover : "transparent",
                  })}
                >
                  <View
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 5,
                      borderWidth: checked ? 0 : 1.5,
                      borderColor: colors.ink3,
                      backgroundColor: checked ? colors.ink : "transparent",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {checked && <Text style={{ color: colors.surface, fontSize: 15, fontWeight: "600" }}>✓</Text>}
                  </View>
                  <ProjectIcon client={session.client} path={project.path} />
                  <View style={{ flex: 1, gap: 4 }}>
                    <Text numberOfLines={1} style={[styles.text, { fontSize: 15 }]}>
                      {project.name}
                    </Text>
                    <Text numberOfLines={1} ellipsizeMode="middle" style={styles.caption}>
                      {project.path}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
        {!loading && !choices.length && (
          <Text style={[styles.muted, { padding: 16 }]}>{query ? "No matching Projects." : "Open at least two Projects on your Mac to create a Link."}</Text>
        )}
      </PageScroll>
      <Text style={styles.caption}>{selected.length} selected. Choose at least two Projects.</Text>
      {failure ? <ErrorNotice message={failure} /> : null}
    </PageScroll>
  );
}
