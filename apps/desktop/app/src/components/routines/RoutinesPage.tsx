import { useEffect, useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlusSignIcon, Pulse01Icon, RepeatIcon, ZapIcon } from "@hugeicons/core-free-icons";
import type { ModelOption } from "@milagre/shared/model";
import { ipcErrorMessage } from "@milagre/shared/result";
import { ScrollArea } from "../primitives/ScrollArea";
import { RoutineRow } from "./RoutineRow";
import { RoutineEditor } from "./RoutineEditor";
import { RoutinePage } from "./RoutinePage";
import { groupRoutines, routineMeta, routineStatus, useRoutines, type RoutineWithRuns } from "../../lib/routines";

type Filter = "all" | "heartbeats" | "triggers" | "paused";
const HELP = "Routines run while this Mac is awake. Closing the lid on battery pauses them.";
const card = "divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface";

const NO_CHATS: ReadonlySet<string> = new Set();

/**
 * The Routines page: this Mac's heartbeats and triggers, each with its switch and actions, and New Routine. With
 * `routineId` it shows that Routine's own page, with its Runs, instead.
 */
export function RoutinesPage({
  models,
  projectPath,
  unreadRoutines,
  routineId = null,
  unreadChats = NO_CHATS,
  canOpen,
  runChat = null,
  onOpenRoutine,
  onOpenChat,
  onOpenRunChat,
  onOpenExperimental,
}: {
  models: ModelOption[];
  /** The open Project, where a new Routine runs unless another is picked. */
  projectPath?: string;
  /** The ids of Routines with a hidden Run Chat nobody opened: their rows show a dot. */
  unreadRoutines?: ReadonlySet<string>;
  /** The Routine whose page is open, or null for the list. */
  routineId?: string | null;
  /** The keys of hidden Run Chats nobody opened: their Runs show a dot on the Routine's page. */
  unreadChats?: ReadonlySet<string>;
  /** Whether a Run's row opens its Chat (canOpenRunChat). */
  canOpen?: (chatKey: string) => boolean;
  /** The Run Chat open beside the Routine's page, which then narrows to a column. */
  runChat?: string | null;
  /** Opens a Routine's page (a row's click), or goes back to the list with null. */
  onOpenRoutine?: (routineId: string | null) => void;
  onOpenChat: (chatKey: string) => void;
  /** Opens a Run's Chat beside the Routine's page; without it a Run opens its Chat in the window (onOpenChat). */
  onOpenRunChat?: (chatKey: string) => void;
  onOpenExperimental: () => void;
}) {
  const { enabled, routines, error: loadError, refresh } = useRoutines();
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState<string | null>(null);
  // The Routine whose page shows its form in place (its id), "new" for New Routine in place of the list, or null.
  const [editing, setEditing] = useState<string | null>(null);
  // A webhook Routine just created: its page shows the URL once.
  const [created, setCreated] = useState<{ id: string; url: string } | null>(null);
  // A Routine just created, until the Mac's list has it: then its page opens (before, it would read as deleted).
  const [opening, setOpening] = useState<string | null>(null);
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
        (failure) => live && setError(`Couldn't read Chat names: ${ipcErrorMessage(failure)}`),
      );
    return () => {
      live = false;
    };
  }, [enabled, routines.length]);

  const selected = routineId ? routines.find((routine) => routine.id === routineId) : undefined;
  // A Routine deleted (here, from its page, or anywhere else) takes its page with it: back to the list.
  const gone = Boolean(routineId && enabled && !loadError && !selected);
  useEffect(() => {
    if (gone) onOpenRoutine?.(null);
  }, [gone, onOpenRoutine]);
  const arrived = opening !== null && routines.some((routine) => routine.id === opening);
  useEffect(() => {
    if (!arrived || !opening) return;
    setOpening(null);
    setEditing(null);
    onOpenRoutine?.(opening);
  }, [arrived, opening, onOpenRoutine]);
  // An edit belongs to its Routine's page: opening another page, or the list, leaves it.
  useEffect(() => {
    setEditing((current) => (current === null || current === routineId || (current === "new" && !routineId) ? current : null));
  }, [routineId]);
  // Back from a Routine's page, the keyboard lands on that Routine's row again (if it is still there).
  const lastOpened = useRef<string | null>(null);
  useEffect(() => {
    if (routineId) {
      lastOpened.current = routineId;
      return;
    }
    const id = lastOpened.current;
    lastOpened.current = null;
    if (id) document.querySelector<HTMLElement>(`[data-routine-row="${CSS.escape(id)}"] [data-routine-open]`)?.focus();
  }, [routineId]);

  const groups = useMemo(() => groupRoutines(routines), [routines]);
  const shown = (list: RoutineWithRuns[]) => (filter === "paused" ? list.filter((routine) => !routine.enabled) : list);
  const heartbeats = filter === "triggers" ? [] : shown(groups.heartbeats);
  const triggers = filter === "heartbeats" ? [] : shown(groups.triggers);
  const empty = enabled && routines.length === 0 && !error && !loadError;
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
      unread={unreadRoutines?.has(routine.id) ?? false}
      onOpen={() => onOpenRoutine?.(routine.id)}
      onToggle={(on) => act(() => window.milagre.updateRoutine(routine.id, { enabled: on }))}
      onEdit={() => {
        setEditing(routine.id);
        onOpenRoutine?.(routine.id);
      }}
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

  const editor = (initial?: RoutineWithRuns) => (
    <RoutineEditor
      key={initial?.id ?? "new"}
      initial={initial}
      models={models}
      defaultProjectPath={projectPath}
      onCancel={() => setEditing(null)}
      onSaved={() => {
        setEditing(null);
        refresh();
      }}
      onCreated={(routine, hookUrl) => {
        if (hookUrl) setCreated({ id: routine.id, url: hookUrl });
        setOpening(routine.id);
        refresh();
      }}
      onDeleted={() => {
        setEditing(null);
        refresh();
        onOpenRoutine?.(null);
      }}
    />
  );
  if (enabled && selected && editing === selected.id) return editor(selected);
  if (enabled && selected)
    return (
      <RoutinePage
        key={selected.id}
        routine={selected}
        models={models}
        unreadChats={unreadChats}
        chatTitle={(id) => chatTitles.get(id)}
        canOpen={canOpen}
        selectedChat={runChat}
        narrow={Boolean(runChat)}
        createdHookUrl={created?.id === selected.id ? created.url : undefined}
        onDismissHook={() => setCreated(null)}
        onBack={() => onOpenRoutine?.(null)}
        onEdit={() => setEditing(selected.id)}
        onOpenChat={onOpenRunChat ?? onOpenChat}
      />
    );
  if (enabled && editing === "new" && !routineId) return editor();

  return (
    <ScrollArea className="flex h-full flex-col">
      <div data-routines-page className="mx-auto flex w-full max-w-[720px] flex-1 flex-col px-6 pt-14 pb-10">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-ink">Routines</h1>
            <p className="mt-1 text-[13px] text-ink-2">Agents that run on a schedule or when something happens elsewhere.</p>
          </div>
          {enabled && (
            <button
              type="button"
              data-routine-new
              onClick={() => setEditing("new")}
              className="inline-flex h-[34px] shrink-0 items-center gap-1.5 rounded-lg bg-ink px-3.5 text-[13px] font-medium text-surface transition-opacity hover:opacity-90"
            >
              <HugeiconsIcon icon={PlusSignIcon} size={15} strokeWidth={2} color="currentColor" />
              New Routine
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
            {routines.length > 0 && (
              <div role="tablist" aria-label="Show" className="mt-5 flex gap-1.5">
                {chips.map((chip) => (
                  <button
                    key={chip.id}
                    type="button"
                    role="tab"
                    aria-selected={filter === chip.id}
                    data-routine-filter={chip.id}
                    onClick={() => setFilter(chip.id)}
                    className={`h-7 rounded-full px-3 text-[12px] font-medium transition-colors ${
                      filter === chip.id ? "bg-ink text-surface" : "border border-line-strong bg-surface text-ink-2 hover:bg-hover"
                    }`}
                  >
                    {chip.label} {chip.count}
                  </button>
                ))}
              </div>
            )}
            <div className={empty ? "flex min-h-[200px] flex-1 flex-col items-center justify-center gap-3 py-10 text-center" : "mt-5 space-y-5"}>
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
              {empty && (
                <div data-routines-empty className="flex flex-col items-center gap-3">
                  <HugeiconsIcon icon={RepeatIcon} size={40} strokeWidth={1.5} color="currentColor" className="text-ink-3" />
                  <p className="text-[13px] text-ink-2">No Routines yet.</p>
                </div>
              )}
              {routines.length > 0 && heartbeats.length === 0 && triggers.length === 0 && (
                <p data-routines-empty className="px-1 text-[13px] text-ink-3">
                  None here.
                </p>
              )}
            </div>
            <p data-routines-help className={`px-1 text-[12px] text-ink-3 ${empty ? "text-center" : "mt-5"}`}>
              {HELP}
            </p>
          </>
        ) : null}
      </div>
    </ScrollArea>
  );
}
