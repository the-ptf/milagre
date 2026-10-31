import { HugeiconsIcon } from "@hugeicons/react";
import { useShortcutLabel } from "../../lib/keybindings";
import { ArrowDown01Icon, ArrowLeft02Icon, ArrowRight02Icon, GitBranchIcon, GridViewIcon } from "@hugeicons/core-free-icons";
import { useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Tooltip from "../primitives/Tooltip";
import GlideMenu from "../primitives/GlideMenu";
import { ScrollArea } from "../primitives/ScrollArea";
import { useDismiss } from "../../lib/use-dismiss";
import { EASE_OUT } from "../../lib/ease";
import { useControlsClearance, useWindowChrome } from "../../lib/window-chrome";

/**
 * Over the open diff: Back to the chat on the left, the diff's toolbar on the right. It comes and goes with the diff.
 * It sits inside the window's drag strip (z-50) and paints above it, so its buttons get the clicks. Chromium builds the
 * drag region from every element with an app-region in tree order (drag adds, no-drag subtracts), so only the button
 * groups opt out: the empty stretch between them keeps dragging the window.
 */
/** `send` is the diff comments waiting to go to the chat; the button is there while any can. */
export function DiffBar({
  open,
  onBack,
  send,
  trailing,
}: {
  open: boolean;
  onBack: () => void;
  send?: { count: number; onSend: () => void };
  trailing?: React.ReactNode;
}) {
  const reduced = useReducedMotion();
  const { bar, inset } = useControlsClearance<HTMLDivElement>(open);
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          ref={bar}
          key="diff-bar"
          data-diff-bar
          style={inset}
          className="absolute inset-x-3 top-[var(--window-chrome-top)] z-[55] flex h-8 items-center justify-between"
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={reduced ? { duration: 0 } : { duration: 0.2, ease: EASE_OUT }}
        >
          <div className="flex items-center gap-2 [-webkit-app-region:no-drag]">
            <button
              type="button"
              data-diff-back
              onClick={onBack}
              className="flex h-8 items-center gap-1.5 rounded-control bg-surface pr-3 pl-2 text-[12.5px] font-medium text-ink-2 shadow-card transition-colors hover:text-ink"
            >
              <HugeiconsIcon icon={ArrowLeft02Icon} size={15} strokeWidth={1.8} color="currentColor" />
              Back
            </button>
            <AnimatePresence initial={false}>
              {send && send.count > 0 && (
                <motion.button
                  key="send"
                  type="button"
                  data-diff-send
                  onClick={send.onSend}
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={reduced ? { duration: 0 } : { duration: 0.16, ease: EASE_OUT }}
                  className="h-8 rounded-control bg-ink px-3 text-[12.5px] font-medium text-surface shadow-card transition-opacity hover:opacity-85"
                >
                  {send.count === 1 ? "Send 1 comment" : `Send ${send.count} comments`}
                </motion.button>
              )}
            </AnimatePresence>
          </div>
          {trailing}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Top-right window button; sits inside the drag strip, so it opts out of dragging. */
export function ChangesToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const chrome = useWindowChrome();
  const shortcut = useShortcutLabel("changes.toggle");
  return (
    <div className="fixed top-[var(--window-chrome-top)] z-[60] [-webkit-app-region:no-drag]" style={{ right: 12 + chrome.rightInset }}>
      <Tooltip label={open ? "Hide changes" : "Show changes"} shortcut={shortcut} compactHint side="bottom" align="end">
        <button
          type="button"
          aria-label="Toggle changes panel"
          aria-pressed={open}
          data-changes-toggle
          onClick={onToggle}
          className={`flex size-8 items-center justify-center rounded-control transition-colors hover:bg-hover hover:text-ink ${open ? "bg-hover text-ink" : "text-ink-3"}`}
        >
          <HugeiconsIcon icon={GitBranchIcon} size={18} strokeWidth={1.8} color="currentColor" />
        </button>
      </Tooltip>
    </div>
  );
}

/** Top right, left of the panel buttons: shows every active Chat as a grid, or the open one alone. `offset` as AttentionButton's. */
export function LayoutToggle({ grid, offset, onToggle }: { grid: boolean; offset: number; onToggle: () => void }) {
  const chrome = useWindowChrome();
  const shortcut = useShortcutLabel("grid.toggle");
  return (
    <div className="fixed top-[var(--window-chrome-top)] z-[60] [-webkit-app-region:no-drag]" style={{ right: 12 + chrome.rightInset + offset * 40 }}>
      <Tooltip label={grid ? "Show one Chat" : "Show active Chats as a grid"} shortcut={shortcut} compactHint side="bottom" align="end">
        <button
          type="button"
          aria-label="Show active Chats as a grid"
          aria-pressed={grid}
          data-layout-toggle
          onClick={onToggle}
          className={`flex size-8 items-center justify-center rounded-control transition-colors hover:bg-hover hover:text-ink ${grid ? "bg-hover text-ink" : "text-ink-3"}`}
        >
          <HugeiconsIcon icon={GridViewIcon} size={18} strokeWidth={1.8} color="currentColor" />
        </button>
      </Tooltip>
    </div>
  );
}

export type AttentionItem = { key: string; project: string; title?: string; asking: boolean; waitingFor?: string };

/**
 * Top right, left of the panel buttons when they show (the changes toggle, and a Chat's designs and simulator). One waiting chat opens on click; several open a menu
 * that lists each, oldest first, so you pick where to go.
 */
export function AttentionButton({ label, items, offset, onOpen }: { label: string; items: AttentionItem[]; offset: number; onOpen: (key: string) => void }) {
  const chrome = useWindowChrome();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const many = items.length > 1;
  // The button is fixed to the window's corner, so a scroll or resize never moves it: the menu stays open.
  useDismiss(
    open && many,
    () => setOpen(false),
    (target) => !!target.closest("[data-attention]"),
    () => {},
  );
  const go = (key: string) => {
    setOpen(false);
    onOpen(key);
  };
  return (
    <div
      data-attention
      className="fixed top-[var(--window-chrome-top)] z-[60] [-webkit-app-region:no-drag]"
      // Left of the buttons in the corner: `offset` is how many there are, 40px each (PanelToggles' CORNER_PITCH).
      style={{
        right: 12 + chrome.rightInset + offset * 40,
        maxWidth: `max(0px, calc(100vw - ${chrome.controlsEnd + 12 + chrome.rightInset + offset * 40}px))`,
        animation: "fade-in 160ms ease-out",
      }}
    >
      <button
        ref={trigger}
        type="button"
        data-attention-button
        title={label}
        aria-haspopup={many ? "menu" : undefined}
        aria-expanded={many ? open : undefined}
        onClick={() => (many ? setOpen((value) => !value) : items[0] && go(items[0].key))}
        className={`flex h-8 max-w-full items-center gap-1.5 overflow-hidden rounded-control bg-surface/90 px-2.5 text-[13px] font-medium text-orange-ink backdrop-blur-chip transition-colors hover:bg-surface ${open ? "bg-surface" : ""}`}
      >
        <span className="min-w-0 max-w-80 truncate">{label}</span>
        <HugeiconsIcon className="shrink-0" icon={many ? ArrowDown01Icon : ArrowRight02Icon} size={15} strokeWidth={2} color="currentColor" />
      </button>
      {open && many && (
        <div
          role="menu"
          aria-label="Chats waiting for you"
          data-attention-menu
          onKeyDown={(event) => {
            const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]")];
            const index = rows.indexOf(document.activeElement as HTMLElement);
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
              trigger.current?.focus();
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              rows[(index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
            }
          }}
          className="absolute top-full right-0 mt-1.5 flex w-72 flex-col overflow-hidden rounded-[14px] bg-surface shadow-overlay"
          style={{ animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "top right" }}
        >
          <ScrollArea className="max-h-80 p-1.5">
            <GlideMenu className="flex flex-col gap-px" rowSelector="[role=menuitem]" highlightClassName="inset-x-0 rounded-[8px] bg-hover-2">
              {items.map((item, index) => (
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  data-attention-chat={item.key}
                  autoFocus={index === 0}
                  onClick={() => go(item.key)}
                  className="relative z-10 flex min-h-11 w-full flex-col justify-center rounded-[8px] px-2.5 py-1.5 text-left outline-none focus-visible:bg-hover-2"
                >
                  <span className="w-full truncate text-[13.5px] text-ink">{item.title || item.waitingFor || "Chat"}</span>
                  <span className="w-full truncate text-[11.5px] text-ink-3">
                    {item.project} ·{" "}
                    <span className={item.asking ? "text-accent-ink" : "text-orange-ink"}>{item.asking ? "Asking you" : "Waiting for approval"}</span>
                  </span>
                </button>
              ))}
            </GlideMenu>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}
