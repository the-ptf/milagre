import { useState } from "react";
import { Text, View } from "react-native";
import { isMemoryImporting, type OrchestratorMemory, type OrchestratorMemoryNote } from "@milagre/shared/orchestrator";
import { confirm } from "./confirm-store";
import { space } from "./design-tokens";
import { MemoryNotes } from "./orchestrator-memory";
import { useSession } from "./session";
import { Group, Row } from "./settings-list";
import { ErrorNotice, useStyles } from "./ui";
import { useOrchestrator } from "./use-orchestrator";

export function memorySummary(memory: OrchestratorMemory) {
  if (!memory.importedAt) return "Nothing read yet";
  const found = memory.sources.filter((source) => source.found).map((source) => source.name);
  return `${memory.notes.length} ${memory.notes.length === 1 ? "note" : "notes"}${found.length ? `, read from ${found.join(", ")}` : ""}`;
}

export function MemorySection({
  memory,
  busy,
  onNotes,
  onReadAgain,
  onForget,
}: {
  memory: OrchestratorMemory;
  busy: boolean;
  onNotes: (notes: OrchestratorMemoryNote[]) => void;
  onReadAgain: () => void;
  onForget: () => void;
}) {
  const styles = useStyles();
  const found = memory.sources.filter((source) => source.found).map((source) => source.name);
  return (
    <View style={{ gap: space.md }}>
      <Group title="Memory" inset={0}>
        <View style={{ paddingVertical: space.lg, gap: space.xs }}>
          <Text style={styles.text}>What it knows about you</Text>
          <Text style={styles.caption}>
            {memory.notes.length} {memory.notes.length === 1 ? "note" : "notes"}
            {found.length ? `, read from ${found.join(", ")}` : ""}. Untick a note to stop using it.
          </Text>
        </View>
        <Row title="Read again" value={busy ? "Reading…" : undefined} chevron={false} disabled={busy} onPress={onReadAgain} />
        <Row title="Forget everything" destructive chevron={false} onPress={onForget} />
      </Group>
      {memory.notes.length ? <MemoryNotes notes={memory.notes} onChange={onNotes} deletable /> : null}
    </View>
  );
}

export async function forgetEverything(onForget: () => void) {
  if (await confirm("Forget everything?", "The Orchestrator drops every note and what it learned from your corrections.", "Forget")) onForget();
}

/** Settings › Church › Orchestrator › Memory: what the connected computer's Orchestrator knows about you. */
export function OrchestratorMemoryPage() {
  const styles = useStyles();
  const session = useSession();
  const { snapshot, error, store } = useOrchestrator(session.client);
  const [reading, setReading] = useState(false);
  const [failed, setFailed] = useState("");
  if (!session.client) return <Text style={styles.muted}>Connect to a computer to change the Orchestrator.</Text>;
  if (!snapshot || !store) return error ? <ErrorNotice message={error} /> : null;
  const run = (method: string) => store.act(method, []).catch((failure: Error) => setFailed(failure.message || "That didn't work. Try again."));
  return (
    <View style={{ gap: space.section }}>
      {error || failed ? <ErrorNotice message={error || failed} /> : null}
      <MemorySection
        memory={snapshot.memory}
        busy={reading || isMemoryImporting(snapshot.memory)}
        onNotes={(notes: OrchestratorMemoryNote[]) => void store.saveNotes(notes).catch((failure: Error) => setFailed(failure.message))}
        onReadAgain={() => {
          setReading(true);
          void run("orchestrator:memory:import").finally(() => setReading(false));
        }}
        onForget={() => void forgetEverything(() => void run("orchestrator:memory:forget"))}
      />
    </View>
  );
}
