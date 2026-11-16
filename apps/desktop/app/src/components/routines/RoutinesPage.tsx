import { useEffect, useMemo, useRef, useState } from "react";
import { LaptopIcon, PlusSignIcon, TimeScheduleIcon } from "@hugeicons/core-free-icons";
import type { ModelCapabilities, ModelOption } from "@milagre/shared/model";
import { ipcErrorMessage } from "@milagre/shared/result";
import { ScrollArea } from "../primitives/ScrollArea";
import { Button } from "../primitives/Button";
import { EmptyState } from "../primitives/EmptyState";
import { Icon } from "../primitives/Icon";
import { InlineError } from "../primitives/InlineError";
import { SectionLabel } from "../primitives/SectionLabel";
import { Select } from "../primitives/Select";
import { RoutineRow } from "./RoutineRow";
import { RoutineEditor } from "./RoutineEditor";
import { RoutinePage } from "./RoutinePage";
import { FlowPage } from "./FlowPage";
import { LOCAL_COMPUTER } from "@milagre/shared/chat-scopes";
import { computerOfRoutine, groupRoutines, routineMeta, routineStatus, useRoutines, type RoutineWithRuns } from "../../lib/routines";
import { bridgeFor, bridgeForKey } from "../../lib/computer-bridge";
import { isDimmed, useComputers } from "../../lib/computers";
import type { ComputerView } from "../../electron.d.ts";

type Filter = "all" | "heartbeats" | "triggers" | "paused";
const HELP = "Routines run while the computer they are on is awake. Closing the lid on battery pauses them.";
const NOT_REMOTE = "Not available on a remote computer";

function computerRoutinesProblem(view: ComputerView, error: string | null): string | null {
  if (error?.includes(NOT_REMOTE)) return `Update Milagre on ${view.name} to see its Routines.`;
  if (isDimmed(view)) return `${view.name} is offline. Its Routines are the last copy it sent; you can change them once it's back.`;
  if (error) return `Couldn't read ${view.name}'s Routines: ${error}`;
  return null;
}
const card = "divide-y divide-line overflow-hidden rounded-card bg-surface shadow-card";

