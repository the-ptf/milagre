import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { useDismiss } from "../../lib/use-dismiss";

type HugeIconData = typeof ArrowDown01Icon;

const chipShape = "inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium";
const GAP = 6;
const INSET = 12;

/** A Routine's setting as a pill on the field fill: its icon and words ("Every hour", "New Worktree in payments-api"). */
export function Chip({ icon, children, ...data }: { icon?: HugeIconData; children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  return (
    <span className={`${chipShape} bg-field text-ink-2`} {...data}>
      {icon && <HugeiconsIcon icon={icon} size={14} strokeWidth={1.8} color="currentColor" className="shrink-0" />}
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
        className={`${chipShape} pr-2 transition-colors hover:bg-hover hover:text-ink ${open ? "bg-hover text-ink" : "bg-field text-ink-2"} ${invalid ? "ring-1 ring-red" : ""}`}
      >
        {icon && <HugeiconsIcon icon={icon} size={14} strokeWidth={1.8} color="currentColor" className="shrink-0" />}
        <span className="truncate">{text}</span>
        <HugeiconsIcon icon={ArrowDown01Icon} size={13} strokeWidth={1.8} color="currentColor" className="shrink-0 text-ink-3" />
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
            className="fixed z-[60] space-y-3 rounded-[12px] border border-line bg-surface p-3 shadow-overlay"
            style={{ left: position.left, top: position.top, width, animation: "fade-in 120ms ease-out both" }}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}

/** A segmented control: one pressed option on the field fill, each with an optional icon. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className = "",
  size = "small",
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; icon?: HugeIconData; count?: number; disabled?: boolean }>;
  onChange: (value: T) => void;
  className?: string;
  size?: "small" | "large";
}) {
  return (
    <div role="radiogroup" aria-label={label} className={`flex gap-0.5 rounded-lg bg-field p-0.5 ${className}`}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            data-segment={option.value}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-[6px] font-medium whitespace-nowrap transition-colors disabled:opacity-40 ${
              size === "large" ? "h-[30px] px-3 text-[13px]" : "h-6 px-2.5 text-[12px]"
            } ${on ? "bg-surface text-ink shadow-[0_0_0_1px_var(--line-strong)]" : "text-ink-2 hover:text-ink"}`}
          >
            {option.icon && <HugeiconsIcon icon={option.icon} size={14} strokeWidth={1.8} color="currentColor" />}
            {option.label}
            {option.count !== undefined && <span className={`tabular-nums ${on ? "text-ink-2" : "text-ink-3"}`}>{option.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
