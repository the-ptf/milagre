import { View } from "react-native";
import { Delete02Icon } from "@hugeicons/core-free-icons";
import { MEMORY_GROUPS, type MemoryGroup, type OrchestratorMemoryNote } from "@milagre/shared/orchestrator";
import { space } from "./design-tokens";
import { CheckRow, Group, IconButton } from "./ui";

const MEMORY_GROUP_LABEL: Record<MemoryGroup, string> = {
  work: "How you work",
  projects: "Your Projects",
  tools: "Your tools",
  other: "Other notes",
};

const toggleNote = (notes: readonly OrchestratorMemoryNote[], id: string) => notes.map((note) => (note.id === id ? { ...note, enabled: !note.enabled } : note));
const dropNote = (notes: readonly OrchestratorMemoryNote[], id: string) => notes.filter((note) => note.id !== id);

/** What the Orchestrator knows about you, grouped, each note kept while checked; `deletable` adds a delete button. */
export function MemoryNotes({
  notes,
  onChange,
  deletable = false,
}: {
  notes: readonly OrchestratorMemoryNote[];
  onChange: (notes: OrchestratorMemoryNote[]) => void;
  deletable?: boolean;
}) {
  return (
    <View style={{ gap: space.section }}>
      {MEMORY_GROUPS.map((group) => {
        const inGroup = notes.filter((note) => note.group === group);
        if (!inGroup.length) return null;
        return (
          <Group key={group} title={MEMORY_GROUP_LABEL[group]} inset="full">
            {inGroup.map((note) => (
              <CheckRow
                key={note.id}
                kind="checkbox"
                title={note.text}
                subtitle={note.source}
                titleLines={3}
                checked={note.enabled}
                onPress={() => onChange(toggleNote(notes, note.id))}
                trailing={
                  deletable ? (
                    <IconButton label={`Forget “${note.text}”`} icon={Delete02Icon} size={32} onPress={() => onChange(dropNote(notes, note.id))} />
                  ) : undefined
                }
              />
            ))}
          </Group>
        );
      })}
    </View>
  );
}
