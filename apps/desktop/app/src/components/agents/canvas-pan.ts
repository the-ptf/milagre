import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

const MIDDLE = 1;
const TAP_SLOP = 4;

type Drag = { pointer: number; x: number; y: number; startX: number; startY: number; design: string | null };

const editable = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])");

function useSpaceHeld(viewport: RefObject<HTMLElement | null>) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const port = viewport.current;
    if (!port) return;
    let over = false;
    const enter = () => (over = true);
    const leave = () => (over = false);
    const down = (event: KeyboardEvent) => {
      if (event.code !== "Space" || !over || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || editable(event.target)) return;
      event.preventDefault();
      setHeld(true);
    };
    const up = (event: KeyboardEvent) => event.code === "Space" && setHeld(false);
    const release = () => setHeld(false);
    port.addEventListener("pointerenter", enter);
    port.addEventListener("pointerleave", leave);
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", release);
    return () => {
      port.removeEventListener("pointerenter", enter);
      port.removeEventListener("pointerleave", leave);
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", release);
    };
  }, [viewport]);
  return held;
}

/**
 * Dragging the canvas moves it. The left button drags from the canvas and from designs not being tried; the middle
 * button, the Hand tool and a held Space drag from anywhere, designs included. A left press on a design that doesn't
 * drag (`onTap`) hands it the mouse.
 */
export function useCanvasPan({
  viewport,
  hand,
  origin,
  onPan,
  onTap,
}: {
  viewport: RefObject<HTMLElement | null>;
  hand: boolean;
  origin: () => { x: number; y: number };
  onPan: (x: number, y: number) => void;
  onTap: (design: string) => void;
}) {
  const space = useSpaceHeld(viewport);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);
  const start = (event: ReactPointerEvent<HTMLElement>, design: string | null) => {
    const at = origin();
    drag.current = { pointer: event.pointerId, x: event.clientX - at.x, y: event.clientY - at.y, startX: event.clientX, startY: event.clientY, design };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  return {
    grabAll: hand || space,
    dragging,
    /** Starts a drag the press always makes (middle button, Hand, Space); false leaves the press to the caller. */
    grab(event: ReactPointerEvent<HTMLElement>) {
      if (event.button !== MIDDLE && !(event.button === 0 && (hand || space))) return false;
      event.preventDefault();
      start(event, null);
      return true;
    },
    start,
    onPointerMove(event: ReactPointerEvent) {
      const from = drag.current;
      if (!from || from.pointer !== event.pointerId) return;
      if (!dragging && Math.hypot(event.clientX - from.startX, event.clientY - from.startY) < TAP_SLOP) return;
      if (!dragging) setDragging(true);
      onPan(event.clientX - from.x, event.clientY - from.y);
    },
    end(event: ReactPointerEvent) {
      const from = drag.current;
      if (!from || from.pointer !== event.pointerId) return;
      drag.current = null;
      setDragging(false);
      if (event.type === "pointerup" && from.design && !dragging) onTap(from.design);
    },
  };
}
