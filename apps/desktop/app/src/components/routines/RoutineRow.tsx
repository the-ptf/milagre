import { HugeiconsIcon } from "@hugeicons/react";
import { useRef, useState } from "react";
import {
  BubbleChatIcon,
  Delete02Icon,
  LaptopIcon,
  MoreHorizontalIcon,
  PauseCircleIcon,
  PencilEdit02Icon,
  PlayCircleIcon,
  PlayIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import type { Routine } from "@milagre/shared/model";
import { canEditRoutine, canRunNow } from "@milagre/shared/routines";
import { needsAnswer } from "@milagre/shared/routine-flows";
import { Button, IconButton } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import { MenuRow, Popover } from "../primitives/Popover";
import Tooltip from "../primitives/Tooltip";
import { isHeartbeat, routineDeleteQuestion, type RoutineWithRuns } from "../../lib/routines";
import { routineIcon } from "./routine-icon";

type HugeIconData = typeof PlayIcon;
const MENU_WIDTH = 200;
const STATUS = "min-w-[72px] shrink-0 text-right text-12 tabular-nums";

export function routineProblem(routine: Routine): string | undefined {
  return routine.pausedReason && !routine.enabled ? routine.pausedReason : routine.lastError;
}

function routineChat(routine: RoutineWithRuns): string | undefined {
  return routine.target.kind === "chat" ? routine.target.chatId : routine.runs.find((run) => run.chatId)?.chatId;
}

type MenuEntry = { key: string; label: string; icon: HugeIconData; danger?: boolean; onSelect: () => void };

function RoutineTile({ routine, large = false }: { routine: Routine; large?: boolean }) {
  return (
    <span className={`flex shrink-0 items-center justify-center ${large ? "size-10 rounded-card bg-field" : "size-8"}`}>
      <Icon icon={routineIcon(routine)} size={large ? 18 : 16} className={routine.enabled ? "text-ink-2" : "text-ink-3"} />
    </span>
  );
}

function RoutineMenu({ routine, entries }: { routine: Routine; entries: MenuEntry[] }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton
        ref={buttonRef}
        label={`Actions for ${routine.name}`}
        icon={MoreHorizontalIcon}
        aria-haspopup="menu"
        aria-expanded={open}
        data-routine-more
        onClick={() => setOpen((value) => !value)}
      />
      {open && (
        <Popover anchor={buttonRef} width={MENU_WIDTH} label={`Actions for ${routine.name}`} onClose={() => setOpen(false)} data-routine-menu>
          {entries.map((entry) => (
            <MenuRow
              key={entry.key}
              data-routine-action={entry.key}
              icon={entry.icon}
              title={entry.label}
              danger={entry.danger}
              onClick={() => {
                setOpen(false);
                entry.onSelect();
              }}
            />
          ))}
        </Popover>
      )}
    </>
  );
}

function DeleteQuestion({ routine, onCancel, onDelete, className = "" }: { routine: Routine; onCancel: () => void; onDelete: () => void; className?: string }) {
  return (
    <div data-routine-delete-question className={`flex min-h-11 items-center gap-2 ${className}`}>
      <span className="min-w-0 flex-1 text-12 text-ink">{routineDeleteQuestion(routine)}</span>
      <Button variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
      <Button variant="danger" data-routine-delete-confirm onClick={onDelete}>
        Delete
      </Button>
    </div>
  );
}

