import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ClipboardPasteIcon, Copy01Icon } from "@hugeicons/core-free-icons";
import GlideMenu from "../primitives/GlideMenu";
import { Icon } from "../primitives/Icon";
import { useDismiss } from "../../lib/use-dismiss";
import { isMac, isWindows } from "../../lib/shortcut-hints";

const MENU_WIDTH = 200;
const COPY_KEY = isMac ? "⌘C" : isWindows ? "Ctrl+C" : "Ctrl+Shift+C";
const PASTE_KEY = isMac ? "⌘V" : isWindows ? "Ctrl+V" : "Ctrl+Shift+V";

/** The menu a right click opens on a Terminal. */
export function TerminalMenu({
  x,
  y,
  canCopy,
  onCopy,
  onPaste,
  onClose,
}: {
  x: number;
  y: number;
  canCopy: boolean;
  onCopy(): void;
  onPaste(): void;
  onClose(): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: y, left: x });

  // Keeps the menu within the window, and leaves the keyboard on its first row.
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const { height } = element.getBoundingClientRect();
    setPosition({ top: y + height > window.innerHeight - 8 ? Math.max(8, y - height) : y, left: Math.min(x, window.innerWidth - MENU_WIDTH - 8) });
    element.querySelector<HTMLElement>("[data-menu-row]:not(:disabled)")?.focus();
  }, [x, y]);

  useDismiss(true, onClose, (target) => Boolean(menu.current?.contains(target)));

  const moveFocus = (event: KeyboardEvent) => {
    const rows = [...(menu.current?.querySelectorAll<HTMLElement>("[data-menu-row]:not(:disabled)") ?? [])];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      rows[(rows.indexOf(document.activeElement as HTMLElement) + step + rows.length) % rows.length]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "Tab") {
      event.preventDefault();
    }
  };

  const rows = [
    { label: "Copy", icon: Copy01Icon, keys: COPY_KEY, disabled: !canCopy, run: onCopy },
    { label: "Paste", icon: ClipboardPasteIcon, keys: PASTE_KEY, disabled: false, run: onPaste },
  ];

  return createPortal(
    <div
      ref={menu}
      role="menu"
      aria-label="Terminal"
      data-terminal-menu
      onKeyDown={moveFocus}
      className="fixed z-[70] rounded-card bg-surface p-1.5 shadow-overlay"
      style={{ ...position, width: MENU_WIDTH, animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "top left" }}
    >
      <GlideMenu className="flex flex-col gap-px" rowSelector="[data-menu-row]:not(:disabled)" highlightClassName="inset-x-0 rounded-control bg-hover-2">
        {rows.map((row) => (
          <button
            key={row.label}
            data-menu-row
            role="menuitem"
            type="button"
            disabled={row.disabled}
            onClick={row.run}
            className="relative z-10 flex h-8 w-full items-center gap-2 rounded-control px-2 text-left text-ink outline-none focus-visible:bg-hover-2 disabled:opacity-40"
          >
            <span className="flex size-5 shrink-0 items-center justify-center text-ink-2">
              <Icon icon={row.icon} size={16} />
            </span>
            <span className="min-w-0 flex-1 truncate text-13">{row.label}</span>
            <span className="shrink-0 text-12 text-ink-3">{row.keys}</span>
          </button>
        ))}
      </GlideMenu>
    </div>,
    document.body,
  );
}
