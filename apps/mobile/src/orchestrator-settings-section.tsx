import { useState } from "react";
import { Text, View } from "react-native";
import type { OrchestratorSettings } from "@milagre/shared/orchestrator";
import { space } from "./design-tokens";
import { BoardSection, forgetEverything, MemorySection, ProjectsSection, RolesSection } from "./orchestrator-roles-section";
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
  if (!session.client) return <Text style={styles.muted}>Connect to a computer to change the Orchestrator.</Text>;
  if (unavailable) return <Text style={styles.muted}>Update Milagre on your computer to use the Orchestrator.</Text>;
  if (!snapshot || !store) return error ? <ErrorNotice message={error} /> : null;
  const settings = snapshot.settings;
  const save = (patch: Partial<OrchestratorSettings>) => void store.saveSettings(patch).catch(() => {});
  const run = (method: string) => store.act(method, []).catch((failure: Error) => setFailed(failure.message || "That didn't work. Try again."));
  return (
    <View style={{ gap: space.section }}>
      {error || failed ? <ErrorNotice message={error || failed} /> : null}
      <OrchestratorSection settings={settings} models={session.models} save={save} />
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
        <ProjectsSection settings={settings} projects={session.recent} save={save} />
        <RolesSection settings={settings} models={session.models} save={save} />
        <BoardSection settings={settings} save={save} />
      </View>
    </View>
  );
}
