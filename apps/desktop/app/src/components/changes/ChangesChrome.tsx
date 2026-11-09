import { HugeiconsIcon } from "@hugeicons/react";
import { useShortcutLabel } from "../../lib/keybindings";
import { ArrowLeft02Icon, FileDiffIcon, GridViewIcon, HierarchySquare02Icon } from "@hugeicons/core-free-icons";
import { useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { chatMarkPresentation } from "@milagre/shared/chats";
import { attentionCount } from "@milagre/shared/attention";
import Tooltip from "../primitives/Tooltip";
import { buttonClass, IconButton } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import { MenuRow, Popover } from "../primitives/Popover";
import { DURATION, EASE_OUT } from "../../lib/ease";
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
  label = "Back",
  send,
  trailing,
  corner,
}: {
  open: boolean;
  onBack: () => void;
  /** Where Back goes, as a breadcrumb in the Chat title's place: the Chat's title over a Chat's diff. */
  label?: string;
  send?: { count: number; onSend: () => void };
  trailing?: React.ReactNode;
  /** Width (px) of the corner toggles top right, which the trailing controls keep clear of. */
  corner?: number;
}) {
  const reduced = useReducedMotion();
  const { bar, inset } = useControlsClearance<HTMLDivElement>(open, corner);
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
          transition={reduced ? { duration: 0 } : { duration: DURATION.base, ease: EASE_OUT }}
        >
          <div className="no-drag flex items-center gap-2">
            {/* A 28px ghost breadcrumb where the Chat's title sits (ChatIdentity): "← <Chat title>". */}
            <Tooltip label={label === "Back" ? "Back" : `Back to ${label}`} side="bottom" align="start" asChild>
              <button
                type="button"
                data-diff-back
                aria-label={label === "Back" ? "Back" : `Back to ${label}`}
                onClick={onBack}
                className="group flex h-7 max-w-[min(50vw,480px)] min-w-0 items-center gap-1.5 rounded-control px-2 text-13 font-medium text-ink transition-colors hover:bg-hover active:scale-press"
              >
                <span className="flex shrink-0 text-ink-3 transition-colors group-hover:text-ink">
                  <Icon icon={ArrowLeft02Icon} size={14} />
                </span>
                <span className="min-w-0 truncate">{label}</span>
              </button>
            </Tooltip>
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
                  transition={reduced ? { duration: 0 } : { duration: DURATION.base, ease: EASE_OUT }}
                  className={buttonClass()}
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
    <div className="no-drag fixed top-[var(--window-chrome-top)] z-[60]" style={{ right: 12 + chrome.rightInset }}>
      <Tooltip label={open ? "Hide Changes" : "Show Changes"} shortcut={shortcut} compactHint side="bottom" align="end">
        <IconButton label="Toggle changes panel" icon={FileDiffIcon} size={32} aria-pressed={open} data-changes-toggle onClick={onToggle} />
      </Tooltip>
    </div>
  );
}

/** Top right, left of the panel buttons: shows every active Chat as a grid, or the open one alone. `offset` as AttentionButton's. */
export function LayoutToggle({ grid, offset, onToggle }: { grid: boolean; offset: number; onToggle: () => void }) {
  const chrome = useWindowChrome();
  const shortcut = useShortcutLabel("grid.toggle");
  return (
    <div className="no-drag fixed top-[var(--window-chrome-top)] z-[60]" style={{ right: 12 + chrome.rightInset + offset * 40 }}>
      <Tooltip label={grid ? "Show one Chat" : "Show active Chats as a grid"} shortcut={shortcut} compactHint side="bottom" align="end">
        <IconButton label="Show active Chats as a grid" icon={GridViewIcon} size={32} aria-pressed={grid} data-layout-toggle onClick={onToggle} />
      </Tooltip>
    </div>
  );
}

/**
 * Top right, left of the layout toggle, on a Chat with subchats (subchat-rows.ts): shows the parent and every subchat side
 * by side, or the open Chat alone again. `offset` as AttentionButton's.
 */
