import { useEffect, useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon, Pulse01Icon, RepeatIcon, ZapIcon } from "@hugeicons/core-free-icons";
import type { ModelOption } from "@milagre/shared/model";
import { ipcErrorMessage } from "@milagre/shared/result";
import { ScrollArea } from "../primitives/ScrollArea";
import { RoutineRow } from "./RoutineRow";
import { RoutineForm } from "./RoutineForm";
import { groupRoutines, routineMeta, routineStatus, useRoutines, type RoutineWithRuns } from "../../lib/routines";

type Filter = "all" | "heartbeats" | "triggers" | "paused";
const HELP = "Routines run while this Mac is awake. Closing the lid on battery pauses them.";
const card = "divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface";

/** The Routines page: this Mac's heartbeats and triggers, each with its switch and actions, and New routine. */
export function RoutinesPage({
  models,
  projectPath,
  onOpenChat,
  onOpenExperimental,
}: {
  models: ModelOption[];
  /** The open Project, where a new Routine runs unless another is picked. */
  projectPath?: string;
  onOpenChat: (chatKey: string) => void;
  onOpenExperimental: () => void;
}) {
  const { enabled, routines, error: loadError, refresh } = useRoutines();
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);
  // The Routine being edited, or "new"; null while the form is closed.
  const [form, setForm] = useState<RoutineWithRuns | "new" | null>(null);
  const [chatTitles, setChatTitles] = useState<Map<string, string>>(new Map());
  const [now, setNow] = useState(() => Date.now());

  // "2 h ago" and "ends in 3 h" move with the clock.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  // A heartbeat's row names its Chat; the Mac's Routine targets carry each Project's Chat titles.
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    Promise.resolve()
      .then(() => window.milagre.routineTargets())
      .then(
        (targets) => {
          if (!live) return;
          setChatTitles(new Map(targets.projects.flatMap((project) => project.chats.map((chat) => [chat.chatId, chat.title] as const))));
        },
        () => {},
      );
    return () => {
      live = false;
    };
  }, [enabled, routines.length]);

  const groups = useMemo(() => groupRoutines(routines), [routines]);
  const shown = (list: RoutineWithRuns[]) => (filter === "paused" ? list.filter((routine) => !routine.enabled) : list);
  const heartbeats = filter === "triggers" ? [] : shown(groups.heartbeats);
  const triggers = filter === "heartbeats" ? [] : shown(groups.triggers);
  const modelName = (_provider: unknown, id: string) => models.find((model) => model.id === id)?.name ?? id;

  const act = (work: () => Promise<unknown>) => {
    setError(null);
    work().then(refresh, (failure) => {
      setError(ipcErrorMessage(failure));
      refresh();
    });
  };
  const row = (routine: RoutineWithRuns) => (
    <RoutineRow
      key={routine.id}
      routine={routine}
      meta={routineMeta(routine, { chatTitle: (id) => chatTitles.get(id), modelName, now })}
      status={routineStatus(routine, now)}
      onToggle={(on) => act(() => window.milagre.updateRoutine(routine.id, { enabled: on }))}
      onEdit={() => setForm(routine)}
      onRunNow={() => act(() => window.milagre.runRoutineNow(routine.id))}
      onOpenChat={onOpenChat}
      onDelete={() => act(() => window.milagre.deleteRoutine(routine.id))}
    />
  );
  const chips: Array<{ id: Filter; label: string; count: number }> = [
    { id: "all", label: "All", count: routines.length },
    { id: "heartbeats", label: "Heartbeats", count: groups.heartbeats.length },
    { id: "triggers", label: "Triggers", count: groups.triggers.length },
    { id: "paused", label: "Paused", count: groups.paused.length },
  ];

  return (
    <ScrollArea className="h-full">
      <div data-routines-page className="mx-auto w-full max-w-[720px] px-6 pt-14 pb-10">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-ink">Routines</h1>
            <p className="mt-1 text-[13px] text-ink-2">Agents that run on a schedule or when something happens elsewhere.</p>
          </div>
          {enabled && (
            <button
              type="button"
              data-routine-new
              onClick={() => setForm("new")}
              className="inline-flex h-[34px] shrink-0 items-center gap-1.5 rounded-lg bg-ink px-3.5 text-[13px] font-medium text-surface transition-opacity hover:opacity-90"
            >
              <HugeiconsIcon icon={PlusSignIcon} size={15} strokeWidth={2} color="currentColor" />
              New routine
            </button>
          )}
        </div>
        {(error || loadError) && (
          <p role="alert" className="mt-4 text-[13px] break-words text-red">
            {error ?? loadError}
          </p>
        )}
        {enabled === false ? (
          <div data-routines-off className="mt-8 flex flex-col items-center rounded-xl border border-line bg-surface px-6 py-10 text-center">
            <span className="flex size-10 items-center justify-center rounded-xl bg-field text-ink-2">
              <HugeiconsIcon icon={RepeatIcon} size={20} strokeWidth={1.8} color="currentColor" />
            </span>
            <p className="mt-3 text-[14px] font-medium text-ink">Routines are off</p>
            <p className="mt-1 max-w-[420px] text-[13px] text-ink-2">
              Turn them on in{" "}
              <button type="button" data-routines-experimental className="font-medium text-ink underline underline-offset-2" onClick={onOpenExperimental}>
                Settings › Experimental
              </button>
              .
            </p>
            <p className="mt-3 max-w-[420px] text-[12px] text-ink-3">{HELP}</p>
          </div>
        ) : enabled ? (
          <>
            <div role="tablist" aria-label="Show" className="mt-5 flex gap-1.5">
              {chips.map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  role="tab"
                  aria-selected={filter === chip.id}
                  data-routine-chip={chip.id}
                  onClick={() => setFilter(chip.id)}
                  className={`h-7 rounded-full px-3 text-[12px] font-medium transition-colors ${
                    filter === chip.id ? "bg-ink text-surface" : "border border-line-strong bg-surface text-ink-2 hover:bg-hover"
                  }`}
                >
                  {chip.label} {chip.count}
                </button>
              ))}
            </div>
            <div className="mt-5 space-y-5">
              {heartbeats.length > 0 && (
                <section data-routine-group="heartbeats" className="space-y-2">
                  <h2 className="flex items-center gap-1.5 px-1 text-[13px] font-semibold text-ink">
                    <HugeiconsIcon icon={Pulse01Icon} size={14} strokeWidth={1.8} color="currentColor" className="text-ink-2" />
                    Heartbeats
                  </h2>
                  <div className={card}>{heartbeats.map(row)}</div>
                </section>
              )}
              {triggers.length > 0 && (
                <section data-routine-group="triggers" className="space-y-2">
                  <h2 className="flex items-center gap-1.5 px-1 text-[13px] font-semibold text-ink">
                    <HugeiconsIcon icon={ZapIcon} size={14} strokeWidth={1.8} color="currentColor" className="text-ink-2" />
                    Triggers
                  </h2>
                  <div className={card}>{triggers.map(row)}</div>
                </section>
              )}
              {heartbeats.length === 0 && triggers.length === 0 && (
                <p data-routines-empty className="px-1 text-[13px] text-ink-3">
                  {routines.length === 0 ? "No Routines yet. Make one with New routine, or ask an agent in a Chat to check back later." : "None here."}
                </p>
              )}
              <p data-routines-help className="px-1 text-[12px] text-ink-3">
                {HELP}
              </p>
            </div>
          </>
        ) : null}
      </div>
      {form && (
        <RoutineForm
          initial={form === "new" ? undefined : form}
          models={models}
          defaultProjectPath={projectPath}
          onClose={() => {
            setForm(null);
            refresh();
          }}
        />
      )}
    </ScrollArea>
  );
}
