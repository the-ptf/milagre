import { useEffect, useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { LaptopIcon, PlusSignIcon, Pulse01Icon, RepeatIcon, ZapIcon } from "@hugeicons/core-free-icons";
import type { ModelCapabilities, ModelOption } from "@milagre/shared/model";
import { ipcErrorMessage } from "@milagre/shared/result";
import { ScrollArea } from "../primitives/ScrollArea";
import { RoutineRow } from "./RoutineRow";
import { RoutineEditor } from "./RoutineEditor";
import { RoutinePage } from "./RoutinePage";
import { LOCAL_COMPUTER } from "@milagre/shared/chat-scopes";
import { computerOfRoutine, groupRoutines, routineMeta, routineStatus, useRoutines, type RoutineWithRuns } from "../../lib/routines";
import { bridgeFor, bridgeForKey } from "../../lib/computer-bridge";
import { isDimmed, useComputers } from "../../lib/computers";
import type { ComputerView } from "../../electron.d.ts";

type Filter = "all" | "heartbeats" | "triggers" | "paused";
const HELP = "Routines run while the computer they are on is awake. Closing the lid on battery pauses them.";
const NOT_REMOTE = "Not available on a remote computer";

/**
 * Why another computer's Routines aren't listed or current, or null when they are. An older Milagre there refuses them
 * outright; an offline one is shown from the last copy it sent, which can't be changed until it is back. (One that can't
 * run Routines yet gets the Allow notice instead.)
 */
function computerRoutinesProblem(view: ComputerView, error: string | null): string | null {
  if (error?.includes(NOT_REMOTE)) return `Update Milagre on ${view.name} to see its Routines.`;
  if (isDimmed(view)) return `${view.name} is offline. Its Routines are the last copy it sent; you can change them once it's back.`;
  if (error) return `Couldn't read ${view.name}'s Routines: ${error}`;
  return null;
}
const card = "divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface";

const NO_CHATS: ReadonlySet<string> = new Set();

/**
 * The Routines page: the heartbeats and triggers of this Mac and every paired computer, each with its switch and actions, and New Routine. With
 * `routineId` it shows that Routine's own page, with its Runs, instead.
 */
export function RoutinesPage({
  models,
  capabilities = null,
  projectPath,
  unreadRoutines,
  routineId = null,
  unreadChats = NO_CHATS,
  canOpen,
  runChat = null,
  onOpenRoutine,
  onOpenChat,
  onMarkRead,
  onOpenRunChat,
  onCloseRunChat,
}: {
  models: ModelOption[];
  /** What each reported model accepts (efforts), for the fallback's effort. */
  capabilities?: ModelCapabilities | null;
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
  /** Marks a Routine's unread Run Chats read: its row's Mark as read. */
  onMarkRead?: (routineId: string) => void;
  /** Opens a Run's Chat beside the Routine's page; without it a Run opens its Chat in the window (onOpenChat). */
  onOpenRunChat?: (chatKey: string) => void;
  /** Closes the Run Chat beside the page: Edit and New Routine take the page over. */
  onCloseRunChat?: () => void;
}) {
  const { enabled: read, routines, error: loadError, byComputer, refresh } = useRoutines();
  // Routines have no switch: the page shows once this Mac has answered.
  const enabled = read !== null;
  const { thisMac, computers } = useComputers();
  // With other computers, each row says which Mac it runs on, as Chat rows do.
  const computerName = (id: string) => (id === LOCAL_COMPUTER ? thisMac : (computers.find((computer) => computer.id === id)?.name ?? "Computer"));
  const remoteProblems = computers.flatMap((computer) => {
    const problem = computerRoutinesProblem(computer, byComputer[computer.id]?.error ?? null);
    return problem ? [{ id: computer.id, problem }] : [];
  });
  const onComputers = Object.keys(byComputer).filter((id) => typeof byComputer[id]?.enabled === "boolean");
  const onKey = onComputers.join(",");
  const [filter, setFilter] = useState<Filter>("all");
  // One computer's Routines only, or every computer's ("all").
  const [onComputer, setOnComputer] = useState<string>("all");
  const [error, setError] = useState<string | null>(null);
  // The Routine whose page shows its form in place (its id), "new" for New Routine in place of the list, or null.
  const [editing, setEditing] = useState<string | null>(null);
  // Whether the open form has changes nobody saved: moving to another Routine, or the list, asks to discard them first.
  const [dirty, setDirty] = useState(false);
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
  // A heartbeat's row names its Chat; each computer's Routine targets carry its Projects' Chat titles.
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    Promise.all(onComputers.map((id) => Promise.resolve().then(() => bridgeFor(id).routineTargets())))
      .then((read) => read.flatMap((targets) => targets.projects))
      .then(
        (projects) => {
          if (!live) return;
          setChatTitles(new Map(projects.flatMap((project) => project.chats.map((chat) => [chat.chatId, chat.title] as const))));
        },
        (failure) => live && setError(`Couldn't read Chat names: ${ipcErrorMessage(failure)}`),
      );
    return () => {
      live = false;
    };
  }, [enabled, routines.length, onKey]);

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
  // An edit belongs to its Routine's page: opening another page, or the list, leaves it, once its changes are discarded.
  const editHere = (current: string | null) => current === null || current === routineId || (current === "new" && !routineId);
  const switching = !editHere(editing) && dirty;
  useEffect(() => {
    if (!dirty) setEditing((current) => (editHere(current) ? current : null));
  }, [routineId, dirty]);
  // Edit and New Routine take the page over: a Run Chat open beside it closes.
  useEffect(() => {
    if (editing !== null) onCloseRunChat?.();
  }, [editing]);
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

  // With paired computers, the list narrows to one of them; a computer that leaves takes its choice with it.
  const computerChoices =
    computers.length > 0 ? [LOCAL_COMPUTER, ...computers.filter((computer) => byComputer[computer.id]).map((computer) => computer.id)] : [];
  const pickedComputer = computerChoices.includes(onComputer) ? onComputer : "all";
  const listed = useMemo(
    () => (pickedComputer === "all" ? routines : routines.filter((routine) => computerOfRoutine(routine) === pickedComputer)),
    [routines, pickedComputer],
  );
  const groups = useMemo(() => groupRoutines(listed), [listed]);
  const shown = (list: RoutineWithRuns[]) => (filter === "paused" ? list.filter((routine) => !routine.enabled) : list);
  const heartbeats = filter === "triggers" ? [] : shown(groups.heartbeats);
  const triggers = filter === "heartbeats" ? [] : shown(groups.triggers);
  const empty = enabled && routines.length === 0 && !error && !loadError;
  const modelName = (_provider: unknown, id: string) => models.find((model) => model.id === id)?.name ?? id;

  const act = (routine: RoutineWithRuns, work: () => Promise<unknown>) => {
    setError(null);
    const again = () => refresh(computerOfRoutine(routine));
    work().then(again, (failure) => {
      setError(ipcErrorMessage(failure));
      again();
    });
  };
  // Another computer's row leads with its laptop mark and name, as a Chat row does; this Mac's needs none.
  const rowComputer = (routine: RoutineWithRuns) => {
    const id = computerOfRoutine(routine);
    const view = id === LOCAL_COMPUTER ? undefined : computers.find((computer) => computer.id === id);
    return id === LOCAL_COMPUTER ? null : { name: view?.name ?? "Computer", offline: view ? isDimmed(view) : false };
  };
  const row = (routine: RoutineWithRuns) => (
    <RoutineRow
      key={routine.id}
      routine={routine}
      computer={rowComputer(routine)}
      meta={routineMeta(routine, { chatTitle: (id) => chatTitles.get(id), modelName, now })}
      status={routineStatus(routine, now)}
      unread={unreadRoutines?.has(routine.id) ?? false}
      onOpen={() => onOpenRoutine?.(routine.id)}
      onToggle={(on) => act(routine, () => bridgeForKey(routine.id).updateRoutine(routine.id, { enabled: on }))}
      onEdit={() => {
        setEditing(routine.id);
        onOpenRoutine?.(routine.id);
      }}
      onRunNow={() => act(routine, () => bridgeForKey(routine.id).runRoutineNow(routine.id))}
      onOpenChat={onOpenChat}
      onMarkRead={onMarkRead ? () => onMarkRead(routine.id) : undefined}
      onDelete={() => act(routine, () => bridgeForKey(routine.id).deleteRoutine(routine.id))}
    />
  );
  const chips: Array<{ id: Filter; label: string; count: number }> = [
    { id: "all", label: "All", count: listed.length },
    { id: "heartbeats", label: "Heartbeats", count: groups.heartbeats.length },
    { id: "triggers", label: "Triggers", count: groups.triggers.length },
    { id: "paused", label: "Paused", count: groups.paused.length },
  ];

  const editor = (initial?: RoutineWithRuns) => (
    <RoutineEditor
      key={initial?.id ?? "new"}
      initial={initial}
      models={models}
      capabilities={capabilities}
      defaultProjectPath={projectPath}
      onDirtyChange={setDirty}
      error={opening ? loadError : null}
      leaving={
        switching
          ? {
              onDiscard: () => {
                setDirty(false);
                setEditing(null);
              },
              // Back to the Routine (or the list) the form belongs to.
              onKeep: () => onOpenRoutine?.(editing === "new" ? null : editing),
            }
          : null
      }
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
  // A form with changes stays while the window moves elsewhere, asking to discard them.
  if (enabled && switching) {
    const target = editing === "new" ? undefined : routines.find((routine) => routine.id === editing);
    if (editing === "new" || target) return editor(target);
  }
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
          <p role="alert" className="mt-4 text-[13px] break-words text-red-ink">
            {error ?? loadError}
          </p>
        )}
        {remoteProblems.map(({ id, problem }) => (
          <p key={id} data-routines-computer-problem={id} className="mt-2 text-[13px] break-words text-ink-2">
            {problem}
          </p>
        ))}
        {enabled ? (
          <>
            {routines.length > 0 && (
              <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2">
                <div role="tablist" aria-label="Show" className="flex gap-1.5">
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
                {computerChoices.length > 0 && (
                  <div role="tablist" aria-label="Computer" className="flex flex-wrap gap-1.5">
                    {["all", ...computerChoices].map((id) => (
                      <button
                        key={id}
                        type="button"
                        role="tab"
                        aria-selected={pickedComputer === id}
                        data-routine-computer-filter={id}
                        onClick={() => setOnComputer(id)}
                        className={`inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] font-medium transition-colors ${
                          pickedComputer === id ? "bg-ink text-surface" : "border border-line-strong bg-surface text-ink-2 hover:bg-hover"
                        }`}
                      >
                        {id !== "all" && <HugeiconsIcon icon={LaptopIcon} size={13} strokeWidth={2} color="currentColor" />}
                        {id === "all" ? "Every computer" : computerName(id)}{" "}
                        {id === "all" ? routines.length : routines.filter((routine) => computerOfRoutine(routine) === id).length}
                      </button>
                    ))}
                  </div>
                )}
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
