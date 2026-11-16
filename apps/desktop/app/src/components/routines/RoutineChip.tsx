import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Routine } from "@milagre/shared/model";
import Tooltip from "../primitives/Tooltip";
import { Chip } from "../primitives/Chip";
import { chatRoutine } from "@milagre/shared/routines";
import { chipStripInsets, useRoutines } from "../../lib/routines";
import { useBookmarkReserve } from "../../lib/bookmark-reserve";
import { useWindowChrome } from "../../lib/window-chrome";
import { routineIcon } from "./routine-icon";

const CORNER_BUTTONS = 300;

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
  if (place === "tile") return <Pill routine={routine} onOpen={onOpen} wrapper="min-w-0 max-w-[45%] shrink" />;
  return (
    <Strip>
      <Pill routine={routine} onOpen={onOpen} wrapper="pointer-events-auto min-w-0 max-w-[320px] rounded-full bg-surface shadow-card" />
    </Strip>
  );
}

function Pill({ routine, onOpen, wrapper }: { routine: Routine; onOpen: (routineId: string) => void; wrapper: string }) {
  return (
    <Tooltip label="Open Routine" side="bottom" className={wrapper}>
      <Chip
        data-routine-chip={routine.id}
        icon={routineIcon(routine)}
        onClick={(event) => {
          event.stopPropagation();
          onOpen(routine.id);
        }}
        className="no-drag max-w-full"
      >
        <span className="truncate">{routine.name}</span>
      </Chip>
    </Tooltip>
  );
}

function Strip({ children }: { children: ReactNode }) {
  const strip = useRef<HTMLDivElement>(null);
  const { rightInset } = useWindowChrome();
  const bookmark = useBookmarkReserve();
  const [insets, setInsets] = useState({ left: CORNER_BUTTONS, right: CORNER_BUTTONS });
  useLayoutEffect(() => {
    const host = strip.current?.offsetParent;
    if (!(host instanceof HTMLElement)) return;
    const update = () => {
      const rect = host.getBoundingClientRect();
      const next = chipStripInsets(rect.width, window.innerWidth - rect.right, CORNER_BUTTONS + rightInset, bookmark);
      setInsets((current) => (current.left === next.left && current.right === next.right ? current : next));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [rightInset, bookmark]);
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
