import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { useSession } from "../session";
import { allComputers, setOtherComputerProjectHidden, useComputerViews } from "../all-computers";
import type { HostView } from "../all-computers-store";
import { ProjectIcon, ProjectIcons } from "../project-icon";
import type { RecentProject } from "../client";
import { ErrorNotice, PageScroll, useStyles } from "../ui";
import { useTheme } from "../theme";

// By name, not by recency: opening a Project reorders the recent list, and a row must not move under the finger.
const byName = (list: RecentProject[]) =>
  list
    .map((item) => ({ ...item, name: item.name || item.path.split("/").at(-1) || "Project" }))
    // oxlint-disable-next-line unicorn/no-array-sort -- sorts the copy map made; toSorted crashed this sheet in a 2026-10-26 simulator build
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.path.localeCompare(b.path));
const keyOf = (hostId: string, path: string) => `${hostId}\n${path}`;

/** One computer's section. A computer that has not answered yet says why it lists nothing. */
type Computer = { hostId: string; name: string; projects: RecentProject[]; unread?: "offline" | "checking" };
const listed = (view: HostView): Computer => ({
  hostId: view.hostId,
  name: view.name,
  projects: byName(view.projects),
  unread: view.loaded ? undefined : view.state === "offline" ? "offline" : "checking",
});

/** Project and Link visibility in the Projects list on this phone, for every shown computer, as desktop's Filters. */
export default function ChooseProjects() {
  const { colors } = useTheme();
  const styles = useStyles();
  const session = useSession();
  const views = useComputerViews();
  const currentHostId = session.client?.url;
  // The session's own computer lists from its live Project list; the others as the sidebar last read them.
  const own = (hostId: string, name: string): Computer => ({ hostId, name, projects: byName(session.recent) });
  const computers =
    views.some((view) => view.hostId === currentHostId) || !currentHostId
      ? views.map((view) => (view.hostId === currentHostId ? own(view.hostId, view.name) : listed(view)))
      : [own(currentHostId, session.hostName || "Computer"), ...views.map(listed)];
  const grouped = computers.length > 1;
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const shown = (hostId: string, path: string, hidden?: boolean) => !(pending[keyOf(hostId, path)] ?? hidden);
  async function toggle(hostId: string, project: RecentProject, show: boolean) {
    const key = keyOf(hostId, project.path);
    if (key in pending) return;
    setError("");
    setPending((previous) => ({ ...previous, [key]: !show }));
    try {
      if (hostId === currentHostId) await session.setProjectHidden(project.path, !show);
      else await setOtherComputerProjectHidden(hostId, project.path, !show);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "Could not change this setting.";
      setError(message);
    } finally {
      setPending((previous) => {
        const next = { ...previous };
        delete next[key];
        return next;
      });
    }
  }
  const all = computers.flatMap((computer) => computer.projects.map((project) => ({ hostId: computer.hostId, project })));
  const hiddenCount = all.filter(({ hostId, project }) => !shown(hostId, project.path, project.hidden)).length;
  const row = (hostId: string, project: RecentProject) => {
    const key = keyOf(hostId, project.path);
    const checked = shown(hostId, project.path, project.hidden);
    const name = project.name;
    const client = hostId === currentHostId ? session.client : allComputers.clientFor(hostId);
    return (
      <Pressable
        key={key}
        accessibilityRole="checkbox"
        accessibilityLabel={name}
        accessibilityState={{ checked, disabled: key in pending }}
        disabled={key in pending}
        onPress={() => toggle(hostId, project, !checked)}
        style={({ pressed }) => ({
          height: 64,
          paddingHorizontal: 12,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          borderRadius: 8,
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
        {project.link ? <ProjectIcons client={client} projects={project.projects ?? []} /> : <ProjectIcon client={client} path={project.path} />}
        <View style={{ flex: 1, gap: 4 }}>
          <Text numberOfLines={1} style={[styles.text, { fontSize: 15, color: checked ? colors.ink : colors.ink3 }]}>
            {name}
          </Text>
          <Text numberOfLines={1} ellipsizeMode="middle" style={styles.caption}>
            {project.link ? project.projects?.map((member) => member.name || member.path.split("/").at(-1)).join(" + ") || "Linked Projects" : project.path}
          </Text>
        </View>
      </Pressable>
    );
  };
  const empty = (computer: Computer) =>
    computer.unread === "offline"
      ? "Offline. Its Projects show here once it answers."
      : computer.unread === "checking"
        ? "Loading Projects…"
        : grouped
          ? "No Projects on this computer yet."
          : "Open a Project on your Mac to list it here.";
  const list = (projects: Computer) => (
    <View style={{ borderRadius: 12, backgroundColor: colors.surface, padding: 4 }}>
      {projects.projects.map((project) => row(projects.hostId, project))}
      {!projects.projects.length && <Text style={[styles.muted, { padding: 16 }]}>{empty(projects)}</Text>}
    </View>
  );
  return (
    <PageScroll style={styles.screen} contentContainerStyle={{ gap: 16, padding: 20 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ width: 52 }} />
        <Text accessibilityRole="header" style={{ flex: 1, textAlign: "center", color: colors.ink, fontSize: 17, fontWeight: "600" }}>
          Choose projects
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.back()}
          style={{ minWidth: 52, minHeight: 44, alignItems: "flex-end", justifyContent: "center" }}
        >
          <Text style={[styles.text, { fontWeight: "600" }]}>Done</Text>
        </Pressable>
      </View>
      <Text style={styles.muted}>Checked Projects and Links show in your Projects list on this phone.</Text>
      {/* With two or more computers, each one's Projects sit under its name, as in desktop's Filters › Projects. */}
      {grouped ? (
        computers.map((computer) => (
          <View key={computer.hostId} style={{ gap: 8 }}>
            <Text accessibilityRole="header" numberOfLines={1} style={styles.section}>
              {computer.name}
            </Text>
            {list(computer)}
          </View>
        ))
      ) : computers[0] ? (
        list(computers[0])
      ) : (
        <View style={{ borderRadius: 12, backgroundColor: colors.surface, padding: 4 }}>
          <Text style={[styles.muted, { padding: 16 }]}>Open a Project on your Mac to list it here.</Text>
        </View>
      )}
      {all.length > 0 && <Text style={styles.caption}>{hiddenCount ? `${hiddenCount} hidden.` : "All Projects and Links are shown."}</Text>}
      {error ? <ErrorNotice message={error} /> : null}
    </PageScroll>
  );
}
