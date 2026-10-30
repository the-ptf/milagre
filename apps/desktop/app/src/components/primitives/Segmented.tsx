import type { IconSvgElement } from "@hugeicons/react";
import { Icon } from "./Icon";

/**
 * A segmented control: one pressed option raised on the field fill, each with an optional icon and count. 28px tall
 * (`small`, 24px segments) or 32px (`large`, 28px segments). The same API as routines' Segmented, which moves here.
 */
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
  options: ReadonlyArray<{ value: T; label: string; icon?: IconSvgElement; count?: number; disabled?: boolean }>;
  onChange: (value: T) => void;
  className?: string;
  size?: "small" | "large";
}) {
  return (
    <div role="radiogroup" aria-label={label} className={`flex gap-0.5 rounded-control bg-field p-0.5 ${className}`}>
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
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-chip font-medium whitespace-nowrap transition-colors duration-fast disabled:opacity-40 ${
              size === "large" ? "h-7 px-3 text-13" : "h-6 px-2.5 text-12"
            } ${on ? "bg-surface text-ink shadow-card" : "text-ink-2 enabled:hover:text-ink"}`}
          >
            {option.icon && <Icon icon={option.icon} size={14} />}
            {option.label}
            {option.count !== undefined && <span className={`tabular-nums ${on ? "text-ink-2" : "text-ink-3"}`}>{option.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
