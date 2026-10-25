import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Search01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { ScrollArea } from "./ScrollArea";

/* Popover picker shared by the model, permission, and branch selectors and by Select: optional title with an
 * optional action beside it (a refresh button), optional header slot (e.g. provider tabs), optional search, and a scrolling list. */
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
    <label className="my-2 flex shrink-0 items-center gap-2 rounded-control border border-line px-2.5 py-2 text-ink-3">
      <HugeiconsIcon icon={Search01Icon} size={15} strokeWidth={1.8} color="currentColor" />
      <input
        className="w-full border-0 bg-transparent text-xs text-ink outline-none placeholder:text-ink-3"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder={placeholder}
        autoFocus
      />
    </label>
  );

  return (
    <div
      data-picker-panel
      onKeyDown={handleKeyDown}
      className={`z-20 flex flex-col rounded-[10px] border border-line bg-surface p-1.5 shadow-raised ${className}`}
      style={{ animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both", ...style }}
    >
      {title && (
        <div className="flex shrink-0 items-center justify-between gap-2 px-2 pb-2 pt-1">
          <strong className="text-sm text-ink">{title}</strong>
          {titleAction}
        </div>
      )}
      {header}
      {searchPlacement === "top" && search}
      <ScrollArea className="grid max-h-64 grid-cols-1 content-start gap-0.5">
        {children}
        {isEmpty && <div className="px-2 py-5 text-center text-xs text-ink-3">{emptyLabel}</div>}
      </ScrollArea>
      {searchPlacement === "bottom" && search}
    </div>
  );
}

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
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-disabled={disabled || undefined}
      data-picker-row
      role={option ? "option" : undefined}
      aria-selected={option ? selected : undefined}
      onClick={onClick}
      className={`relative z-10 flex w-full disabled:opacity-40 disabled:cursor-default items-center gap-2 rounded-control border px-2 py-1.5 text-left transition-colors focus-visible:bg-hover focus-visible:outline-2 focus-visible:outline-ink-3 focus-visible:-outline-offset-2 ${selected ? "border-line-strong bg-hover" : "border-transparent hover:border-line hover:bg-inset"}`}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      <span className={`flex min-w-0 flex-1 ${wrapLabel ? "flex-col gap-0.5" : "items-baseline gap-1.5"}`}>
        <strong style={labelStyle} className={`${wrapLabel ? "w-full whitespace-normal break-words leading-4" : "shrink-0"} text-xs font-medium text-ink`}>
          {label}
        </strong>
        {meta && (
          <span
            data-picker-meta
            className="shrink-0 self-center rounded-chip border border-line px-1 text-[10px] leading-[14px] font-medium tabular-nums text-ink-3"
          >
            {meta}
          </span>
        )}
        {description && <span className="truncate text-[10px] text-ink-3">{description}</span>}
      </span>
      {trailing && <span className="max-w-[40%] shrink-0 truncate text-[11px] text-ink-3">{trailing}</span>}
      {selected && (
        <span className="shrink-0">
          <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={1.8} color="currentColor" />
        </span>
      )}
    </button>
  );
}
