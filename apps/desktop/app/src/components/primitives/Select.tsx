import { Fragment, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { PickerPanel, PickerRow } from "./Picker";
import { useDismiss } from "../../lib/use-dismiss";

export type SelectOption<T extends string> = {
  value: T;
  label: string;
  description?: string;
  /** Branch names and other long choices can wrap above their description. */
  wrapLabel?: boolean;
  icon?: ReactNode;
  // Shown in the trigger instead of the label when this option is selected.
  display?: ReactNode;
  // Consecutive options with the same group sit under one heading.
  group?: string;
  disabled?: boolean;
  // Applied to the row label and the trigger text, so a font row draws in its font.
  style?: CSSProperties;
};

const GAP = 6;
const INSET = 12;
// The list scrolls inside max-h-64; chrome is the panel padding, border and, with search, the field.
const LIST_MAX = 256;
const CHROME = 14;
const SEARCH = 52;
const ROW = 32;
const ROW_WITH_DESCRIPTION = 48;
const GROUP_HEADING = 28;

function naturalHeight<T extends string>(options: SelectOption<T>[], searchable: boolean) {
  let list = 0;
  options.forEach((option, index) => {
    list += option.description || option.wrapLabel ? ROW_WITH_DESCRIPTION : ROW;
    if (option.group && option.group !== options[index - 1]?.group) list += GROUP_HEADING;
  });
  return Math.min(LIST_MAX, list) + CHROME + (searchable ? SEARCH : 0);
}

/* The app's select: a trigger button that opens the shared picker panel.
 * A native select element opens macOS's own menu, so every choice goes through this.
 * The panel has no heading: the row or toolbar the trigger sits in already names the choice. */
export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  width = 240,
  disabled = false,
  triggerClassName = "",
  searchable = false,
  variant = "field",
  compact = false,
  leading,
  onOpenChange,
}: {
  label: string;
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  width?: number;
  disabled?: boolean;
  /** Added to the trigger's classes, e.g. `w-full` in a form. */
  triggerClassName?: string;
  /** A search field over a long list (e.g. time zones); it filters by label. */
  searchable?: boolean;
  /**
   * `chip`: a rounded pill on the field fill (the Routine form's chips) instead of a bordered field. `text`: the trigger
   * reads as plain text with a chevron (a heading that is also a choice), and the panel opens from its left edge.
   */
  variant?: "field" | "chip" | "text";
  /** The field at 28px, beside the toolbar's 28px icon buttons. */
  compact?: boolean;
  /** Shown before the label when the selected option has no icon of its own. */
  leading?: ReactNode;
  /** Told each time the menu opens or closes: a hover surface the trigger sits in (the usage card) stays open while the panel is in use, and the Appearance preview highlights the row's area. */
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number }>({ left: 0, maxHeight: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Inside an open modal <dialog> the panel goes into the dialog: the dialog sits in the top layer, above anything in body.
  // Inside a popover marked data-popover-host it goes into the popover, so a press on it counts as inside that popover.
  const [host, setHost] = useState<Element | null>(null);
  const [query, setQuery] = useState("");
  const words = query.toLowerCase().trim();
  const shown = searchable && words ? options.filter((option) => option.label.toLowerCase().includes(words)) : options;
  const selected = options.find((option) => option.value === value);

  function place() {
    setHost(triggerRef.current?.closest("dialog[open], [data-popover-host]") ?? null);
    const trigger = triggerRef.current?.getBoundingClientRect();
    if (!trigger) return;
    const left = Math.max(INSET, Math.min(variant === "text" ? trigger.left : trigger.right - width, window.innerWidth - width - INSET));
    const roomBelow = window.innerHeight - trigger.bottom - GAP - INSET;
    const roomAbove = trigger.top - GAP - INSET;
    // Open upward when the panel would not fit below and there is more room above, so a trigger near the bottom shows its rows.
    const fitsBelow = roomBelow >= naturalHeight(options, searchable);
    setPosition(
      fitsBelow || roomBelow >= roomAbove
        ? { left, top: trigger.bottom + GAP, maxHeight: roomBelow }
        : { left, bottom: window.innerHeight - trigger.top + GAP, maxHeight: roomAbove },
    );
  }

  function setShown(next: boolean) {
    setOpen(next);
    onOpenChange?.(next);
  }

  function close(refocus = true) {
    setShown(false);
    if (refocus) triggerRef.current?.focus();
  }

  function choose(next: T) {
    if (disabled || options.find((option) => option.value === next)?.disabled) return;
    if (next !== value) onChange(next);
    close();
  }

  useLayoutEffect(() => {
    // With a search field, it takes focus (autoFocus) so typing filters at once.
    if (!open || searchable) return;
    const rows = panelRef.current?.querySelectorAll<HTMLElement>("[data-picker-row]");
    const index = options.findIndex((option) => option.value === value && !option.disabled);
    const focusIndex = index >= 0 ? index : options.findIndex((option) => !option.disabled);
    rows?.[focusIndex]?.focus({ preventScroll: false });
  }, [open]);

  useDismiss(
    open,
    () => close(false),
    (target) => !!(panelRef.current?.contains(target) || triggerRef.current?.contains(target)),
    place,
  );

  function onPanelKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      close();
    }
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (open || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    event.preventDefault();
    setQuery("");
    place();
    setShown(true);
  }

  return (
    <>
      <button
        ref={triggerRef}
        disabled={disabled}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            close(false);
            return;
          }
          // A new search each time it opens; place() also runs on resize and scroll, which keep the query.
          setQuery("");
          place();
          setShown(true);
        }}
        onKeyDown={onTriggerKeyDown}
        className={
          variant === "chip"
            ? `flex h-7 items-center gap-1.5 rounded-full pr-2 pl-2.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink ${open ? "bg-hover text-ink" : "bg-field"} ${triggerClassName}`
            : variant === "text"
              ? `-mx-1.5 flex min-w-0 max-w-full items-center gap-1 rounded-[6px] px-1.5 text-left text-ink transition-colors hover:bg-hover-2 ${open ? "bg-hover-2" : ""} ${triggerClassName}`
              : `flex ${compact ? "h-7" : "h-8"} items-center gap-2 rounded-control border border-line pr-2.5 pl-3 text-[13px] font-medium text-ink transition-colors hover:bg-hover ${open ? "bg-hover" : "bg-surface"} ${triggerClassName}`
        }
      >
        {variant !== "text" && (selected?.icon ?? leading)}
        {selected?.display ?? (
          <span style={selected?.style} className="min-w-0 flex-1 truncate text-left">
            {selected?.label ?? ""}
          </span>
        )}
        <span className="text-ink-3">
          <HugeiconsIcon icon={ArrowDown01Icon} size={14} strokeWidth={1.8} color="currentColor" />
        </span>
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="listbox"
            aria-label={label}
            onKeyDown={onPanelKeyDown}
            className="fixed z-50"
            style={{ left: position.left, top: position.top, bottom: position.bottom, width }}
          >
            <PickerPanel
              style={{
                maxHeight: position.maxHeight,
                transformOrigin: `${position.top === undefined ? "bottom" : "top"} ${variant === "text" ? "left" : "right"}`,
              }}
              {...(searchable ? { query, onQueryChange: setQuery, placeholder: "Search", isEmpty: shown.length === 0, emptyLabel: "No matches" } : {})}
            >
              {shown.map((option, index) => (
                <Fragment key={option.value}>
                  {option.group && option.group !== shown[index - 1]?.group && (
                    <div className="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-3">{option.group}</div>
                  )}
                  <PickerRow
                    disabled={option.disabled}
                    icon={option.icon}
                    label={option.label}
                    labelStyle={option.style}
                    description={option.description}
                    wrapLabel={option.wrapLabel}
                    selected={option.value === value}
                    onClick={() => choose(option.value)}
                    option
                  />
                </Fragment>
              ))}
            </PickerPanel>
          </div>,
          host ?? document.body,
        )}
    </>
  );
}
