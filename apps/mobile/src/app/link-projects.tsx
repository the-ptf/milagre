import { LINK_CHAT_WORKTREES_TEXT, LINK_UPDATE_WORKTREES_TEXT } from "@milagre/shared/worktree-link";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { lineHeight, radius, type } from "../design-tokens";
import { scopeKey } from "@milagre/shared/chat-scopes";
import type { NamedProjectLink } from "@milagre/shared/model";
import type { RegisteredProject } from "../client";
import { useSession } from "../session";
import { usePanelNavigation } from "../side-panels";
import { ProjectIcon } from "../project-icon";
import { useRpc } from "../use-rpc";
import { CheckboxBox, CircleButton, ErrorNotice, Field, PageScroll, SheetHeader, pressStyle, useStyles } from "../ui";
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
    <PageScroll style={styles.screen} contentContainerStyle={{ gap: 0, padding: 0 }} automaticallyAdjustKeyboardInsets>
      <SheetHeader
        title={linkId ? "Edit Link" : "Link Projects"}
        leading={<CircleButton label="Cancel" icon={Cancel01Icon} disabled={busy} onPress={() => router.back()} />}
        trailing={
          <CircleButton
            label={linkId ? (busy ? "Saving Link…" : "Save Link") : busy ? "Creating Link…" : "Create Link"}
            icon={Tick02Icon}
            filled
            disabled={!ready}
            onPress={() => void create()}
          />
        }
      />
      <View style={{ gap: 16, padding: 16, paddingTop: 8 }}>
        <Text style={styles.muted}>{linkId ? LINK_UPDATE_WORKTREES_TEXT : LINK_CHAT_WORKTREES_TEXT}</Text>
        <Field label="Link name" value={name} onChangeText={setName} placeholder="e.g. RDFood" autoFocus editable={!busy} returnKeyType="next" />
        <Field
          label="Search Projects"
          hideLabel
          value={query}
          onChangeText={setQuery}
          placeholder="Search Projects"
          editable={!busy}
          clearButtonMode="while-editing"
        />
        <PageScroll
          accessibilityLabel="Projects"
          contentInsetAdjustmentBehavior="never"
          style={[styles.card, { maxHeight: 264, padding: 0 }]}
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
                  style={{ height: 56, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12 }}
                >
                  <View style={{ width: 28, height: 28, borderRadius: radius.chip, borderCurve: "continuous", backgroundColor: colors.field }} />
                  <View style={{ flex: 1, gap: 8 }}>
                    <View style={{ width: "60%", height: 12, borderRadius: radius.full, backgroundColor: colors.field }} />
                    <View style={{ width: "80%", height: 12, borderRadius: radius.full, backgroundColor: colors.field }} />
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
                    style={({ pressed }) => [
                      { minHeight: 56, paddingHorizontal: 12, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 12 },
                      pressStyle({ pressed, disabled: busy, kind: "row" }),
                    ]}
                  >
                    <CheckboxBox checked={checked} />
                    <ProjectIcon client={session.client} path={project.path} />
                    <View style={{ flex: 1, gap: 4 }}>
                      <Text numberOfLines={1} style={{ color: colors.ink, fontSize: type.callout, lineHeight: lineHeight.callout, fontWeight: "500" }}>
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
      </View>
    </PageScroll>
  );
}
