import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { lineHeight, radius, type } from "../design-tokens";
import { useSession } from "../session";
import { allComputers, setOtherComputerProjectHidden, useComputerViews } from "../all-computers";
import type { HostView } from "../all-computers-store";
import { ProjectIcon, ProjectIcons } from "../project-icon";
import type { RecentProject } from "../client";
import { CheckboxBox, CircleButton, ErrorNotice, PageScroll, SectionLabel, SheetHeader, pressStyle, useStyles } from "../ui";
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
  // "" before the session has a client: its own Projects still list, and save through the session.
  const currentHostId = session.client?.url ?? "";
  // The session's own computer lists from its live Project list, even before the sidebar's store has it; the others as
  // the sidebar last read them.
  const own = (hostId: string, name: string): Computer => ({ hostId, name, projects: byName(session.recent) });
  const computers = views.map((view) => (view.hostId === currentHostId ? own(view.hostId, view.name) : listed(view)));
  if (!views.some((view) => view.hostId === currentHostId)) computers.unshift(own(currentHostId, session.hostName || "Computer"));
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
        style={({ pressed }) => [
          { minHeight: 56, paddingHorizontal: 12, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 12 },
          pressStyle({ pressed, disabled: key in pending, kind: "row" }),
        ]}
      >
        <CheckboxBox checked={checked} />
        {project.link ? <ProjectIcons client={client} projects={project.projects ?? []} /> : <ProjectIcon client={client} path={project.path} />}
        <View style={{ flex: 1, gap: 4 }}>
          <Text
            numberOfLines={1}
            style={{ fontSize: type.callout, lineHeight: lineHeight.callout, fontWeight: "500", color: checked ? colors.ink : colors.ink3 }}
          >
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
    <View key={projects.hostId} style={{ borderRadius: radius.card, borderCurve: "continuous", backgroundColor: colors.surface, padding: 4 }}>
      {projects.projects.map((project) => row(projects.hostId, project))}
      {!projects.projects.length && <Text style={[styles.muted, { padding: 16 }]}>{empty(projects)}</Text>}
    </View>
  );
  return (
    <PageScroll style={styles.screen} contentContainerStyle={{ gap: 0, padding: 0 }}>
      <SheetHeader title="Choose projects" trailing={<CircleButton label="Done" icon={Tick02Icon} filled onPress={() => router.back()} />} />
      <View style={{ gap: 16, padding: 16, paddingTop: 8 }}>
        <Text style={styles.muted}>Checked Projects and Links show in your Projects list on this phone.</Text>
        {/* With two or more computers, each one's Projects sit under its name, as in desktop's Filters › Projects. */}
        {grouped
          ? computers.map((computer) => (
              <View key={computer.hostId} style={{ gap: 8 }}>
                <SectionLabel>{computer.name}</SectionLabel>
                {list(computer)}
              </View>
            ))
          : computers.map((computer) => list(computer))}
        {all.length > 0 && <Text style={styles.caption}>{hiddenCount ? `${hiddenCount} hidden.` : "All Projects and Links are shown."}</Text>}
        {error ? <ErrorNotice message={error} /> : null}
      </View>
    </PageScroll>
  );
}
