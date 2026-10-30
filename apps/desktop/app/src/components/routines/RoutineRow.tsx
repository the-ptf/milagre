import { useRef, useState } from "react";
import { BubbleChatIcon, Delete02Icon, LaptopIcon, MoreHorizontalIcon, PencilEdit02Icon, PlayIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import type { Routine } from "@milagre/shared/model";
import { canEditRoutine, canRunNow } from "@milagre/shared/routines";
import { Button, IconButton } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import { MenuRow, Popover } from "../primitives/Popover";
import { Switch } from "../primitives/Switch";
import Tooltip from "../primitives/Tooltip";
import { isHeartbeat, routineDeleteQuestion, type RoutineWithRuns } from "../../lib/routines";
import { routineIcon } from "./routine-icon";

type HugeIconData = typeof PlayIcon;
const MENU_WIDTH = 200;

/** What is wrong with the Routine, in red under its meta: why it paused itself while off, else its latest error. */
export function routineProblem(routine: Routine): string | undefined {
  return routine.pausedReason && !routine.enabled ? routine.pausedReason : routine.lastError;
}

/** The Chat the row's Open action goes to: a heartbeat's own, or the newest Run's. */
function routineChat(routine: RoutineWithRuns): string | undefined {
  return routine.target.kind === "chat" ? routine.target.chatId : routine.runs.find((run) => run.chatId)?.chatId;
}

type MenuEntry = { key: string; label: string; icon: HugeIconData; danger?: boolean; onSelect: () => void };

/** A Routine's icon tile, dimmed while it is switched off. `large` is the Routine page's header. */
function RoutineTile({ routine, large = false }: { routine: Routine; large?: boolean }) {
  return (
    <span className={`flex shrink-0 items-center justify-center bg-field ${large ? "size-10 rounded-card" : "size-8 rounded-control"}`}>
      <Icon icon={routineIcon(routine)} size={large ? 18 : 16} className={routine.enabled ? "text-ink-2" : "text-ink-3"} />
    </span>
  );
}

/** A Routine's ⋯ button and the menu it opens with `entries`; picking one closes the menu first. */
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

/** The delete confirmation under a Routine: what deleting does, Cancel and Delete. */
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

/**
 * One Routine: tile, name (with a dot while a hidden Run Chat of it is unread) and meta, then its status, its switch and a
 * ⋯ menu (Edit, Run now, Open Chat, Mark as read while unread, Delete). Clicking the row opens the Routine's page.
 */
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
  /** Another computer's Routine: its name leads the meta with the laptop mark, as a Chat row's does. */
  computer?: { name: string; offline?: boolean } | null;
  status: string;
  /** A Run Chat of this Routine, out of the sidebar, has a result nobody opened. */
  unread?: boolean;
  /** Opens the Routine's page, with its Runs. */
  onOpen: () => void;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onRunNow: () => void;
  onOpenChat: (chatKey: string) => void;
  /** Marks the Routine's unread Run Chats read, clearing its dot. */
  onMarkRead?: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const chat = routineChat(routine);
  const heartbeat = isHeartbeat(routine);
  const problem = routineProblem(routine);
  const entries: MenuEntry[] = [
    ...(canEditRoutine(routine) ? [{ key: "edit", label: "Edit", icon: PencilEdit02Icon, onSelect: onEdit }] : []),
    ...(canRunNow(routine) ? [{ key: "run", label: "Run now", icon: PlayIcon, onSelect: onRunNow }] : []),
    ...(chat ? [{ key: "chat", label: heartbeat ? "Open Chat" : "Open last Chat", icon: BubbleChatIcon, onSelect: () => onOpenChat(chat) }] : []),
    ...(unread && onMarkRead ? [{ key: "read", label: "Mark as read", icon: Tick02Icon, onSelect: onMarkRead }] : []),
    { key: "delete", label: "Delete", icon: Delete02Icon, danger: true, onSelect: () => setConfirming(true) },
  ];

  return (
    <div data-routine-row={routine.id} data-paused={!routine.enabled || undefined}>
      {/* The tile, name, meta and status open the page; the switch and the ⋯ menu beside them do only their own thing. */}
      <div className="flex min-h-16 items-stretch gap-3 pr-4 transition-colors duration-fast has-[[data-routine-open]:hover]:bg-hover">
        <button
          type="button"
          data-routine-open
          onClick={onOpen}
          className="flex min-w-0 flex-1 items-center gap-3 py-3 pl-4 text-left focus-visible:bg-hover focus-visible:-outline-offset-2"
        >
          <RoutineTile routine={routine} />
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={`truncate text-13 font-medium ${routine.enabled ? "text-ink" : "text-ink-2"}`}>{routine.name}</span>
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
          <span data-routine-status className={`shrink-0 text-right text-12 ${routine.enabled ? "text-ink-2" : "text-ink-3"}`}>
            {status}
          </span>
        </button>
        <span className="flex shrink-0 items-center gap-3">
          <Switch label={`${routine.name} on`} checked={routine.enabled} onChange={onToggle} />
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
