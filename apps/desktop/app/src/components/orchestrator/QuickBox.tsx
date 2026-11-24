import type { OrchestratorTask } from "@milagre/shared/orchestrator";
import { QuickBoxDialog } from "../QuickBoxDialog";
import { PebbleBox } from "./PebbleBox";

const HINTS = [
  ["Enter", "send"],
  ["Shift+Enter", "new line"],
  ["Esc", "close"],
] as const;

export function QuickBox({
  name,
  onSent,
  onClose,
}: {
  name: string;
  onSent: (task: OrchestratorTask, from: DOMRect, pebble: DOMRect | null) => void;
  onClose: () => void;
}) {
  return (
    <QuickBoxDialog label={name} hints={HINTS} onClose={onClose} data-orchestrator-quick-box>
      <PebbleBox
        placeholder="What do you need?"
        autoFocus
        onSent={(task, from, pebble) => {
          onSent(task, from, pebble);
          onClose();
        }}
        onEscape={onClose}
      />
    </QuickBoxDialog>
  );
}
