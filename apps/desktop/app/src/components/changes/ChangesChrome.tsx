import { HugeiconsIcon } from "@hugeicons/react";
import { useShortcutLabel } from "../../lib/keybindings";
import { ArrowLeft02Icon, FileDiffIcon, GridViewIcon, HierarchySquare02Icon } from "@hugeicons/core-free-icons";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Tooltip from "../primitives/Tooltip";
import { buttonClass, IconButton } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
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

/** Top right, left of the panel buttons: shows every active Chat as a grid, or the open one alone. `offset` is how many corner buttons sit right of it. */
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
 * by side, or the open Chat alone again. `offset` is how many corner buttons sit right of it.
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
        </button>
      </Tooltip>
    </div>
  );
}