export function RoutineRow({
  routine,
  meta,
  computer = null,
  status,
  unread = false,
  onOpen,
  onToggle,
  onEdit,
  onRunNow,
  onOpenChat,
  onMarkRead,
  onDelete,
}: {
  routine: RoutineWithRuns;
  meta: string;
  computer?: { name: string; offline?: boolean } | null;
  status: string;
  unread?: boolean;
  onOpen: () => void;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onRunNow: () => void;
  onOpenChat: (chatKey: string) => void;
  onMarkRead?: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const chat = routineChat(routine);
  const heartbeat = isHeartbeat(routine);
  const problem = routineProblem(routine);
  const waiting = routine.flow ? routine.runs.filter((run) => needsAnswer(run)).length : 0;
  const entries: MenuEntry[] = [
    routine.enabled
      ? { key: "pause", label: "Pause", icon: PauseCircleIcon, onSelect: () => onToggle(false) }
      : { key: "resume", label: "Resume", icon: PlayCircleIcon, onSelect: () => onToggle(true) },
    ...(canEditRoutine(routine) ? [{ key: "edit", label: "Edit", icon: PencilEdit02Icon, onSelect: onEdit }] : []),
    ...(canRunNow(routine) ? [{ key: "run", label: "Run now", icon: PlayIcon, onSelect: onRunNow }] : []),
    ...(chat ? [{ key: "chat", label: heartbeat ? "Open Chat" : "Open last Chat", icon: BubbleChatIcon, onSelect: () => onOpenChat(chat) }] : []),
    ...(unread && onMarkRead ? [{ key: "read", label: "Mark as read", icon: Tick02Icon, onSelect: onMarkRead }] : []),
    { key: "delete", label: "Delete", icon: Delete02Icon, danger: true, onSelect: () => setConfirming(true) },
  ];

  return (
    <div data-routine-row={routine.id} data-paused={!routine.enabled || undefined}>
      <div className="flex min-h-14 items-stretch gap-3 pr-4 transition-colors duration-fast has-[[data-routine-open]:hover]:bg-hover">
        <button
          type="button"
          data-routine-open
          onClick={onOpen}
          className="flex min-w-0 flex-1 items-center gap-3 py-2 pl-4 text-left focus-visible:bg-hover focus-visible:-outline-offset-2"
        >
          <RoutineTile routine={routine} />
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={`truncate text-13 font-medium ${routine.enabled ? "text-ink" : "text-ink-2"}`}>{routine.name}</span>
              {routine.flow && (
                <span data-routine-flow-chip className="shrink-0 rounded-chip bg-field px-1.5 py-0.5 text-10 font-medium text-ink-2">
                  Flow
                </span>
              )}
              {unread && <span role="img" aria-label="Unread Runs" data-routine-unread className="size-2 shrink-0 rounded-full bg-accent" />}
            </span>
            <span data-routine-meta className="flex min-w-0 items-center gap-1 text-12 text-ink-3">
              {computer && (
                <span data-routine-computer className="flex max-w-[45%] shrink-0 items-center gap-1">
                  <Icon icon={LaptopIcon} size={12} className="shrink-0" />
                  <span className="truncate">{computer.offline ? `${computer.name}, offline` : computer.name}</span>
                  <span aria-hidden>·</span>
                </span>
              )}
              <span className="truncate">{meta}</span>
            </span>
            {problem && (
              <Tooltip label={problem} side="bottom" wrap asChild>
                <span data-routine-problem className="truncate text-12 text-red-ink">
                  {problem}
                </span>
              </Tooltip>
            )}
          </span>
          {waiting > 0 ? (
            <span data-routine-status data-routine-waiting className={`${STATUS} flex items-center justify-end gap-1 font-medium text-orange-ink`}>
              <HugeiconsIcon icon={PauseCircleIcon} size={14} strokeWidth={1.8} color="currentColor" />
              {waiting === 1 ? "Waiting for you" : `${waiting} waiting for you`}
            </span>
          ) : (
            <span data-routine-status className={`${STATUS} ${routine.enabled ? "text-ink-2" : "text-ink-3"}`}>
              {routine.flow?.revision === 0 ? "Not published" : status}
            </span>
          )}
        </button>
        <span className="flex shrink-0 items-center">
          <RoutineMenu routine={routine} entries={entries} />
        </span>
      </div>
      {confirming && (
        <DeleteQuestion
          routine={routine}
          className="px-4 pb-3"
          onCancel={() => setConfirming(false)}
          onDelete={() => {
            setConfirming(false);
            onDelete();
          }}
        />
      )}
    </div>
  );
}
