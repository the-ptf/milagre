import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft02Icon,
  BubbleChatIcon,
  Cancel01Icon,
  Folder01Icon,
  GitBranchIcon,
  PencilEdit02Icon,
  PlayIcon,
  RefreshIcon,
  SecurityCheckIcon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import type { ModelOption, RoutineRun } from "@milagre/shared/model";
import { PERMISSION_MODES } from "@milagre/shared/model-copy";
import {
  canEditRoutine,
  canRunNow,
  clock,
  fallbackText,
  filterRuns,
  routineRetries,
  routineTimes,
  routineWhereText,
  runFilterCounts,
  triggerChipText,
  type RunFilter,
} from "@milagre/shared/routines";
import { ipcErrorMessage } from "@milagre/shared/result";
import { ScrollArea } from "../primitives/ScrollArea";
import { SettingCheckbox } from "../primitives/Checkbox";
import Tooltip from "../primitives/Tooltip";
import { routineProblem } from "./RoutineRow";
import { Chip, Segmented } from "./RoutineChips";
import { HookUrl } from "./RoutineEditor";
import { RunList } from "./RunList";
import { routineIcon } from "./routine-icon";
import { computerOfRoutine, refreshRoutines, type RoutineWithRuns } from "../../lib/routines";
import { bridgeForKey } from "../../lib/computer-bridge";
import { localZone } from "./use-routine-form";
import { thisComputer } from "../../lib/shortcut-hints";

const toolButton =
  "flex size-[26px] shrink-0 items-center justify-center rounded-[7px] text-ink-2 transition-colors hover:bg-hover-2 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent";

/** "On" in green, or "Paused" in grey, beside the Routine's name. */
function RoutineStatusPill({ on }: { on: boolean }) {
  return (
    <span
      data-routine-status-pill={on ? "on" : "paused"}
      className={`inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full px-2 text-[11.5px] font-semibold ${on ? "bg-green-tint text-green-ink" : "bg-field text-ink-3"}`}
    >
      <span aria-hidden="true" className={`size-1.5 rounded-full ${on ? "bg-green" : "bg-ink-3"}`} />
      {on ? "On" : "Paused"}
    </span>
  );
}

/**
 * One Routine's page: back to the Routines page, its name with On or Paused and one toolbar (switch, Run now, Edit), its
 * settings as chips, when it runs next and last ran, then its Runs by day, filtered by All, Acted, Failed or Unread. With
 * `narrow`, it is the column beside an open Run Chat.
 */
