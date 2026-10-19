import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { EASE_OUT, SPRING_LAYOUT, scaled, scaledSpring, useMotionScale } from "../../lib/ease";
import { roomToWiden, usePanelWidth } from "../agents/panel-width";
import { ResizeHandle } from "../primitives/ResizeHandle";

/**
 * The panel's column beside <main>. Its width springs open from zero so the chat narrows with it instead of
 * jumping; the -12px margin cancels the row's gap while the column is empty, and <main> keeps its own right padding.
 * It clips only while its width moves: clipped at rest, it would cut the panel's shadow at its left edge.
 * Its left edge drags the panel's width, which the panel reads from --changes-panel-width.
 */
export function ChangesPanelSlot({ open, children }: { open: boolean; children: React.ReactNode }) {
  const scale = useMotionScale();
  const [sliding, setSliding] = useState(false);
  const resize = usePanelWidth("changes");
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="changes-panel"
          data-changes-slot
          // Above the panels docked left of it (dock-area.ts has the order), so they slide under it, not over it.
          className={`relative z-[43] -ml-3 flex min-h-0 shrink-0 ${sliding ? "overflow-hidden" : "overflow-visible"}`}
          onAnimationStart={() => setSliding(true)}
          onAnimationComplete={() => setSliding(false)}
          initial={{ width: 0 }}
          animate={{ width: "auto" }}
          exit={{ width: 0 }}
          transition={scaledSpring(SPRING_LAYOUT, scale)}
        >
          <motion.div
            className="relative flex min-h-0 pt-[60px] pr-3 pb-3"
            style={{ "--changes-panel-width": `${resize.width}px` } as React.CSSProperties}
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            transition={{ duration: scaled(0.24, scale), ease: EASE_OUT }}
          >
            {/* Beside the panel's card only, not the window's top strip above it. */}
            <div className="absolute top-[60px] bottom-3 left-0">
              <ResizeHandle
                label="Resize changes panel"
                side="left"
                width={resize.width}
                min={resize.min}
                max={() => roomToWiden("changes", resize.width)}
                reset={resize.reset}
                onResize={resize.onResize}
                onCommit={resize.onCommit}
              />
            </div>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
