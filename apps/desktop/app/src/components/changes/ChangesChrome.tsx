import { useShortcutLabel } from "../../lib/keybindings";
import { ArrowLeft02Icon, FileDiffIcon, FlowConnectionIcon } from "@hugeicons/core-free-icons";
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
export function ChangesToggle({ open, onToggle, offset = 0 }: { open: boolean; onToggle: () => void; offset?: number }) {
  const chrome = useWindowChrome();
  const shortcut = useShortcutLabel("changes.toggle");
  return (
    <div className="no-drag fixed top-[var(--window-chrome-top)] z-[60]" style={{ right: 12 + chrome.rightInset + offset * 40 }}>
      <Tooltip label={open ? "Hide Changes" : "Show Changes"} shortcut={shortcut} compactHint side="bottom" align="end">
        <IconButton label="Toggle changes panel" icon={FileDiffIcon} size={32} aria-pressed={open} data-changes-toggle onClick={onToggle} />
      </Tooltip>
    </div>
  );
}

/** The corner's last button, at its far right: opens the canvas, or goes back from it. `offset` is how many corner buttons sit right of it. */
export function CanvasButton({ active, offset = 0, onToggle }: { active: boolean; offset?: number; onToggle: () => void }) {
  const chrome = useWindowChrome();
  const shortcut = useShortcutLabel("canvas.open");
  return (
    <div className="no-drag fixed top-[var(--window-chrome-top)] z-[60]" style={{ right: 12 + chrome.rightInset + offset * 40 }}>
      <Tooltip label={active ? "Back to the Chat" : "Canvas"} shortcut={shortcut} compactHint side="bottom" align="end">
        <IconButton label="Canvas" icon={FlowConnectionIcon} size={32} aria-pressed={active} data-canvas-toggle onClick={onToggle} />
      </Tooltip>
    </div>
  );
}
