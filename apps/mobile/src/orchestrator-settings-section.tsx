import { useState } from "react";
import { Text, View } from "react-native";
import type { OrchestratorSettings } from "@milagre/shared/orchestrator";
import { space } from "./design-tokens";
import { BoardSection, forgetEverything, MemorySection, RolesSection } from "./orchestrator-roles-section";
import { ComputersPreferences, ProjectsSection } from "./orchestrator-projects-section";
import { useOrchestratorComputers, useOrchestratorProjects } from "./use-orchestrator-lists";
import { dimmed, OrchestratorSection } from "./orchestrator-section";
import { useSession } from "./session";
import { ErrorNotice, useStyles } from "./ui";
import { useOrchestrator } from "./use-orchestrator";

/** Settings › Church › Orchestrator: the connected computer's Orchestrator, everything below the first row dimmed while it's off. */
export function OrchestratorSettingsPage() {
  const styles = useStyles();
  const session = useSession();
  const { snapshot, error, unavailable, store } = useOrchestrator(session.client);
  const [reading, setReading] = useState(false);
  const [failed, setFailed] = useState("");
  const projects = useOrchestratorProjects(session.client);
  const computers = useOrchestratorComputers(session.client);
  if (!session.client) return <Text style={styles.muted}>Connect to a computer to change the Orchestrator.</Text>;
  if (unavailable) return <Text style={styles.muted}>Update Milagre on your computer to use the Orchestrator.</Text>;
  if (!snapshot || !store) return error ? <ErrorNotice message={error} /> : null;
  const settings = snapshot.settings;
  const save = (patch: Partial<OrchestratorSettings>) => void store.saveSettings(patch).catch(() => {});
  const run = (method: string) => store.act(method, []).catch((failure: Error) => setFailed(failure.message || "That didn't work. Try again."));
  return (
    <View style={{ gap: space.section }}>
      {error || failed ? <ErrorNotice message={error || failed} /> : null}
      <OrchestratorSection
        settings={settings}
        models={session.models}
        save={save}
        computers={computers?.length ? <ComputersPreferences settings={settings} computers={computers} save={save} /> : null}
      />
      <View pointerEvents={settings.enabled ? "auto" : "none"} style={[{ gap: space.section }, dimmed(settings.enabled)]}>
        <MemorySection
          memory={snapshot.memory}
          busy={reading}
          onNotes={(notes) => void store.saveNotes(notes).catch((failure: Error) => setFailed(failure.message))}
          onReadAgain={() => {
            setReading(true);
            void run("orchestrator:memory:import").finally(() => setReading(false));
          }}
          onForget={() => void forgetEverything(() => void run("orchestrator:memory:forget"))}
        />
        <ProjectsSection
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
