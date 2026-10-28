import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "../../../lib/use-dismiss";

const GAP = 6;
const INSET = 12;
// A PickerPanel with search and a full list: open upward when less than this fits below.
const NATURAL = 330;

/**
 * A button that opens a panel under it (above when there's no room), for the PR panel's menus and pickers.
 * `renderPanel` renders a PickerPanel; give it `className="min-h-0"` so it shrinks to the room there is.
 */
export function PopoverButton({
  label,
  className,
  width = 260,
  onOpen,
  renderPanel,
  children,
  ...rest
}: {
  label: string;
  className: string;
  width?: number;
  onOpen?: () => void;
  renderPanel: (close: () => void) => ReactNode;
  children: ReactNode;
} & Record<`data-${string}`, string | boolean | undefined>) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number }>({ left: 0, maxHeight: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const place = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Lined up with the button's right edge, but kept inside the panel the button sits in, and the window.
    const bounds = triggerRef.current?.closest("[data-changes-panel]")?.getBoundingClientRect();
    const min = Math.max(INSET, bounds ? bounds.left + GAP : 0);
    const max = Math.min(window.innerWidth - INSET, bounds ? bounds.right - GAP : Infinity) - width;
    const left = Math.max(INSET, Math.min(Math.max(min, Math.min(rect.right - width, max)), window.innerWidth - width - INSET));
    const below = window.innerHeight - rect.bottom - GAP - INSET;
    const above = rect.top - GAP - INSET;
    setPosition(
      below >= NATURAL || below >= above
        ? { left, top: rect.bottom + GAP, maxHeight: below }
        : { left, bottom: window.innerHeight - rect.top + GAP, maxHeight: above },
    );
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };
  useDismiss(
    open,
    () => close(false),
    (target) => !!(panelRef.current?.contains(target) || triggerRef.current?.contains(target)),
    place,
  );
  // A menu takes focus on its first row, so the arrow keys move through it; a search field focuses itself.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (open && panel && !panel.contains(document.activeElement)) panel.querySelector<HTMLElement>("[data-picker-row]")?.focus();
  }, [open]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    close();
  };

  return (
    <>
      <button
        {...rest}
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (open) return close(false);
          place();
          setOpen(true);
          onOpen?.();
        }}
        className={`${className} ${open ? "bg-hover text-ink" : ""}`}
      >
        {children}
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            onKeyDown={onKeyDown}
            className="fixed z-50 flex flex-col"
            style={{ left: position.left, top: position.top, bottom: position.bottom, width, maxHeight: position.maxHeight }}
          >
            {renderPanel(close)}
          </div>,
          document.body,
        )}
    </>
  );
}