const NO_CHATS: ReadonlySet<string> = new Set();

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
  capabilities?: ModelCapabilities | null;
  projectPath?: string;
  unreadRoutines?: ReadonlySet<string>;
  routineId?: string | null;
  unreadChats?: ReadonlySet<string>;
  canOpen?: (chatKey: string) => boolean;
  runChat?: string | null;
  onOpenRoutine?: (routineId: string | null) => void;
  onOpenChat: (chatKey: string) => void;
  onMarkRead?: (routineId: string) => void;
  onOpenRunChat?: (chatKey: string) => void;
  onCloseRunChat?: () => void;
}) {
  const { enabled: read, routines, error: loadError, byComputer, refresh } = useRoutines();
  const enabled = read !== null;
  const { thisMac, computers } = useComputers();
  const computerName = (id: string) => (id === LOCAL_COMPUTER ? thisMac : (computers.find((computer) => computer.id === id)?.name ?? "Computer"));
  const remoteProblems = computers.flatMap((computer) => {
    const problem = computerRoutinesProblem(computer, byComputer[computer.id]?.error ?? null);
    return problem ? [{ id: computer.id, problem }] : [];
  });
  const onComputers = Object.keys(byComputer).filter((id) => typeof byComputer[id]?.enabled === "boolean");
  const onKey = onComputers.join(",");
  const [filter, setFilter] = useState<Filter>("all");
  const [onComputer, setOnComputer] = useState<string>("all");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [created, setCreated] = useState<{ id: string; url: string } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [chatTitles, setChatTitles] = useState<Map<string, string>>(new Map());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
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
  const editHere = (current: string | null) => current === null || current === routineId || (current === "new" && !routineId);
  const switching = !editHere(editing) && dirty;
  useEffect(() => {
    if (!dirty) setEditing((current) => (editHere(current) ? current : null));
  }, [routineId, dirty]);
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
  const rowComputer = (routine: RoutineWithRuns) => {
    const id = computerOfRoutine(routine);
    if (pickedComputer !== "all") return null;
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
  const kinds: Array<{ value: Filter; label: string; count: number }> = [
    { value: "all", label: "All Routines", count: listed.length },
    { value: "heartbeats", label: "Heartbeats", count: groups.heartbeats.length },
    { value: "triggers", label: "Triggers", count: groups.triggers.length },
    { value: "paused", label: "Paused", count: groups.paused.length },
  ];
  const onEach = (id: string) => (id === "all" ? routines.length : routines.filter((routine) => computerOfRoutine(routine) === id).length);

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
  if (enabled && switching) {
    const target = editing === "new" ? undefined : routines.find((routine) => routine.id === editing);
    if (editing === "new" || target) return editor(target);
  }
  if (enabled && selected && editing === selected.id) return editor(selected);
  if (enabled && selected?.flow)
    return (
      <FlowPage
        key={selected.id}
        routine={selected}
        models={models}
        capabilities={capabilities}
        unreadChats={unreadChats}
        canOpen={canOpen}
        selectedChat={runChat}
        narrow={Boolean(runChat)}
        createdHookUrl={created?.id === selected.id ? created.url : undefined}
        onDismissHook={() => setCreated(null)}
        onBack={() => onOpenRoutine?.(null)}
        onOpenChat={onOpenRunChat ?? onOpenChat}
      />
    );
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
          <h1 className="min-w-0 text-22 font-semibold tracking-[-0.02em] text-ink">Routines</h1>
          {enabled && (
            <Button data-routine-new onClick={() => setEditing("new")}>
              <Icon icon={PlusSignIcon} size={16} />
              New Routine
            </Button>
          )}
        </div>
        <InlineError className="mt-4">{error ?? loadError}</InlineError>
        {remoteProblems.map(({ id, problem }) => (
          <p key={id} data-routines-computer-problem={id} className="mt-2 text-13 break-words text-ink-2">
            {problem}
          </p>
        ))}
        {enabled ? (
          <>
            {routines.length > 0 && (
              <div data-routine-filters className="mt-5 flex flex-wrap items-center gap-2">
                <Select<Filter>
                  label="Show"
                  variant="chip"
                  align="start"
                  width={200}
                  value={filter}
                  options={kinds.map((kind) => ({ value: kind.value, label: kind.label, trailing: String(kind.count) }))}
                  onChange={setFilter}
                />
                {computerChoices.length > 0 && (
                  <Select
                    label="Computer"
                    variant="chip"
                    align="start"
                    width={220}
                    value={pickedComputer}
                    leading={<Icon icon={LaptopIcon} size={14} className="shrink-0" />}
                    options={["all", ...computerChoices].map((id) => ({
                      value: id,
                      label: id === "all" ? "Every computer" : computerName(id),
                      trailing: String(onEach(id)),
                    }))}
                    onChange={setOnComputer}
                  />
                )}
              </div>
            )}
            <div className={empty ? "flex min-h-[200px] flex-1 flex-col items-center justify-center gap-3 py-10 text-center" : "mt-5 space-y-5"}>
              {heartbeats.length > 0 && (
                <section data-routine-group="heartbeats" className="space-y-2">
                  <SectionLabel>Heartbeats</SectionLabel>
                  <div className={card}>{heartbeats.map(row)}</div>
                </section>
              )}
              {triggers.length > 0 && (
                <section data-routine-group="triggers" className="space-y-2">
                  <SectionLabel>Triggers</SectionLabel>
                  <div className={card}>{triggers.map(row)}</div>
                </section>
              )}
              {empty && (
                <EmptyState data-routines-empty icon={TimeScheduleIcon} title="No Routines yet" className="p-0">
                  {HELP}
                </EmptyState>
              )}
              {routines.length > 0 && heartbeats.length === 0 && triggers.length === 0 && (
                <p data-routines-empty className="text-13 text-ink-3">
                  None here.
                </p>
              )}
            </div>
          </>
        ) : null}
      </div>
    </ScrollArea>
  );
}
