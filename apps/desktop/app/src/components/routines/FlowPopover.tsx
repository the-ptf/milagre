import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { useDismiss } from "../../lib/use-dismiss";
import type { HugeIconData } from "./flow-look";

const GAP = 6;
const INSET = 12;
/** Below this much room under its trigger, a panel opens above it when there is more room there. */
const ROOM = 260;

type Position = { left: number; top?: number; bottom?: number; maxHeight: number };

/**
 * An anchored panel's state: a trigger ref, a panel ref, where the panel sits (under its trigger, or above it when the
 * window has no room below) and open/close. It closes through useDismiss and follows its trigger through scrolls.
 */
export function usePopover(width: number, align: "start" | "end" = "start") {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const place = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const wanted = align === "end" ? rect.right - width : rect.left;
    const left = Math.max(INSET, Math.min(wanted, window.innerWidth - width - INSET));
    const below = window.innerHeight - rect.bottom - GAP - INSET;
    const above = rect.top - GAP - INSET;
    setPosition(
      below >= ROOM || below >= above
        ? { left, top: rect.bottom + GAP, maxHeight: below }
        : { left, bottom: window.innerHeight - rect.top + GAP, maxHeight: above },
    );
  };
  const close = (refocus = true) => {
    setPosition(null);
    if (refocus) trigger.current?.focus();
  };
  useDismiss(
    position !== null,
    () => close(false),
    (target) => !!(panel.current?.contains(target) || trigger.current?.contains(target)),
    place,
  );
  return { trigger, panel, position, open: position !== null, show: place, close, toggle: () => (position ? close(false) : place()) };
}

export type PopoverState = ReturnType<typeof usePopover>;

/**
 * The panel of a `usePopover`, portaled to the body: a menu (`role="menu"`, arrow keys move between its rows) or a
 * dialog. Escape closes it and returns focus to its trigger; its first row or button takes focus as it opens.
 */
export function Popover({
  state,
  label,
  width,
  role = "dialog",
  className = "",
  children,
  ...data
}: {
  state: PopoverState;
  label: string;
  width: number;
  role?: "dialog" | "menu";
  className?: string;
  children: ReactNode;
} & Record<`data-${string}`, string | boolean | undefined>) {
  const { position, panel } = state;
  const open = position !== null;
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() =>
      (panel.current?.querySelector<HTMLElement>("[data-menu-row], textarea, input, button") ?? panel.current)?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [open]);
  if (!position) return null;
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      state.close();
      return;
    }
    if (role !== "menu" || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    event.preventDefault();
    const rows = [...(panel.current?.querySelectorAll<HTMLElement>("[data-menu-row]:not(:disabled)") ?? [])];
    const index = rows.indexOf(document.activeElement as HTMLElement);
    rows[(index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
  };
  return createPortal(
    <div
      ref={panel}
      role={role}
      aria-label={label}
      tabIndex={-1}
      data-popover-host
      onKeyDown={onKeyDown}
      className={`fixed z-[70] flex flex-col overflow-hidden rounded-card bg-surface shadow-raised outline-none ${className}`}
      style={{
        left: position.left,
        top: position.top,
        bottom: position.bottom,
        width,
        maxHeight: position.maxHeight,
        animation: "fade-in 120ms ease-out both",
      }}
      {...data}
    >
      {children}
    </div>,
    document.body,
  );
}

/** One row of a menu: its icon (in a tile when `tile` is given), its name and, below, what it does. */
export function MenuRow({
  icon,
  tile,
  label,
  description,
  danger = false,
  disabled = false,
  onSelect,
  ...data
}: {
  icon: HugeIconData;
  tile?: string;
  label: string;
  description?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
} & Record<`data-${string}`, string | boolean | undefined>) {
  return (
    <button
      type="button"
      role="menuitem"
      data-menu-row
      disabled={disabled}
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-control px-2 text-left outline-none transition-colors hover:bg-hover focus-visible:bg-hover-2 disabled:opacity-40 ${
        description ? "min-h-12 py-1.5" : "h-8"
      } ${danger ? "text-red-ink" : "text-ink"}`}
      {...data}
    >
      {tile ? (
        <span className={`flex size-8 shrink-0 items-center justify-center rounded-control ${tile}`}>
          <HugeiconsIcon icon={icon} size={16} strokeWidth={1.8} color="currentColor" />
        </span>
      ) : (
        <span className={`flex size-5 shrink-0 items-center justify-center ${danger ? "text-red-ink" : "text-ink-2"}`}>
          <HugeiconsIcon icon={icon} size={16} strokeWidth={1.8} color="currentColor" />
        </span>
      )}
      <span className="grid min-w-0 flex-1">
        <span className="truncate text-13 font-medium">{label}</span>
        {description && <span className="truncate text-12 text-ink-3">{description}</span>}
      </span>
    </button>
  );
}
