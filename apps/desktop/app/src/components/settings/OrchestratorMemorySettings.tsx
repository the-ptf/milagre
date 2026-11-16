import { useState } from "react";
import { ArrowRight01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { MEMORY_GROUPS, type OrchestratorMemory } from "@milagre/shared/orchestrator";
import { GROUP_TITLES } from "../../lib/orchestrator-names";
import { forgetMemory, importMemory, saveMemoryNotes, useOrchestrator } from "../../lib/orchestrator-store";
import { Button, IconButton } from "../primitives/Button";
import { Checkbox } from "../primitives/Checkbox";
import { Icon } from "../primitives/Icon";
import { InlineError } from "../primitives/InlineError";
import { SpinnerRing } from "../primitives/SpinnerRing";
import { Group, Row } from "./SettingsGroup";

function memorySummary(memory: OrchestratorMemory) {
  if (!memory.importedAt) return "Nothing read yet";
  const found = memory.sources.filter((source) => source.found).map((source) => source.name);
  return `${memory.notes.length} ${memory.notes.length === 1 ? "note" : "notes"}${found.length ? `, read from ${found.join(", ")}` : ""}`;
}

export function OrchestratorMemoryRow({ onOpen }: { onOpen: () => void }) {
  const { memory } = useOrchestrator();
  return (
    <Group>
      <button
        type="button"
        data-settings-row
        data-orchestrator-memory-row
        onClick={onOpen}
        className="flex min-h-12 w-full items-center justify-between gap-6 px-4 py-2 text-left transition-colors duration-fast hover:bg-hover"
      >
        <span className="grid min-w-0 gap-0.5">
          <span className="text-13 font-medium text-ink">Memory</span>
          <span className="text-12 text-ink-3">{memorySummary(memory)}</span>
        </span>
        <span className="flex shrink-0 text-ink-3">
          <Icon icon={ArrowRight01Icon} size={16} />
        </span>
      </button>
    </Group>
  );
}

export function OrchestratorMemorySettings() {
  const { memory } = useOrchestrator();
  const [busy, setBusy] = useState<"read" | "forget" | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (kind: "read" | "forget", work: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    void work()
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setBusy(null));
  };
  const setNotes = (notes: typeof memory.notes) => void saveMemoryNotes(notes).catch((cause: Error) => setError(cause.message));
  const found = memory.sources.filter((source) => source.found).map((source) => source.name);
  return (
    <Group title="Memory">
      <Row
        label="What it knows about you"
        description={
          memory.importedAt
            ? `${memory.notes.length} ${memory.notes.length === 1 ? "note" : "notes"}${found.length ? `, read from ${found.join(", ")}` : ""}. Untick a note to stop using it.`
            : "Nothing read yet. It reads your agents' instructions and memories on this computer."
        }
      >
        <Button variant="secondary" size={28} disabled={busy !== null} onClick={() => run("read", importMemory)}>
          {busy === "read" && <SpinnerRing size={12} />}
          Read again
        </Button>
      </Row>
      {MEMORY_GROUPS.map((group) => {
        const notes = memory.notes.filter((note) => note.group === group);
        if (!notes.length) return null;
        return (
          <div key={group} className="px-4 py-3">
            <p className="pb-1.5 text-12 font-medium text-ink-3">{GROUP_TITLES[group]}</p>
            {notes.map((note) => (
              <div key={note.id} className="group flex min-h-8 items-center gap-2.5">
                <Checkbox
                  aria-label={note.text}
                  checked={note.enabled}
                  onCheckedChange={(enabled) => setNotes(memory.notes.map((entry) => (entry.id === note.id ? { ...entry, enabled } : entry)))}
                />
                <span className={`min-w-0 flex-1 text-13 ${note.enabled ? "text-ink" : "text-ink-3"}`}>{note.text}</span>
                <span className="shrink-0 text-11 text-ink-3">{note.source}</span>
                <IconButton
                  size={24}
                  variant="danger-ghost"
                  label="Delete note"
                  icon={Delete02Icon}
                  className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                  onClick={() => setNotes(memory.notes.filter((entry) => entry.id !== note.id))}
                />
              </div>
            ))}
          </div>
        );
      })}
      <Row label="Forget everything" description="Drops every note and what it learned from your corrections">
        {confirm ? (
          <span className="flex gap-1.5">
            <Button variant="ghost" size={28} onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              size={28}
              disabled={busy !== null}
              onClick={() => {
                setConfirm(false);
                run("forget", forgetMemory);
              }}
            >
              Forget
            </Button>
          </span>
        ) : (
          <Button variant="danger-ghost" size={28} onClick={() => setConfirm(true)}>
            Forget
          </Button>
        )}
      </Row>
      {error && (
        <InlineError size={12} className="px-4 py-3">
          {error}
        </InlineError>
      )}
    </Group>
  );
}
