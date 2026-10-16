import { useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { EASE_OUT, SPRING_LAYOUT } from "../../lib/ease";
import { roomToWiden, usePanelWidth } from "../agents/panel-width";
import { ResizeHandle } from "../primitives/ResizeHandle";

/** The bot profile's column beside <main>, opened and resized like the changes panel's (ChangesPanelSlot). */
export function BotProfileSlot({ open, children }: { open: boolean; children: React.ReactNode }) {
  const reduced = useReducedMotion();
  const [sliding, setSliding] = useState(false);
  const resize = usePanelWidth("bots");
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="bot-profile"
          data-bot-profile-slot
          className={`relative z-[43] -ml-3 flex min-h-0 shrink-0 ${sliding ? "overflow-hidden" : "overflow-visible"}`}
          onAnimationStart={() => setSliding(true)}
          onAnimationComplete={() => setSliding(false)}
          initial={{ width: 0 }}
          animate={{ width: "auto" }}
          exit={{ width: 0 }}
          transition={reduced ? { duration: 0 } : SPRING_LAYOUT}
        >
          <motion.div
            className="relative flex min-h-0 pt-[var(--window-chrome-height)] pr-3 pb-3"
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            transition={reduced ? { duration: 0 } : { duration: 0.24, ease: EASE_OUT }}
          >
            <div className="absolute top-[var(--window-chrome-height)] bottom-3 left-0">
              <ResizeHandle
                label="Resize bot profile"
                side="left"
                width={resize.width}
                min={resize.min}
                max={() => roomToWiden("bots", resize.width)}
                reset={resize.reset}
                onResize={resize.onResize}
                onCommit={resize.onCommit}
              />
            </div>
            <div className="flex min-h-0 overflow-hidden rounded-window bg-surface shadow-card" style={{ width: resize.width }}>
              {children}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
