import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Routine } from "@milagre/shared/model";
import Tooltip from "../primitives/Tooltip";
import { chatRoutine } from "@milagre/shared/routines";
import { chipStripInsets, useRoutines } from "../../lib/routines";
import { useWindowChrome } from "../../lib/window-chrome";
import { routineIcon } from "./routine-icon";

/**
 * How far from the window's right edge its corner buttons reach (the changes toggle, the side panels' toggles and the grid
 * toggle, 40px apart): the strip's chip keeps clear of them.
 */
const CORNER_BUTTONS = 300;

/**
 * The open Chat's Routine as a chip that opens the Routine's page: the Routine whose Run opened the Chat (`run`, hidden or
 * kept), else an enabled Heartbeat that checks back on it; nothing for any other Chat. `place` is where it sits: "strip",
 * over the single open Chat in the window's top strip, or "tile", in a grid tile's header.
 */
export function RoutineChip({
  chatKey,
  run,
  place,
  onOpen,
}: {
  chatKey: string;
  run?: { routineId: string };
  place: "strip" | "tile";
  onOpen: (routineId: string) => void;
}) {
  const { routines } = useRoutines();
  const routine = chatRoutine(routines, chatKey, run);
  if (!routine) return null;
  if (place === "tile")
    return (
      <Pill
        routine={routine}
        onOpen={onOpen}
        wrapper="min-w-0 max-w-[45%] shrink"
        className="h-6 border border-line pr-2 pl-1.5 text-[11.5px] hover:bg-hover"
      />
    );
  return (
    <Strip>
      <Pill
        routine={routine}
        onOpen={onOpen}
        wrapper="pointer-events-auto min-w-0 max-w-[320px]"
        className="h-7 bg-surface pr-3 pl-2.5 text-[12px] shadow-card"
      />
    </Strip>
  );
}

function Pill({ routine, onOpen, wrapper, className }: { routine: Routine; onOpen: (routineId: string) => void; wrapper: string; className: string }) {
  return (
    <Tooltip label="Open Routine" side="bottom" className={wrapper}>
      <button
        type="button"
        data-routine-chip={routine.id}
        onClick={(event) => {
          // A grid tile focuses its Chat on a click; this click goes to the Routine instead.
          event.stopPropagation();
          onOpen(routine.id);
        }}
        className={`flex max-w-full min-w-0 items-center gap-1.5 rounded-full font-medium text-ink-2 transition-colors hover:text-ink [-webkit-app-region:no-drag] ${className}`}
      >
        <HugeiconsIcon icon={routineIcon(routine)} size={14} strokeWidth={1.8} color="currentColor" className="shrink-0" />
        <span className="truncate">{routine.name}</span>
      </button>
    </Tooltip>
  );
}

/**
 * The window's top strip over <main>, where the diff's bar sits too: above the drag strip (z-55), with only the chip opting
 * out of dragging. Its padding (chipStripInsets) centers the chip and keeps it clear of the corner's buttons, which are
 * fixed to the window's edge while <main> narrows with the sidebar, a side panel or the window.
 */
function Strip({ children }: { children: ReactNode }) {
  const strip = useRef<HTMLDivElement>(null);
  const { rightInset } = useWindowChrome();
  const [insets, setInsets] = useState({ left: CORNER_BUTTONS, right: CORNER_BUTTONS });
  useLayoutEffect(() => {
    const host = strip.current?.offsetParent;
    if (!(host instanceof HTMLElement)) return;
    const update = () => {
      const rect = host.getBoundingClientRect();
      const next = chipStripInsets(rect.width, window.innerWidth - rect.right, CORNER_BUTTONS + rightInset);
      setInsets((current) => (current.left === next.left && current.right === next.right ? current : next));
    };
    update();
    // <main> resizes with the window, the sidebar and the docked panels, which is what moves it under the corner.
    const observer = new ResizeObserver(update);
    observer.observe(host);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [rightInset]);
  return (
    <div
      ref={strip}
      className="pointer-events-none absolute inset-x-0 top-[var(--window-chrome-top)] z-[55] flex h-8 items-center justify-center"
      style={{ paddingLeft: insets.left, paddingRight: insets.right }}
    >
      {children}
    </div>
  );
}
