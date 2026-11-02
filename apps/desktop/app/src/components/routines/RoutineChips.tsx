import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { IconSvgElement } from "@hugeicons/react";
import { useDismiss } from "../../lib/use-dismiss";
import { Chip as ChipBase } from "../primitives/Chip";

type HugeIconData = IconSvgElement;

const GAP = 6;
const INSET = 12;

/** A Routine's setting as a pill on the field fill: its icon and words ("Every hour", "New Worktree in payments-api"). */
export function Chip({ icon, children, ...data }: { icon?: HugeIconData; children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  return (
    <ChipBase variant="static" icon={icon} className="max-w-full" {...data}>
      <span className="truncate">{children}</span>
    </ChipBase>
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
      <ChipBase
        ref={trigger}
        variant="field"
        icon={icon}
        chevron
        invalid={invalid}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-routine-chip-trigger={label}
        onClick={() => (open ? close(false) : place())}
        className="max-w-full"
      >
        <span className="truncate">{text}</span>
      </ChipBase>
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
