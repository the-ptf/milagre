import {
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { IconSvgElement } from "@hugeicons/react";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { useDismiss } from "../../lib/use-dismiss";
import { Icon } from "./Icon";
import { ScrollArea } from "./ScrollArea";
import { SectionLabel } from "./SectionLabel";
import { rovingIndex } from "./roving";
import { layerHost } from "./Tooltip";

const GAP = 6;
const INSET = 8;
const MAX_HEIGHT = 420;
const ROWS = "[data-menu-row]:not(:disabled)";

type Point = { x: number; y: number };

/**
 * A floating panel anchored to a trigger (`anchor` ref: it opens under it, or over it when there's more room above,
 * and follows it on scroll) or to a point (`anchor={{ x, y }}`, a context menu: it closes on scroll). Mount it only
 * while open. `rounded-card bg-surface p-1.5 shadow-raised`, at least 192px wide, at most 420px tall (the rest
 * scrolls), portalled into an open dialog or `[data-popover-host]` around the trigger. A press outside, the window
 * losing focus, Esc and Tab call `onClose`; with `role="menu"` (the default) the arrow keys, Home and End move between
 * its `[data-menu-row]` rows (MenuRow) and the first row takes focus. Focus goes back to what had it when it closes
 * from inside.
 */
export function Popover({
  anchor,
  align = "end",
  width,
  role = "menu",
  label,
  onClose,
  className = "",
  children,
  ...data
}: {
  anchor: RefObject<HTMLElement | null> | Point;
  /** Which trigger edge it lines up with: `end` (right edges, the ⋯ menus) or `start`. A point always opens from it. */
  align?: "start" | "end";
  /** A fixed width; otherwise it fits its rows, from 192px. */
  width?: number;
  role?: "menu" | "dialog" | "listbox";
  label?: string;
  onClose: () => void;
  className?: string;
  children: ReactNode;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
  const panel = useRef<HTMLDivElement>(null);
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  const trigger = "current" in anchor ? anchor.current : null;
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number } | null>(null);

  function place() {
    const box =
      trigger?.getBoundingClientRect() ??
      (() => {
        const { x, y } = anchor as Point;
        return { top: y, bottom: y, left: x, right: x };
      })();
    const own = panel.current;
    if (!own) return;
    const ownWidth = own.offsetWidth;
    const start = trigger && align === "end" ? box.right - ownWidth : box.left;
    const left = Math.max(INSET, Math.min(start, window.innerWidth - ownWidth - INSET));
    const below = window.innerHeight - box.bottom - GAP - INSET;
    const above = box.top - GAP - INSET;
    const natural = Math.min(MAX_HEIGHT, own.scrollHeight);
    setPosition(
      natural <= below || below >= above
        ? { left, top: box.bottom + GAP, maxHeight: Math.min(MAX_HEIGHT, below) }
        : { left, bottom: window.innerHeight - box.top + GAP, maxHeight: Math.min(MAX_HEIGHT, above) },
    );
  }

  useLayoutEffect(place, []);
  useLayoutEffect(() => {
    if (role === "menu") panel.current?.querySelector<HTMLElement>(ROWS)?.focus({ preventScroll: true });
  }, []);
  useEffect(
    () => () => {
      const active = document.activeElement;
      if (opener?.isConnected && (!active || active === document.body)) opener.focus({ preventScroll: true });
    },
    [opener],
  );
  useDismiss(true, onClose, (target) => !!(panel.current?.contains(target) || trigger?.contains(target)), trigger ? place : undefined);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" || event.key === "Tab") {
      // Consumed here, so Escape doesn't also close the view behind it.
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (role !== "menu") return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>(ROWS)];
    const row = rows[rovingIndex(event.key, rows.indexOf(document.activeElement as HTMLElement), rows.length, { axis: "vertical" })];
    if (!row) return;
    event.preventDefault();
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: "nearest" });
  }

  return createPortal(
    <div
      ref={panel}
      role={role}
      aria-label={label}
      {...data}
      onKeyDown={onKeyDown}
      className={`fixed z-50 flex min-w-48 flex-col rounded-card bg-surface p-1.5 shadow-raised ${className}`}
      style={{
        left: position?.left ?? 0,
        top: position?.top,
        bottom: position?.bottom,
        width,
        // Placed in a layout effect, so the first paint is already in place.
        maxHeight: position?.maxHeight ?? MAX_HEIGHT,
        animation: "pop-in var(--duration-base) var(--ease-enter) backwards",
        transformOrigin: `${position?.bottom !== undefined ? "bottom" : "top"} ${trigger && align === "end" ? "right" : "left"}`,
      }}
    >
      <ScrollArea className="flex flex-col gap-px">{children}</ScrollArea>
    </div>,
    layerHost(trigger),
  );
}

