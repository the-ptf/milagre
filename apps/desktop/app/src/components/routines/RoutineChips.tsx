import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { useDismiss } from "../../lib/use-dismiss";
import { Icon } from "../primitives/Icon";

type HugeIconData = typeof ArrowDown01Icon;

const chipShape = "inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full px-2.5 text-12 font-medium";
const GAP = 6;
const INSET = 12;

/** A Routine's setting as a pill on the field fill: its icon and words ("Every hour", "New Worktree in payments-api"). */
export function Chip({ icon, children, ...data }: { icon?: HugeIconData; children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  return (
    <span className={`${chipShape} bg-field text-ink-2`} {...data}>
      {icon && <Icon icon={icon} size={14} className="shrink-0" />}
      <span className="truncate">{children}</span>
    </span>
  );
}

/**
 * A chip that opens a popover anchored under it (the Routine form's Schedule and Where chips). The popover carries
 * data-popover-host, so a Select inside it opens its list into the popover and a press there stays inside. It closes
 * through useDismiss, and on Escape, which it consumes and which returns focus to the chip.
 */
export function PopoverChip({
  label,
  icon,
  text,
  width = 320,
  invalid = false,
  children,
}: {
  label: string;
  icon?: HugeIconData;
  text: string;
  width?: number;
  invalid?: boolean;
  children: ReactNode;
}) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const open = position !== null;
  const place = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({ left: Math.max(INSET, Math.min(rect.left, window.innerWidth - width - INSET)), top: rect.bottom + GAP });
  };
  const close = (refocus = true) => {
    setPosition(null);
    if (refocus) trigger.current?.focus();
  };
  useDismiss(
    open,
    () => close(false),
    (target) => !!(panel.current?.contains(target) || trigger.current?.contains(target)),
    place,
  );

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-routine-chip-trigger={label}
        onClick={() => (open ? close(false) : place())}
        className={`${chipShape} pr-2 transition-colors duration-fast hover:bg-hover hover:text-ink ${open ? "bg-hover text-ink" : "bg-field text-ink-2"} ${invalid ? "ring-1 ring-red" : ""}`}
      >
        {icon && <Icon icon={icon} size={14} className="shrink-0" />}
        <span className="truncate">{text}</span>
        <Icon icon={ArrowDown01Icon} size={12} className="shrink-0 text-ink-3" />
      </button>
      {position &&
        createPortal(
          <div
            ref={panel}
            role="dialog"
            aria-label={label}
            data-popover-host
            data-routine-chip-popover={label}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || event.defaultPrevented) return;
              event.preventDefault();
              close();
            }}
            // No transform: a Select's list opens inside this panel with position: fixed.
            className="fixed z-[60] space-y-3 rounded-card bg-surface p-3 shadow-raised"
            style={{ left: position.left, top: position.top, width, animation: "fade-in var(--duration-fast) var(--ease-enter) both" }}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}

/** The segmented control moved to primitives; Routines' imports keep working. */
export { Segmented } from "../primitives/Segmented";
