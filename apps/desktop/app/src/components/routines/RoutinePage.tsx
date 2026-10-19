import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft02Icon, Delete02Icon, PencilEdit02Icon, PlayIcon } from "@hugeicons/core-free-icons";
import type { ModelOption } from "@milagre/shared/model";
import { canRunNow, clock } from "@milagre/shared/routines";
import { ipcErrorMessage } from "@milagre/shared/result";
import { ScrollArea } from "../primitives/ScrollArea";
import { Switch } from "../primitives/Switch";
import { DeleteQuestion, RoutineMenu, RoutineTile, outlineButton, routineProblem } from "./RoutineRow";
import { RunList } from "./RunList";
import { refreshRoutines, routineMeta, type RoutineWithRuns } from "../../lib/routines";

const headerButton = `inline-flex h-[30px] shrink-0 items-center gap-1.5 ${outlineButton}`;

/**
 * One Routine's page: back to the Routines page, its header (tile, name, meta, switch, Run now, Edit, ⋯ Delete), then its
 * Runs, newest first, with the quiet stretches folded.
 */
export function RoutinePage({
  routine,
  models,
  unreadChats,
  chatTitle,
  hasChat,
  onBack,
  onEdit,
  onOpenChat,
}: {
  routine: RoutineWithRuns;
  models: ModelOption[];
  /** The keys of hidden Run Chats nobody opened: their Runs show a dot. */
  unreadChats: ReadonlySet<string>;
  /** A Chat's title, for a Heartbeat's meta line ("in Notification chimes"). */
  chatTitle?: (chatId: string) => string | undefined;
  /** Whether a Run's Chat is still there to open, archived or not (chatLeft); a Run without one opens nothing. */
  hasChat?: (chatKey: string) => boolean;
  onBack: () => void;
  onEdit: () => void;
  onOpenChat: (chatKey: string) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const back = useRef<HTMLButtonElement>(null);

  // "Today 10:15" turns into "Yesterday 10:15", and "ends in 3 h" counts down, with the clock.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  // The row that opened the page is gone; focus starts at Back, so the keyboard isn't left on the body.
  useEffect(() => {
    back.current?.focus({ preventScroll: true });
  }, []);

  const act = (work: () => Promise<unknown>) => {
    setError(null);
    work().then(refreshRoutines, (failure) => {
      setError(ipcErrorMessage(failure));
      refreshRoutines();
    });
  };
  const modelName = (_provider: unknown, id: string) => models.find((model) => model.id === id)?.name ?? id;
  const meta = routineMeta(routine, { chatTitle, modelName, now });
  const problem = routineProblem(routine);

  return (
    <ScrollArea className="flex h-full flex-col">
      <div data-routine-page={routine.id} className="mx-auto flex w-full max-w-[720px] flex-1 flex-col px-6 pt-14 pb-10">
        <div>
          <button
            ref={back}
            type="button"
            data-routine-back
            onClick={onBack}
            className="-ml-2 inline-flex h-7 items-center gap-1.5 rounded-[7px] pr-2.5 pl-1.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover-2 hover:text-ink"
          >
            <HugeiconsIcon icon={ArrowLeft02Icon} size={15} strokeWidth={1.8} color="currentColor" />
            Routines
          </button>
        </div>
        <div className="mt-3 flex items-start gap-3">
          <RoutineTile routine={routine} large />
          <div className="grid min-w-0 flex-1 gap-1">
            <h1 className={`truncate text-[22px] leading-[28px] font-semibold tracking-[-0.01em] ${routine.enabled ? "text-ink" : "text-ink-2"}`}>
              {routine.name}
            </h1>
            <p data-routine-meta className="text-[13px] text-ink-2">
              {meta}
            </p>
            {problem && (
              <p data-routine-problem className="text-[12.5px] break-words text-red">
                {problem}
              </p>
            )}
          </div>
          <div className="flex h-10 shrink-0 items-center gap-2">
            <Switch
              label={`${routine.name} on`}
              checked={routine.enabled}
              onChange={(on) => act(() => window.milagre.updateRoutine(routine.id, { enabled: on }))}
            />
            {canRunNow(routine) && (
              <button type="button" data-routine-run-now className={`ml-1 ${headerButton}`} onClick={() => act(() => window.milagre.runRoutineNow(routine.id))}>
                <HugeiconsIcon icon={PlayIcon} size={14} strokeWidth={1.8} color="currentColor" />
                Run now
              </button>
            )}
            <button type="button" data-routine-edit className={headerButton} onClick={onEdit}>
              <HugeiconsIcon icon={PencilEdit02Icon} size={14} strokeWidth={1.8} color="currentColor" />
              Edit
            </button>
            <RoutineMenu
              routine={routine}
              entries={[{ key: "delete", label: "Delete", icon: Delete02Icon, danger: true, onSelect: () => setConfirming(true) }]}
            />
          </div>
        </div>
        {confirming && (
          <DeleteQuestion
            routine={routine}
            className="mt-3 rounded-xl border border-line bg-surface px-4 py-2"
            onCancel={() => setConfirming(false)}
            onDelete={() => {
              setConfirming(false);
              act(() => window.milagre.deleteRoutine(routine.id));
            }}
          />
        )}
        {error && (
          <p role="alert" className="mt-4 text-[13px] break-words text-red">
            {error}
          </p>
        )}
        <section data-routine-runs className="mt-7 space-y-2">
          <h2 className="px-1 text-[13px] font-semibold text-ink">Runs</h2>
          {routine.runs.length > 0 ? (
            <RunList runs={routine.runs} routineName={routine.name} now={now} unreadChats={unreadChats} hasChat={hasChat} onOpenChat={onOpenChat} />
          ) : (
            <div data-routine-runs-empty className="flex flex-col items-center gap-1 rounded-xl border border-line bg-surface px-6 py-8 text-center">
              <p className="text-[13px] text-ink-2">No Runs yet</p>
              {routine.enabled && typeof routine.nextRunAt === "number" && <p className="text-[12px] text-ink-3">Next Run {clock(routine.nextRunAt)}</p>}
            </div>
          )}
        </section>
      </div>
    </ScrollArea>
  );
}
