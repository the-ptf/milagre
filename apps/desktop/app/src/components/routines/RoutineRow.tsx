import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  BubbleChatIcon,
  Clock01Icon,
  Comment01Icon,
  Delete02Icon,
  Flag02Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  PlayIcon,
  Pulse01Icon,
  Tag01Icon,
  UserCheck01Icon,
  WebhookIcon,
} from "@hugeicons/core-free-icons";
import type { Routine } from "@milagre/shared/model";
import { canRunNow } from "@milagre/shared/routines";
import GlideMenu from "../primitives/GlideMenu";
import { Switch } from "../primitives/Switch";
import { useDismiss } from "../../lib/use-dismiss";
import { isHeartbeat, type RoutineWithRuns } from "../../lib/routines";

type HugeIconData = typeof Pulse01Icon;
const MENU_WIDTH = 200;
const outlineButton = "rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-hover";
const removeButton = "rounded-lg border border-red/30 bg-surface px-3 py-1.5 text-[12.5px] font-medium text-red transition-colors hover:bg-red-tint";

/** The row's tile: a pulse for a heartbeat, else what starts it. */
function routineIcon(routine: Routine): HugeIconData {
  if (isHeartbeat(routine)) return Pulse01Icon;
  const { trigger } = routine;
  if (trigger.kind === "webhook") return WebhookIcon;
  if (trigger.kind === "schedule") return Clock01Icon;
  switch (trigger.event) {
    case "assigned":
      return UserCheck01Icon;
    case "state":
      return Flag02Icon;
    case "comment":
      return Comment01Icon;
    default:
      return Tag01Icon;
  }
}

/** The Chat the row's Open action goes to: a heartbeat's own, or the newest Run's. */
function routineChat(routine: RoutineWithRuns): string | undefined {
  return routine.target.kind === "chat" ? routine.target.chatId : routine.runs.find((run) => run.chatId)?.chatId;
}

type MenuEntry = { key: string; label: string; icon: HugeIconData; danger?: boolean; onSelect: () => void };

