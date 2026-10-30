import type { IconSvgElement } from "@hugeicons/react";
import { Icon } from "./Icon";
import { radioKeys } from "./Segmented";

export type TabOption<T extends string> = {
  value: T;
  label: string;
  icon?: IconSvgElement;
  count?: number;
  disabled?: boolean;
  /** The id of the tabpanel this tab shows (aria-controls). */
  controls?: string;
};

/**
 * A panel's tab strip: 28px tabs, 8px corners, 12 medium with no weight change; ink-2 at rest, hover fill and ink,
 * the selected tab hover-2 and ink. One Tab stop: Left/Right, Home and End move and pick. Each tab carries
 * `data-tab` and, with `dataKey`, `data-<dataKey>` set to its value; give the panel `role="tabpanel"` and the id in
 * `controls`.
 */
export function Tabs<T extends string>({
  label,
  value,
  options,
  onChange,
  dataKey,
  className = "",
}: {
  label: string;
  value: T;
  options: ReadonlyArray<TabOption<T>>;
  onChange: (value: T) => void;
  dataKey?: string;
  className?: string;
}) {
  const focusable = options.find((option) => option.value === value && !option.disabled)?.value ?? options.find((option) => !option.disabled)?.value;
  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={radioKeys({ role: "tab", axis: "horizontal" })}
      className={`flex min-w-0 items-center gap-0.5 ${className}`}
    >
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={option.controls}
            tabIndex={option.value === focusable ? 0 : -1}
            data-tab={option.value}
            {...(dataKey ? { [`data-${dataKey}`]: option.value } : {})}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={`flex h-7 shrink-0 items-center gap-1.5 rounded-control px-2.5 text-12 font-medium whitespace-nowrap transition-colors active:bg-hover-2 disabled:opacity-40 ${
              on ? "bg-hover-2 text-ink" : "text-ink-2 enabled:hover:bg-hover enabled:hover:text-ink"
            }`}
          >
            {option.icon && <Icon icon={option.icon} size={14} />}
            {option.label}
            {option.count !== undefined && <span className="tabular-nums text-ink-3">{option.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
