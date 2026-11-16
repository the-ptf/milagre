import { Text, View } from "react-native";
import { router } from "expo-router";
import type { OrchestratorMemory, OrchestratorSettings } from "@milagre/shared/orchestrator";
import { space } from "./design-tokens";
import { memorySummary } from "./orchestrator-memory-section";
import { BoardSection, RolesSection } from "./orchestrator-roles-section";
import { ComputersPreferences, ProjectsSection } from "./orchestrator-projects-section";
import { useOrchestratorComputers, useOrchestratorProjects } from "./use-orchestrator-lists";
import { dimmed, OrchestratorSection } from "./orchestrator-section";
import { useSession } from "./session";
import { Group, Row } from "./settings-list";
import { ErrorNotice, useStyles } from "./ui";
import { useOrchestrator } from "./use-orchestrator";

/** The Orchestrator page's one Memory row, opening its own page. */
function MemoryRow({ memory }: { memory: OrchestratorMemory }) {
  return (
    <Group inset={0}>
      <Row title="Memory" subtitle={memorySummary(memory)} onPress={() => router.push("/orchestrator-memory")} />
    </Group>
  );
}

/** Settings › Church › Orchestrator: the connected computer's Orchestrator, everything below the first row dimmed while it's off. */
export function OrchestratorSettingsPage() {
  const styles = useStyles();
  const session = useSession();
  const { snapshot, error, unavailable, store } = useOrchestrator(session.client);
  const projects = useOrchestratorProjects(session.client);
  const computers = useOrchestratorComputers(session.client);
  if (!session.client) return <Text style={styles.muted}>Connect to a computer to change the Orchestrator.</Text>;
  if (unavailable) return <Text style={styles.muted}>Update Milagre on your computer to use the Orchestrator.</Text>;
  if (!snapshot || !store) return error ? <ErrorNotice message={error} /> : null;
  const settings = snapshot.settings;
  const save = (patch: Partial<OrchestratorSettings>) => void store.saveSettings(patch).catch(() => {});
  return (
    <View style={{ gap: space.section }}>
      {error ? <ErrorNotice message={error} /> : null}
      <OrchestratorSection
        settings={settings}
        models={session.models}
        save={save}
        computers={computers?.length ? <ComputersPreferences settings={settings} computers={computers} save={save} /> : null}
      />
      <View pointerEvents={settings.enabled ? "auto" : "none"} style={[{ gap: space.section }, dimmed(settings.enabled)]}>
        <MemoryRow memory={snapshot.memory} />
        <ProjectsSection
          client={session.client}
          settings={settings}
          projects={
            projects ?? session.recent.map((project) => ({ path: project.path, name: project.name ?? "", included: true, hints: null, defaultHints: null }))
          }
          save={save}
        />
        <RolesSection settings={settings} models={session.models} save={save} />
        <BoardSection settings={settings} save={save} />
      </View>
    </View>
  );
}
