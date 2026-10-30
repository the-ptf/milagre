import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { Search01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { FieldGroup } from "./Field";
import { Icon } from "./Icon";
import { menuRowClass } from "./Popover";
import { ScrollArea } from "./ScrollArea";

/* Popover picker shared by the model, permission, and branch selectors and by Select: optional title with an
 * optional action beside it (a refresh button), optional header slot (e.g. provider tabs), optional search, and a
 * scrolling list of PickerRows, which take MenuRow's metrics and states. */
export function PickerPanel({
  title,
  titleAction,
  query,
  onQueryChange,
  placeholder,
  searchPlacement = "top",
  emptyLabel,
  isEmpty,
  header,
  className = "",
  style,
  onKeyDown,
  children,
}: {
  title?: string;
  titleAction?: ReactNode;
  query?: string;
  onQueryChange?: (query: string) => void;
  placeholder?: string;
  searchPlacement?: "top" | "bottom";
  emptyLabel?: string;
  isEmpty?: boolean;
  header?: ReactNode;
  className?: string;
  style?: CSSProperties;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-picker-row]:not(:disabled)")];
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    const searching = event.target instanceof HTMLInputElement;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      const next = index < 0 ? (event.key === "ArrowDown" ? 0 : rows.length - 1) : (index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
      rows[next]?.focus({ preventScroll: true });
      rows[next]?.scrollIntoView({ block: "nearest" });
    } else if (!searching && (event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      event.stopPropagation();
      const row = rows[event.key === "Home" ? 0 : rows.length - 1];
      row?.focus({ preventScroll: true });
      row?.scrollIntoView({ block: "nearest" });
    } else if ((searching || index >= 0) && event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      rows[Math.max(0, index)]?.click();
    } else {
      onKeyDown?.(event);
    }
  }

  const search = onQueryChange && (
    <FieldGroup
      className="my-2 shrink-0"
      leading={<Icon icon={Search01Icon} size={14} className="shrink-0 text-ink-3" />}
      value={query}
      onChange={(event) => onQueryChange(event.target.value)}
      placeholder={placeholder}
      autoFocus
    />
  );

  return (
    <div
      data-picker-panel
      onKeyDown={handleKeyDown}
      className={`z-20 flex flex-col rounded-card bg-surface p-1.5 shadow-raised ${className}`}
      style={{ animation: "pop-in var(--duration-base) var(--ease-enter) backwards", ...style }}
    >
      {title && (
        <div className="flex shrink-0 items-center justify-between gap-2 px-2 pb-2 pt-1">
          <span className="text-13 font-semibold text-ink">{title}</span>
          {titleAction}
        </div>
      )}
      {header}
      {searchPlacement === "top" && search}
      <ScrollArea className="grid max-h-64 grid-cols-1 content-start gap-px">
        {children}
        {isEmpty && <div className="px-2 py-5 text-center text-12 text-ink-3">{emptyLabel}</div>}
      </ScrollArea>
      {searchPlacement === "bottom" && search}
    </div>
  );
}

/**
 * A picker choice with MenuRow's metrics: 32px (48 with a description), 13 medium label, 11 ink-3 description,
 * trailing and meta. Hover and keyboard focus fill hover-2 (focus adds the inset ring); the selected row shows only a
 * 14px tick. `option` makes it a listbox option (aria-selected); otherwise a selected row is aria-current.
 */
export function PickerRow({
  icon,
  label,
  description,
  meta,
  trailing,
  selected,
  onClick,
  option = false,
  disabled = false,
  wrapLabel = false,
  labelStyle,
  ...data
}: {
  icon?: ReactNode;
  label: string;
  description?: string;
  /** A short fact in a chip beside the label: a model's context window. */
  meta?: string;
  /** Right-aligned text before the check: the computer a Project lives on. */
  trailing?: string;
  selected: boolean;
  onClick: () => void;
  option?: boolean;
  disabled?: boolean;
  wrapLabel?: boolean;
  /** Draws the label in its own font, e.g. a font menu row. */
  labelStyle?: CSSProperties;
} & { [key: `data-${string}`]: string | boolean | undefined }) {
  const stacked = !!description || wrapLabel;
  return (
    <button
      type="button"
      {...data}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      data-picker-row
      role={option ? "option" : undefined}
      aria-selected={option ? selected : undefined}
      aria-current={!option && selected ? true : undefined}
      onClick={onClick}
      className={`${menuRowClass({ tall: !!description, wrap: wrapLabel })} z-10`}
    >
      {icon && <span className="flex min-w-5 shrink-0 items-center justify-center text-ink-2">{icon}</span>}
      <span className={`flex min-w-0 flex-1 ${stacked ? "flex-col" : "items-center gap-1.5"}`}>
        <span className={`flex min-w-0 items-center gap-1.5 ${stacked ? "w-full" : ""}`}>
          <strong style={labelStyle} className={`font-medium ${wrapLabel ? "min-w-0 whitespace-normal break-words" : "min-w-0 truncate"}`}>
            {label}
          </strong>
          {meta && (
            <span data-picker-meta className="shrink-0 rounded-inline bg-field px-1 text-10 font-medium tabular-nums text-ink-3">
              {meta}
            </span>
          )}
        </span>
        {description && <span className="w-full truncate text-11 font-normal text-ink-3">{description}</span>}
      </span>
      {trailing && <span className="max-w-[40%] shrink-0 truncate text-11 font-normal text-ink-3">{trailing}</span>}
      {selected && <Icon icon={Tick02Icon} size={14} className="shrink-0" />}
    </button>
  );
}
