import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  COMPUTER_PREFERENCES,
  type ComputerPreference,
  type OrchestratorComputer,
  type OrchestratorProject,
  type OrchestratorSettings,
} from "@milagre/shared/orchestrator";
import { lineHeight, space, type } from "./design-tokens";
import { projectName } from "./orchestrator-board";
import { dimmed, MenuRow } from "./orchestrator-section";
import { Group } from "./settings-list";
import { useTheme } from "./theme";
import { CheckRow, Field, pressStyle, useStyles } from "./ui";

type Save = (patch: Partial<OrchestratorSettings>) => void;

const PREFERENCE_LABEL: Record<ComputerPreference, string> = { prefer: "Prefer", normal: "Normal", less: "Less often", manual: "Manual only" };
const percent = (value: number | null) => (value === null ? null : `${Math.round(value * 100)}%`);

export function computerLoad(computer: OrchestratorComputer) {
  if (!computer.online) return "Offline";
  const cpu = percent(computer.cpu);
  const memory = percent(computer.memoryFree);
  return (
    [cpu && `${cpu} CPU in use`, memory && `${memory} memory free`, computer.agents ? `${computer.agents} running` : null].filter(Boolean).join(" · ") ||
    "Online"
  );
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

function EditHints({ name, open, onPress }: { name: string; open: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${open ? "Done editing" : "Edit"} hints for ${name}`}
      onPress={onPress}
      style={({ pressed }) => [{ minHeight: 44, minWidth: 44, justifyContent: "center", paddingHorizontal: space.xs }, pressStyle({ pressed })]}
    >
      <Text style={{ color: colors.accentInk, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}>{open ? "Done" : "Edit"}</Text>
    </Pressable>
  );
}

function HintsField({ project, hints, onSave }: { project: OrchestratorProject; hints: string | null; onSave: (hints: string | null) => void }) {
  const [value, setValue] = useState(hints ?? "");
  return (
    <Field
      label={`Hints for ${project.name}`}
      hideLabel
      multiline
      autoFocus
      autoCapitalize="none"
      placeholder={project.defaultHints ?? "Words that mean this Project, for the router"}
      value={value}
      onChangeText={setValue}
      onBlur={() => onSave(value.trim() || null)}
      containerStyle={{ paddingBottom: space.lg }}
      style={{ minHeight: 72 }}
    />
  );
}

/** The Projects the host routes to: a checkbox each, and hints over the ones it read from the Project's own files. */
export function ProjectsSection({ settings, projects, save }: { settings: OrchestratorSettings; projects: readonly OrchestratorProject[]; save: Save }) {
  const styles = useStyles();
  const [editing, setEditing] = useState<string | null>(null);
  const put = (path: string, change: Partial<{ included: boolean; hints: string | null }>) => {
    const current = settings.projects[path];
    save({ projects: { ...settings.projects, [path]: { included: current?.included !== false, hints: current?.hints ?? null, ...change } } });
  };
  if (!projects.length) return null;
  return (
    <Group title="Projects it can route to" inset={0}>
      {projects.map((project) => {
        const entry = settings.projects[project.path];
        const included = entry ? entry.included !== false : project.included;
        const hints = entry ? entry.hints : project.hints;
        const name = project.name || projectName(project.path, projects);
        return (
          <View key={project.path}>
            <CheckRow
              kind="checkbox"
              title={name}
              subtitle={hints ?? project.defaultHints ?? "No hints yet"}
              subtitleLines={2}
              checked={included}
              onPress={() => put(project.path, { included: !included })}
              trailing={<EditHints name={name} open={editing === project.path} onPress={() => setEditing(editing === project.path ? null : project.path)} />}
            />
            {editing === project.path ? (
              <View style={{ gap: space.xs }}>
                <HintsField project={project} hints={hints} onSave={(next) => next !== hints && put(project.path, { hints: next })} />
                {project.defaultHints ? (
                  <Text style={[styles.caption, { paddingBottom: space.md }]}>{"Leave it empty to use what the Project's own files say."}</Text>
                ) : null}
              </View>
            ) : null}
          </View>
        );
      })}
    </Group>
  );
}
