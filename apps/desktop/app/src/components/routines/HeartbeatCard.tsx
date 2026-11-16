import { useEffect, useState } from "react";
import { Pulse01Icon } from "@hugeicons/core-free-icons";
import { triggerText } from "@milagre/shared/routines";
import { ipcErrorMessage } from "@milagre/shared/result";
import type { HeartbeatStep } from "../../lib/reply-parts";
import { qualifyKey, computerOfKey } from "@milagre/shared/chat-scopes";
import { bridgeFor } from "../../lib/computer-bridge";
import { refreshRoutines, routineEnd, useRoutines } from "../../lib/routines";
import { useReplyChatId } from "../agents/ArtifactCard";
import { Button } from "../primitives/Button";
import { Icon } from "../primitives/Icon";

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function HeartbeatCard({ step }: { step: HeartbeatStep }) {
  const { byComputer, routines } = useRoutines();
  const computer = computerOfKey(useReplyChatId() ?? "");
  const { enabled, error: loadError } = byComputer[computer] ?? { enabled: null, error: null };
  const routineId = qualifyKey(computer, step.routine.id);
  const [stopping, setStopping] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const routine = routines.find((entry) => entry.id === routineId);
  const name = routine?.name ?? step.routine.name;
  const failedRead = enabled === null && loadError ? "Couldn't load Routines" : null;
  const meta = routine ? [capitalized(triggerText(routine.trigger)), routineEnd(routine, now)].filter(Boolean).join(" · ") : null;
  const stop = () => {
    setStopping(true);
    setError(null);
    bridgeFor(computer)
      .deleteRoutine(routineId)
      .then(
        () => refreshRoutines(computer),
        (failure: unknown) => setError(ipcErrorMessage(failure)),
      )
      .finally(() => setStopping(false));
  };
  return (
    <div data-heartbeat-card={step.routine.id} className="flex w-full items-center gap-3 rounded-window border border-line bg-surface p-3">
      <Icon icon={Pulse01Icon} size={18} className="shrink-0 text-ink" />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="truncate text-13 font-medium text-ink">Heartbeat set: {name}</span>
        {(error || failedRead || meta) && (
          <span className={`truncate text-12 ${error || failedRead ? "text-red-ink" : "text-ink-2"}`}>{error ?? failedRead ?? meta}</span>
        )}
      </span>
      {enabled === null ? null : routine ? (
        <Button variant="secondary" shape="pill" data-heartbeat-stop disabled={stopping} onClick={stop}>
          Stop
        </Button>
      ) : (
        <span data-heartbeat-stopped className="shrink-0 text-12 text-ink-3">
          Stopped
        </span>
      )}
    </div>
  );
}
