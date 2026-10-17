import { useEffect, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Pulse01Icon } from "@hugeicons/core-free-icons";
import { triggerText } from "@milagre/shared/routines";
import { ipcErrorMessage } from "@milagre/shared/result";
import type { HeartbeatStep } from "../../lib/reply-parts";
import { isRemoteKey } from "../../lib/computer-bridge";
import { refreshRoutines, routineEnd, useRoutines } from "../../lib/routines";
import { useReplyChatId } from "../agents/ArtifactCard";

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * "Heartbeat set: <name>", its cadence and end, and Stop (which deletes the Routine), for a heartbeat_create step in a
 * reply. A Routine that no longer exists says Stopped. Routines are this Mac's own: on another computer's Chat the card
 * only names the Heartbeat.
 */
export function HeartbeatCard({ step }: { step: HeartbeatStep }) {
  const { enabled, routines, error: loadError } = useRoutines();
  const remote = isRemoteKey(useReplyChatId());
  const [stopping, setStopping] = useState(false);
  // "ends in 3 days" moves with the clock: read again every minute (and on every Routine update, which re-renders).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const routine = routines.find((entry) => entry.id === step.routine.id);
  const name = routine?.name ?? step.routine.name;
  const failedRead = enabled === null && loadError ? "Couldn’t load Routines" : null;
  const meta = routine ? [capitalized(triggerText(routine.trigger)), routineEnd(routine, now)].filter(Boolean).join(" · ") : null;
  const stop = () => {
    setStopping(true);
    setError(null);
    window.milagre
      .deleteRoutine(step.routine.id)
      .then(refreshRoutines, (failure: unknown) => setError(ipcErrorMessage(failure)))
      .finally(() => setStopping(false));
  };
  return (
    <div data-heartbeat-card={step.routine.id} className="flex w-full items-center gap-3 rounded-[14px] border border-line bg-surface px-3 py-2.5">
      <HugeiconsIcon icon={Pulse01Icon} size={18} strokeWidth={1.8} color="currentColor" className="shrink-0 text-ink" />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="truncate text-[13.5px] font-medium text-ink">Heartbeat set: {name}</span>
        {(error || failedRead || meta) && (
          <span className={`truncate text-[12px] ${error || failedRead ? "text-red" : "text-ink-2"}`}>{error ?? failedRead ?? meta}</span>
        )}
      </span>
      {remote || enabled === null ? null : routine ? (
        <button
          type="button"
          data-heartbeat-stop
          disabled={stopping}
          onClick={stop}
          className="h-[30px] shrink-0 rounded-full border border-line-strong bg-surface px-3.5 text-[13px] font-medium text-ink transition-colors hover:bg-hover disabled:opacity-40"
        >
          Stop
        </button>
      ) : (
        <span data-heartbeat-stopped className="shrink-0 text-[12px] text-ink-3">
          {enabled ? "Stopped" : "Routines are off"}
        </span>
      )}
    </div>
  );
}