/**
 * A menu row: 32px (48 with a `subtitle`), 4px corners, 13 medium ink; a 20px leading slot with a 16px ink-2 icon,
 * a `trailing` 11 ink-3 text or ShortcutKeys, and a 14px tick when `checked`. The highlight, for the pointer and the
 * keyboard, is hover-2, and keyboard focus adds the inset accent ring. Mirrors the phone MenuSection item (title,
 * subtitle, systemImage → icon). `role` follows `checked`: menuitemcheckbox, or set menuitemradio / option.
 */
export function MenuRow({
  icon,
  title,
  subtitle,
  trailing,
  checked,
  danger = false,
  role,
  className = "",
  type = "button",
  ref,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title" | "role"> & {
  icon?: IconSvgElement | ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  /** A checkable row: true shows the tick. */
  checked?: boolean;
  danger?: boolean;
  role?: "menuitem" | "menuitemcheckbox" | "menuitemradio" | "option";
  ref?: Ref<HTMLButtonElement>;
}) {
  const kind = role ?? (checked === undefined ? "menuitem" : "menuitemcheckbox");
  return (
    <button
      ref={ref}
      type={type}
      role={kind}
      data-menu-row
      aria-checked={kind === "menuitemcheckbox" || kind === "menuitemradio" ? !!checked : undefined}
      aria-selected={kind === "option" ? !!checked : undefined}
      {...props}
      className={`${menuRowClass({ tall: !!subtitle, danger })} ${className}`}
    >
      {icon !== undefined && (
        <span className={`flex size-5 shrink-0 items-center justify-center ${danger ? "text-red-ink" : "text-ink-2"}`}>
          {isIcon(icon) ? <Icon icon={icon} size={16} /> : icon}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{title}</span>
        {subtitle && <span className="truncate text-12 font-normal text-ink-3">{subtitle}</span>}
      </span>
      {typeof trailing === "string" ? <span className="shrink-0 text-11 font-normal text-ink-3">{trailing}</span> : trailing}
      {checked && <Icon icon={Tick02Icon} size={14} className="shrink-0" />}
    </button>
  );
}

/** A MenuRow's classes, for a row that must be another element (a link). `wrap` lets a one-line row grow for a long label. */
export function menuRowClass({ tall = false, wrap = false, danger = false }: { tall?: boolean; wrap?: boolean; danger?: boolean } = {}) {
  const height = tall ? "min-h-12 py-1.5" : wrap ? "min-h-8 py-1.5" : "h-8";
  return `relative flex w-full shrink-0 items-center gap-2 rounded-inline px-2 text-left text-13 font-medium transition-colors hover:bg-hover-2 focus-visible:bg-hover-2 focus-visible:-outline-offset-2 active:bg-hover-2 disabled:pointer-events-none disabled:opacity-40 ${height} ${danger ? "text-red-ink" : "text-ink"}`;
}

/** A hairline between groups of menu rows. */
export function MenuSeparator() {
  return <div role="separator" className="mx-2 my-1 h-px shrink-0 bg-line" />;
}

/** A group label inside a menu or picker: SectionLabel's menu size, inset to the rows' text. */
export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <SectionLabel variant="menu" as="div" className="shrink-0 px-2 pt-2 pb-1">
      {children}
    </SectionLabel>
  );
}

// A Hugeicons glyph is an array of [tag, attrs] pairs; anything else is a node to render as is.
const isIcon = (icon: unknown): icon is IconSvgElement => Array.isArray(icon) && !isValidElement(icon);