/** One Routine: tile, name and meta, then its status, its switch and a ⋯ menu (Edit, Run now, Open Chat, Delete). */
export function RoutineRow({
  routine,
  meta,
  status,
  onToggle,
  onEdit,
  onRunNow,
  onOpenChat,
  onDelete,
}: {
  routine: RoutineWithRuns;
  meta: string;
  status: string;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onRunNow: () => void;
  onOpenChat: (chatKey: string) => void;
  onDelete: () => void;
}) {
  const [menu, setMenu] = useState<{ top: number; left: number } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const chat = routineChat(routine);
  const heartbeat = isHeartbeat(routine);
  const problem = routine.pausedReason && !routine.enabled ? routine.pausedReason : routine.lastError;

  const close = (refocus = true) => {
    setMenu(null);
    if (refocus) buttonRef.current?.focus();
  };
  useDismiss(
    menu !== null,
    () => close(false),
    (target) => !!(menuRef.current?.contains(target) || buttonRef.current?.contains(target)),
  );
  const open = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMenu({ top: rect.bottom + 6, left: Math.max(12, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 12)) });
    requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>("[data-menu-row]")?.focus());
  };
  const pick = (action: () => void) => () => {
    close(false);
    action();
  };
  const entries: MenuEntry[] = [
    { key: "edit", label: "Edit", icon: PencilEdit02Icon, onSelect: pick(onEdit) },
    ...(canRunNow(routine) ? [{ key: "run", label: "Run now", icon: PlayIcon, onSelect: pick(onRunNow) }] : []),
    ...(chat ? [{ key: "chat", label: heartbeat ? "Open Chat" : "Open last Chat", icon: BubbleChatIcon, onSelect: pick(() => onOpenChat(chat)) }] : []),
    { key: "delete", label: "Delete", icon: Delete02Icon, danger: true, onSelect: pick(() => setConfirming(true)) },
  ];
  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const rows = [...(menuRef.current?.querySelectorAll<HTMLElement>("[data-menu-row]") ?? [])];
    const index = rows.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      rows[(index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
    } else if (event.key === "Escape") {
      // Consumed here, so Escape doesn't also leave the Routines page.
      event.preventDefault();
      close();
    } else if (event.key === "Tab") {
      event.preventDefault();
    }
  };

  return (
    <div data-routine-row={routine.id} data-paused={!routine.enabled || undefined}>
      <div className="flex min-h-16 items-center gap-3 px-4 py-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-field">
          <HugeiconsIcon
            icon={routineIcon(routine)}
            size={16}
            strokeWidth={1.8}
            color="currentColor"
            className={routine.enabled ? "text-ink-2" : "text-ink-3"}
          />
        </span>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className={`truncate text-[13.5px] font-medium ${routine.enabled ? "text-ink" : "text-ink-2"}`}>{routine.name}</span>
          <span data-routine-meta className="truncate text-[12px] text-ink-3">
            {meta}
          </span>
          {problem && (
            <span data-routine-problem className="truncate text-[12px] text-red" title={problem}>
              {problem}
            </span>
          )}
        </span>
        <span data-routine-status className={`shrink-0 text-right text-[12px] ${routine.enabled ? "text-ink-2" : "text-ink-3"}`}>
          {status}
        </span>
        <Switch label={`${routine.name} on`} checked={routine.enabled} onChange={onToggle} />
        <button
          ref={buttonRef}
          type="button"
          aria-label={`Actions for ${routine.name}`}
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          data-routine-more
          onClick={() => (menu ? close(false) : open())}
          className={`flex size-7 shrink-0 items-center justify-center rounded-[8px] text-ink-3 transition-colors hover:bg-hover-2 hover:text-ink ${menu ? "bg-hover-2 text-ink" : ""}`}
        >
          <HugeiconsIcon icon={MoreHorizontalIcon} size={16} strokeWidth={1.8} color="currentColor" />
        </button>
      </div>
      {confirming && (
        <div data-routine-delete-question className="flex min-h-11 items-center gap-2 px-4 pb-3">
          <span className="min-w-0 flex-1 text-[12px] text-ink">Delete {routine.name}? Its Chats stay.</span>
          <button type="button" className={outlineButton} onClick={() => setConfirming(false)}>
            Cancel
          </button>
          <button
            type="button"
            data-routine-delete-confirm
            className={removeButton}
            onClick={() => {
              setConfirming(false);
              onDelete();
            }}
          >
            Delete
          </button>
        </div>
      )}
      {menu &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={`Actions for ${routine.name}`}
            data-routine-menu
            onKeyDown={moveFocus}
            className="fixed z-[70] rounded-[12px] bg-surface p-1.5 shadow-overlay"
            style={{
              top: menu.top,
              left: menu.left,
              width: MENU_WIDTH,
              animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both",
              transformOrigin: "top right",
            }}
          >
            <GlideMenu className="flex flex-col gap-px" rowSelector="[data-menu-row]" highlightClassName="inset-x-0 rounded-[8px] bg-hover-2">
              {entries.map((entry) => (
                <button
                  key={entry.key}
                  data-menu-row
                  data-routine-action={entry.key}
                  role="menuitem"
                  type="button"
                  onClick={entry.onSelect}
                  className={`relative z-10 flex h-8 w-full items-center gap-2 rounded-[8px] px-2 text-left outline-none focus-visible:bg-hover-2 ${entry.danger ? "text-red" : "text-ink"}`}
                >
                  <span className={`flex size-5 shrink-0 items-center justify-center ${entry.danger ? "text-red" : "text-ink-2"}`}>
                    <HugeiconsIcon icon={entry.icon} size={16} strokeWidth={1.8} color="currentColor" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px]">{entry.label}</span>
                </button>
              ))}
            </GlideMenu>
          </div>,
          document.body,
        )}
    </div>
  );
}
