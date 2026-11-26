import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { IconSvgElement } from "@hugeicons/react";
import GlideMenu from "./GlideMenu";
import { Icon } from "./Icon";
import { useDismiss } from "../../lib/use-dismiss";

export type ContextMenuRow = { key: string; label: string; hint?: string; icon?: IconSvgElement; onSelect: () => void };
export type ContextMenuEntry = ContextMenuRow | "divider" | { heading: string };

const WIDTH = 260;

/** A menu at a point (a right-click or the context-menu key), closed by a press outside, the window losing focus or Escape. */
export function ContextMenu({
  position,
  label,
  header,
  entries,
  onClose,
}: {
  position: { x: number; y: number };
  label: string;
  header?: ReactNode;
  entries: ContextMenuEntry[];
  onClose: (refocus: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ top: position.y, left: position.x });
  useDismiss(
    true,
    () => onClose(false),
    (target) => !!ref.current?.contains(target),
  );

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const { height } = menu.getBoundingClientRect();
    setPlace({
      top: position.y + height > window.innerHeight - 8 ? Math.max(8, position.y - height) : position.y,
      left: Math.max(8, Math.min(position.x, window.innerWidth - WIDTH - 8)),
    });
    menu.querySelector<HTMLElement>("[data-menu-row]")?.focus();
  }, [position.x, position.y]);

  const keys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const rows = [...(ref.current?.querySelectorAll<HTMLElement>("[data-menu-row]") ?? [])];
    const index = rows.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      rows[(index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      rows[event.key === "Home" ? 0 : rows.length - 1]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
    } else if (event.key === "Tab") event.preventDefault();
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      data-context-menu
      onKeyDown={keys}
      onContextMenu={(event) => event.preventDefault()}
      className="fixed z-[70] flex flex-col overflow-hidden rounded-card bg-surface p-1.5 shadow-overlay"
      style={{ ...place, width: WIDTH, animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) backwards", transformOrigin: "top left" }}
    >
      {header && <div className="truncate px-2 pb-1.5 pt-1 text-12 text-ink-3">{header}</div>}
      <GlideMenu className="flex flex-col gap-px" rowSelector="[data-menu-row]" highlightClassName="inset-x-0 rounded-control bg-hover-2">
        {entries.map((entry, index) =>
          entry === "divider" ? (
            <div key={`divider-${index}`} className="my-1 h-px bg-line" />
          ) : "heading" in entry ? (
            <div key={`heading-${entry.heading}`} className="px-2 pb-0.5 pt-1 text-11 font-medium text-ink-3">
              {entry.heading}
            </div>
          ) : (
            <button
              key={entry.key}
              data-menu-row={entry.key}
              role="menuitem"
              type="button"
              onClick={() => {
                onClose(false);
                entry.onSelect();
              }}
              className="relative z-10 flex h-8 w-full items-center gap-2 rounded-control px-2 text-left text-ink outline-none focus-visible:bg-hover-2"
            >
              {entry.icon && (
                <span className="flex size-5 shrink-0 items-center justify-center text-ink-2">
                  <Icon icon={entry.icon} size={16} />
                </span>
              )}
              <span className="min-w-0 flex-1 truncate text-13">{entry.label}</span>
              {entry.hint && <span className="shrink-0 text-12 text-ink-3">{entry.hint}</span>}
            </button>
          ),
        )}
      </GlideMenu>
    </div>,
    document.body,
  );
}
