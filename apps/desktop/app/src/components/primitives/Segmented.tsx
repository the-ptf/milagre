import type { KeyboardEvent } from "react";
import type { IconSvgElement } from "@hugeicons/react";
import { Icon } from "./Icon";
import { rovingIndex } from "./roving";
import Tooltip from "./Tooltip";

const DOTS = { orange: "bg-orange", accent: "bg-accent", green: "bg-green", red: "bg-red" } as const;

/**
 * Roving keys for a group of `role` buttons (radio by default): the arrows move focus to the next enabled one and pick
 * it (a click), Home and End go to the ends; with `columns`, Up/Down move a row in a grid. Put it on the group's
 * onKeyDown and give only the picked button tabIndex 0.
 */
export function radioKeys({ columns = 0, role = "radio", axis = "both" }: { columns?: number; role?: string; axis?: "horizontal" | "both" } = {}) {
  return (event: KeyboardEvent<HTMLElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(`[role="${role}"]:not(:disabled)`)];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const item = index < 0 ? undefined : items[rovingIndex(event.key, index, items.length, { axis, columns })];
    if (!item) return;
    event.preventDefault();
    item.focus();
    item.click();
  };
}

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  icon?: IconSvgElement;
  count?: number;
  disabled?: boolean;
  /** A 6px status dot before the label. */
  dot?: keyof typeof DOTS;
  /** Show only the icon; the label becomes its name and Tooltip. */
  iconOnly?: boolean;
  /** An accessible name that differs from the label. */
  ariaLabel?: string;
};

/**
 * A segmented control: one picked option raised on the field fill (surface and shadow-card; hover-2 in dark, where
 * surface is darker than the track), the rest ink-2. 28px tall (`small`, 24px segments) or 32px (`large`, 28px
 * segments). One Tab stop: the arrow keys, Home and End move the choice. Each segment carries `data-segment` and,
 * with `dataKey`, `data-<dataKey>` set to its value. `value` may be null (nothing picked yet).
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className = "",
  size = "small",
  dataKey,
}: {
  label: string;
  value: T | null;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  className?: string;
  size?: "small" | "large";
  /** Adds data-<dataKey>={value} to each segment, for a test or style hook. */
  dataKey?: string;
}) {
  const focusable = options.find((option) => option.value === value && !option.disabled)?.value ?? options.find((option) => !option.disabled)?.value;
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={radioKeys()} className={`flex gap-0.5 rounded-control bg-field p-0.5 ${className}`}>
      {options.map((option) => {
        const on = option.value === value;
        const segment = (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={option.iconOnly ? (option.ariaLabel ?? option.label) : option.ariaLabel}
            tabIndex={option.value === focusable ? 0 : -1}
            data-segment={option.value}
            {...(dataKey ? { [`data-${dataKey}`]: option.value } : {})}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-chip font-medium whitespace-nowrap transition-colors focus-visible:outline-offset-0 disabled:opacity-40 ${
              size === "large" ? `h-7 text-13 ${option.iconOnly ? "px-2" : "px-3"}` : `h-6 text-12 ${option.iconOnly ? "px-1.5" : "px-2.5"}`
            } ${on ? "bg-surface text-ink shadow-card dark:bg-hover-2" : "text-ink-2 enabled:hover:text-ink"}`}
          >
            {option.dot && <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${DOTS[option.dot]}`} />}
            {option.icon && <Icon icon={option.icon} size={14} />}
            {!option.iconOnly && option.label}
            {option.count !== undefined && <span className={`tabular-nums ${on ? "text-ink-2" : "text-ink-3"}`}>{option.count}</span>}
          </button>
        );
        return option.iconOnly ? (
          <Tooltip key={option.value} label={option.label} asChild>
            {segment}
          </Tooltip>
        ) : (
          segment
        );
      })}
    </div>
  );
}
