import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { useSession } from "../session";
import { ProjectIcon, ProjectIcons } from "../project-icon";
import type { RecentProject } from "../client";
import { ErrorNotice, PageScroll, useStyles } from "../ui";
import { useTheme } from "../theme";

/** Project and Link visibility in the Projects list on this phone, per paired computer. */
export default function ChooseProjects() {
  const { colors } = useTheme();
  const styles = useStyles();
  const session = useSession();
  // By name, not by recency: opening a Project reorders the recent list, and a row must not move under the finger.
  const projects = session.recent
    .map((item) => ({ ...item, name: item.name || item.path.split("/").at(-1) || "Project" }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.path.localeCompare(b.path));
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const shown = (path: string, hidden?: boolean) => !(pending[path] ?? hidden);
  async function toggle(project: RecentProject, show: boolean) {
    const { path } = project;
    if (path in pending) return;
    setError("");
    setPending((previous) => ({ ...previous, [path]: !show }));
    try {
      await session.setProjectHidden(path, !show);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "Could not change this setting.";
      setError(message);
    } finally {
      setPending((previous) => {
        const next = { ...previous };
        delete next[path];
        return next;
      });
    }
  }
  const hiddenCount = projects.filter((project) => !shown(project.path, project.hidden)).length;
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
      <View style={{ borderRadius: 12, backgroundColor: colors.surface, padding: 4 }}>
        {projects.map((project) => {
          const checked = shown(project.path, project.hidden);
          const name = project.name;
          return (
            <Pressable
              key={project.path}
              accessibilityRole="checkbox"
              accessibilityLabel={name}
              accessibilityState={{ checked, disabled: project.path in pending }}
              disabled={project.path in pending}
              onPress={() => toggle(project, !checked)}
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
              {project.link ? (
                <ProjectIcons client={session.client} projects={project.projects ?? []} />
              ) : (
                <ProjectIcon client={session.client} path={project.path} />
              )}
              <View style={{ flex: 1, gap: 4 }}>
                <Text numberOfLines={1} style={[styles.text, { fontSize: 15, color: checked ? colors.ink : colors.ink3 }]}>
                  {name}
                </Text>
                <Text numberOfLines={1} ellipsizeMode="middle" style={styles.caption}>
                  {project.link
                    ? project.projects?.map((member) => member.name || member.path.split("/").at(-1)).join(" + ") || "Linked Projects"
                    : project.path}
                </Text>
              </View>
            </Pressable>
          );
        })}
        {!projects.length && <Text style={[styles.muted, { padding: 16 }]}>Open a Project on your Mac to list it here.</Text>}
      </View>
      {projects.length > 0 && <Text style={styles.caption}>{hiddenCount ? `${hiddenCount} hidden.` : "All Projects and Links are shown."}</Text>}
      {error ? <ErrorNotice message={error} /> : null}
    </PageScroll>
  );
}
