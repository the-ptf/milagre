import { HugeiconsIcon } from "@hugeicons/react";
import Tooltip from "../primitives/Tooltip";
import { chatRoutine, useRoutines } from "../../lib/routines";
import { routineIcon } from "./routine-icon";

/**
 * The open Chat's Routine, as a chip at the top of the Chat that opens the Routine's page: the Routine whose Run opened the
 * Chat (`run`, hidden or kept), else an enabled Heartbeat that checks back on it. Nothing for any other Chat. It sits in the
 * window's drag strip like the diff's bar, above it (z-55), so only the chip itself opts out of dragging.
 */
export function RoutineChip({ chatKey, run, onOpen }: { chatKey: string; run?: { routineId: string }; onOpen: (routineId: string) => void }) {
  const { routines } = useRoutines();
  const routine = chatRoutine(routines, chatKey, run);
  if (!routine) return null;
  return (
    <div className="pointer-events-none absolute inset-x-3 top-[var(--window-chrome-top)] z-[55] flex h-8 items-center justify-center">
      <Tooltip label="Open Routine" side="bottom" className="pointer-events-auto max-w-[min(320px,40%)] min-w-0">
        <button
          type="button"
          data-routine-chip={routine.id}
          onClick={() => onOpen(routine.id)}
          className="flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full bg-surface pr-3 pl-2.5 text-[12px] font-medium text-ink-2 shadow-card transition-colors hover:text-ink [-webkit-app-region:no-drag]"
        >
          <HugeiconsIcon icon={routineIcon(routine)} size={14} strokeWidth={1.8} color="currentColor" className="shrink-0" />
          <span className="truncate">{routine.name}</span>
        </button>
      </Tooltip>
    </div>
  );
}
