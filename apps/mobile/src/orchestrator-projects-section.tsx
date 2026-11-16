import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { ArrowRight01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import {
  COMPUTER_PREFERENCES,
  type ComputerPreference,
  type OrchestratorComputer,
  type OrchestratorProject,
  type OrchestratorSettings,
} from "@milagre/shared/orchestrator";
import type { Client } from "./client";
import { space } from "./design-tokens";
import { Icon } from "./icons";
import { projectName } from "./orchestrator-board";
import { dimmed, MenuRow } from "./orchestrator-section";
import { ProjectIcon } from "./project-icon";
import { Group } from "./settings-list";
import { Field, pressStyle, RowCheckbox, useStyles } from "./ui";

type Save = (patch: Partial<OrchestratorSettings>) => void;

const PROJECTS_HEIGHT = 360;

const PREFERENCE_LABEL: Record<ComputerPreference, string> = { prefer: "Prefer", normal: "Normal", less: "Less often", manual: "Manual only", never: "Never" };
const percent = (value: number | null) => (value === null ? null : `${Math.round(value * 100)}%`);

function computerLoad(computer: OrchestratorComputer) {
  if (!computer.online) return "Offline";
  const cpu = percent(computer.cpu);
  const memory = percent(computer.memoryFree);
  const load = [cpu && `${cpu} CPU in use`, memory && `${memory} memory free`, computer.agents ? `${computer.agents} running` : null].filter(Boolean);
  return [...load, computer.takesTasks ? null : "Update Milagre there to send it tasks"].filter(Boolean).join(" · ") || "Online";
}

export function ComputersPreferences({
  settings,
  computers,
  save,
}: {
  settings: OrchestratorSettings;
  computers: readonly OrchestratorComputer[];
  save: Save;
}) {
  return (
    <View style={dimmed(settings.useOtherComputers)}>
      {computers.map((computer) => {
        const preference = settings.computerPreferences[computer.id] ?? "normal";
        return (
          <MenuRow
            key={computer.id}
            title={computer.name}
            subtitle={computerLoad(computer)}
            value={PREFERENCE_LABEL[preference]}
            sections={[{ items: COMPUTER_PREFERENCES.map((id) => ({ id, title: PREFERENCE_LABEL[id], checked: id === preference })) }]}
            onSelect={(id) => {
              const next = COMPUTER_PREFERENCES.find((entry) => entry === id);
              if (next) save({ computerPreferences: { ...settings.computerPreferences, [computer.id]: next } });
            }}
          />
        );
      })}
    </View>
  );
}

export function projectsPatch(settings: OrchestratorSettings, path: string, change: Partial<{ included: boolean; hints: string | null }>) {
  const current = settings.projects[path];
  return { projects: { ...settings.projects, [path]: { included: current?.included !== false, hints: current?.hints ?? null, ...change } } };
}

function ProjectRow({
  client,
  project,
  name,
  included,
  hint,
  onInclude,
}: {
  client: Client | null;
  project: OrchestratorProject;
  name: string;
  included: boolean;
  hint: string | null;
  onInclude: () => void;
}) {
  const styles = useStyles();
  return (
    <View style={[{ flexDirection: "row", alignItems: "center", gap: space.xs }, dimmed(included)]}>
      <RowCheckbox label={`Route to ${name}`} selected={included} onPress={onInclude} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[name, hint].filter(Boolean).join(". ")}
        accessibilityHint="Edits its hints"
        onPress={() => router.push({ pathname: "/orchestrator-hint", params: { path: project.path, name } })}
        style={({ pressed }) => [
          { flex: 1, flexDirection: "row", alignItems: "center", gap: space.lg, minHeight: 52, paddingVertical: space.md },
          pressStyle({ pressed, kind: "row" }),
        ]}
      >
        <ProjectIcon client={client} path={project.path} name={name} size={24} />
        <View style={{ flex: 1, gap: space.xxs }}>
          <Text numberOfLines={1} style={styles.text}>
            {name}
          </Text>
          {hint ? (
            <Text numberOfLines={1} style={styles.caption}>
              {hint}
            </Text>
          ) : null}
        </View>
        <Icon icon={ArrowRight01Icon} tone="ink3" size={16} />
      </Pressable>
    </View>
  );
}

/** The Projects the host routes to: search, a checkbox each, and a tap opens the Project's hints. */
export function ProjectsSection({
  client,
  settings,
  projects,
  save,
}: {
  client: Client | null;
  settings: OrchestratorSettings;
  projects: readonly OrchestratorProject[];
  save: Save;
}) {
  const styles = useStyles();
  const [query, setQuery] = useState("");
  if (!projects.length) return null;
  const needle = query.trim().toLowerCase();
  const named = projects.map((project) => ({ project, name: project.name || projectName(project.path, projects) }));
  const shown = named.filter(({ name }) => name.toLowerCase().includes(needle));
  return (
    <Group title="Projects it can route to" inset={0}>
      <Field
        label="Search Projects"
        hideLabel
        placeholder="Search Projects"
        value={query}
        onChangeText={setQuery}
        returnKeyType="search"
        leading={<Icon icon={Search01Icon} tone="ink3" size={16} />}
        containerStyle={{ paddingVertical: space.md }}
      />
      <ScrollView nestedScrollEnabled style={{ maxHeight: PROJECTS_HEIGHT }}>
        {shown.map(({ project, name }, index) => {
          const entry = settings.projects[project.path];
          const included = entry ? entry.included !== false : project.included;
          const hints = entry ? entry.hints : project.hints;
          return (
            <View key={project.path}>
              {index > 0 && <View style={styles.separator} />}
              <ProjectRow
                client={client}
                project={project}
                name={name}
                included={included}
                hint={hints ?? project.defaultHints}
                onInclude={() => save(projectsPatch(settings, project.path, { included: !included }))}
              />
            </View>
          );
        })}
        {shown.length ? null : <Text style={[styles.caption, { paddingVertical: space.lg }]}>No Projects match “{query.trim()}”.</Text>}
      </ScrollView>
    </Group>
  );
}