export function RoutinePage({
  routine,
  models,
  unreadChats,
  chatTitle,
  canOpen,
  selectedChat = null,
  narrow = false,
  createdHookUrl,
  onDismissHook,
  onBack,
  onEdit,
  onOpenChat,
}: {
  routine: RoutineWithRuns;
  models: ModelOption[];
  /** The keys of hidden Run Chats nobody opened: their Runs show a dot. */
  unreadChats: ReadonlySet<string>;
  /** A Chat's title, for a Heartbeat's Where chip ("In Notification chimes"). */
  chatTitle?: (chatId: string) => string | undefined;
  /** Whether a Run's row opens its Chat (canOpenRunChat); a Run whose Chat is gone opens nothing. */
  canOpen?: (chatKey: string) => boolean;
  /** The Run Chat open beside the page. */
  selectedChat?: string | null;
  narrow?: boolean;
  /** A webhook Routine just created here: its URL, shown once with Copy. */
  createdHookUrl?: string;
  onDismissHook?: () => void;
  onBack: () => void;
  onEdit: () => void;
  onOpenChat: (chatKey: string) => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<RunFilter>("all");
  // The Runs list starts again (folds and days closed) only when a filter is picked, not when one falls back to All.
  const [listKey, setListKey] = useState(0);
  const back = useRef<HTMLButtonElement>(null);

  // "last Run 11:47" turns into "last Run yesterday 11:47", and Today into Yesterday, with the clock.
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
    const refresh = () => refreshRoutines(computerOfRoutine(routine));
    work().then(refresh, (failure) => {
      setError(ipcErrorMessage(failure));
      refresh();
    });
  };
  const problem = routineProblem(routine);
  const unread = (run: RoutineRun) => Boolean(run.chatId && unreadChats.has(run.chatId) && (canOpen?.(run.chatId) ?? false));
  const counts = runFilterCounts(routine.runs, unread);
  // A filter whose Runs are all gone (the last unread one read) falls back to All.
  const shownFilter = filter !== "all" && counts[filter] === 0 ? "all" : filter;
  const runs = filterRuns(routine.runs, shownFilter, unread);
  const { target } = routine;
  const model = routine.model ? (models.find((entry) => entry.id === routine.model)?.name ?? routine.model) : "Default model";
  const mode = routine.permissionMode
    ? (PERMISSION_MODES.find((entry) => entry.id === routine.permissionMode)?.name ?? routine.permissionMode)
    : "Default mode";
  const times = routineTimes(routine, now);
  const filters = (
    [
      { value: "all", label: "All", count: counts.all },
      { value: "acted", label: "Acted", count: counts.acted },
      { value: "failed", label: "Failed", count: counts.failed },
      { value: "unread", label: "Unread", count: counts.unread },
    ] as const
  ).filter((option) => option.value === "all" || option.count > 0);

  return (
    <ScrollArea className="flex h-full flex-col">
      <div data-routine-page={routine.id} className={`flex w-full flex-1 flex-col pb-10 ${narrow ? "px-3 pt-4" : "mx-auto max-w-[680px] px-6 pt-14"}`}>
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
        <div className="mt-3 flex items-center gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <h1 className={`truncate text-[20px] leading-[26px] font-semibold tracking-[-0.01em] ${routine.enabled ? "text-ink" : "text-ink-2"}`}>
              {routine.name}
            </h1>
            <RoutineStatusPill on={routine.enabled} />
          </div>
          <div data-routine-toolbar className="flex h-[34px] shrink-0 items-center gap-1 rounded-[10px] border border-line bg-surface pr-1 pl-2">
            <SettingCheckbox
              label={`${routine.name} on`}
              checked={routine.enabled}
              onChange={(on) => act(() => bridgeForKey(routine.id).updateRoutine(routine.id, { enabled: on }))}
            />
            <span aria-hidden="true" className="mx-1 h-4 w-px bg-line" />
            {canRunNow(routine) && (
              <Tooltip label="Run now" side="bottom">
                <button
                  type="button"
                  aria-label="Run now"
                  data-routine-run-now
                  disabled={!routine.enabled}
                  className={toolButton}
                  onClick={() => act(() => bridgeForKey(routine.id).runRoutineNow(routine.id))}
                >
                  <HugeiconsIcon icon={PlayIcon} size={15} strokeWidth={1.8} color="currentColor" />
                </button>
              </Tooltip>
            )}
            {/* A babysit Heartbeat follows the Babysit PRs settings: no form edits it (the list's menu still deletes it). */}
            {canEditRoutine(routine) && (
              <Tooltip label="Edit" side="bottom">
                <button type="button" aria-label="Edit" data-routine-edit className={toolButton} onClick={onEdit}>
                  <HugeiconsIcon icon={PencilEdit02Icon} size={15} strokeWidth={1.8} color="currentColor" />
                </button>
              </Tooltip>
            )}
          </div>
        </div>
        <div data-routine-chips className="mt-3 flex flex-wrap items-center gap-2">
          <Chip icon={routineIcon(routine)} data-routine-chip="trigger">
            {triggerChipText(routine.trigger, localZone())}
          </Chip>
          <Chip icon={target.kind === "chat" ? BubbleChatIcon : target.workspace === "worktree" ? GitBranchIcon : Folder01Icon} data-routine-chip="where">
            {routineWhereText(target, chatTitle)}
          </Chip>
          <Chip icon={SparklesIcon} data-routine-chip="model">
            {model}
          </Chip>
          {routineRetries(routine) && (
            <Chip icon={RefreshIcon} data-routine-chip="fallback">
              {fallbackText(routine, (provider, id) => models.find((entry) => entry.provider === provider && entry.id === id)?.name)}
            </Chip>
          )}
          <Chip icon={SecurityCheckIcon} data-routine-chip="mode">
            {mode}
          </Chip>
        </div>
        {times && (
          <p data-routine-times className="mt-2.5 text-[12.5px] text-ink-3">
            {times}
          </p>
        )}
        {problem && (
          <p data-routine-problem className="mt-2 text-[12.5px] break-words text-red-ink">
            {problem}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-[13px] break-words text-red-ink">
            {error}
          </p>
        )}
        {createdHookUrl && (
          <div data-routine-created className="mt-4 space-y-2 rounded-xl border border-line px-4 py-3">
            <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1 text-[12.5px] text-ink-2">
                Routine created. Send POST requests to this URL. While {thisComputer} is away, the relay holds them for up to 24 hours.
              </p>
              <button
                type="button"
                aria-label="Dismiss"
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-ink"
                onClick={onDismissHook}
              >
                <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={1.8} color="currentColor" />
              </button>
            </div>
            <HookUrl url={createdHookUrl} editing={false} />
          </div>
        )}
        <section data-routine-runs className="mt-7">
          <div className="mb-2 flex items-center gap-3">
            <h2 className="flex-1 text-[13px] font-semibold text-ink">Runs</h2>
            {routine.runs.length > 0 && (
              <Segmented<RunFilter>
                label="Show"
                value={shownFilter}
                options={filters}
                onChange={(next) => {
                  if (next !== shownFilter) setListKey((key) => key + 1);
                  setFilter(next);
                }}
                className="shrink-0"
              />
            )}
          </div>
          {routine.runs.length > 0 ? (
            <RunList
              key={listKey}
              runs={runs}
              routineName={routine.name}
              now={now}
              unreadChats={unreadChats}
              canOpen={canOpen}
              selectedChat={selectedChat}
              onOpenChat={onOpenChat}
            />
          ) : (
            <div data-routine-runs-empty className="space-y-0.5">
              <p className="text-[13px] text-ink-2">No Runs yet</p>
              {routine.enabled && typeof routine.nextRunAt === "number" && <p className="text-[12.5px] text-ink-3">Next Run {clock(routine.nextRunAt)}</p>}
            </div>
          )}
        </section>
      </div>
    </ScrollArea>
  );
}