export function SubchatsButton({ count, shown, offset, onToggle }: { count: number; shown: boolean; offset: number; onToggle: () => void }) {
  const chrome = useWindowChrome();
  const label = shown ? "Back to the open Chat" : `Show the ${count} subchat${count === 1 ? "" : "s"} side by side`;
  return (
    <div className="no-drag fixed top-[var(--window-chrome-top)] z-[60]" style={{ right: 12 + chrome.rightInset + offset * 40 }}>
      <Tooltip label={label} compactHint side="bottom" align="end">
        <button
          type="button"
          aria-label={label}
          aria-pressed={shown}
          data-subchats-toggle
          onClick={onToggle}
          className={`relative flex size-8 items-center justify-center rounded-control transition-colors hover:bg-hover hover:text-ink ${shown ? "bg-hover text-ink" : "text-ink-3"}`}
        >
          <HugeiconsIcon icon={HierarchySquare02Icon} size={18} strokeWidth={1.8} color="currentColor" />
          <span
            aria-hidden
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-10 font-semibold tabular-nums text-white"
          >
            {count}
          </span>
        </button>
      </Tooltip>
    </div>
  );
}

/** About how wide the attention chip draws ("2 waiting"), for a bar along <main>'s top that keeps clear of it. */
export const ATTENTION_CHIP_WIDTH = 96;

export type AttentionItem = { key: string; project: string; title?: string; asking: boolean; waitingFor?: string };

/**
 * Top right, left of the panel buttons when they show (the changes toggle, and a Chat's designs and simulator): a calm,
 * fixed chip, an orange dot and "2 waiting", never a Chat's title, so it doesn't change width or outshout the Chat. One
 * waiting Chat opens on click (its title is the tooltip); several open a menu that lists each, oldest first. `label`
 * names them in a sentence, for the tooltip and screen readers.
 */
export function AttentionButton({ label, items, offset, onOpen }: { label: string; items: AttentionItem[]; offset: number; onOpen: (key: string) => void }) {
  const chrome = useWindowChrome();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const many = items.length > 1;
  const go = (key: string) => {
    setOpen(false);
    onOpen(key);
  };
  return (
    <div
      data-attention
      className="no-drag fixed top-[var(--window-chrome-top)] z-[60] flex h-8 items-center"
      // Left of the buttons in the corner: `offset` is how many there are, 40px each (PanelToggles' CORNER_PITCH).
      style={{
        right: 12 + chrome.rightInset + offset * 40,
        maxWidth: `max(0px, calc(100vw - ${chrome.controlsEnd + 12 + chrome.rightInset + offset * 40}px))`,
        animation: "fade-in var(--duration-fast) var(--ease-enter)",
      }}
    >
      <Tooltip label={many ? label : `Open ${items[0]?.title || "the Chat"}`} side="bottom" align="end" asChild>
        <button
          ref={trigger}
          type="button"
          data-attention-button
          aria-label={label}
          aria-haspopup={many ? "menu" : undefined}
          aria-expanded={many ? open : undefined}
          onClick={() => (many ? setOpen((value) => !value) : items[0] && go(items[0].key))}
          className="flex h-7 max-w-full items-center gap-2 overflow-hidden rounded-control bg-hover px-2.5 text-13 font-medium tabular-nums text-ink-2 transition-colors hover:bg-hover-2 hover:text-ink active:scale-press aria-expanded:bg-hover-2 aria-expanded:text-ink"
        >
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-orange" />
          <span className="min-w-0 truncate">{attentionCount(items.length)}</span>
        </button>
      </Tooltip>
      {open && many && (
        <Popover anchor={trigger} width={288} label="Chats waiting for you" onClose={() => setOpen(false)} data-attention-menu>
          {items.map((item) => (
            <MenuRow
              key={item.key}
              data-attention-chat={item.key}
              onClick={() => go(item.key)}
              title={item.title || item.waitingFor || "Chat"}
              subtitle={
                <>
                  {item.project} · <span className="text-orange-ink">{chatMarkPresentation(item.asking ? "question" : "waiting").label}</span>
                </>
              }
            />
          ))}
        </Popover>
      )}
    </div>
  );
}
