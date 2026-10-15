import { useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

/**
 * The thin bar on a panel's edge that drags its width: the sidebar's right edge, a side panel's left one. `side` is the
 * edge it sits on, so dragging away from the panel widens it. `onResize` follows the pointer; `onCommit` gets the width
 * the drag (or a key, or a double-click back to `reset`) ended on, for the panel to save. `max` may be a function, read
 * when a drag starts, for a bound that depends on the room left beside the panel.
 */
export function ResizeHandle({
  label,
  side,
  width,
  min,
  max,
  reset,
  onResize,
  onCommit,
  onResizingChange,
  className = "",
}: {
  label: string;
  side: "left" | "right";
  width: number;
  min: number;
  max: number | (() => number);
  reset: number;
  onResize: (width: number) => void;
  onCommit: (width: number) => void;
  onResizingChange?: (resizing: boolean) => void;
  className?: string;
}) {
  const [resizing, setResizing] = useState(false);
  const bound = () => Math.max(min, typeof max === "function" ? max() : max);
  const clamp = (value: number, upper = bound()) => Math.round(Math.min(upper, Math.max(min, value)));
  // Dragging right widens a panel whose handle is on its right edge; dragging left, one whose handle is on its left.
  const direction = side === "right" ? 1 : -1;

  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const upper = bound();
    let latest = clamp(width, upper);
    const startWidth = latest;
    setResizing(true);
    onResizingChange?.(true);
    document.body.style.cursor = "col-resize";
    const move = (moveEvent: PointerEvent) => {
      latest = clamp(startWidth + direction * (moveEvent.clientX - startX), upper);
      onResize(latest);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      document.body.style.cursor = "";
      setResizing(false);
      onResizingChange?.(false);
      onCommit(latest);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  const keys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = (event.shiftKey ? 48 : 16) * direction;
    if (event.key === "ArrowLeft") onCommit(clamp(width - step));
    else if (event.key === "ArrowRight") onCommit(clamp(width + step));
    else if (event.key === "Home") onCommit(min);
    else if (event.key === "End") onCommit(bound());
    else return;
    event.preventDefault();
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={typeof max === "number" ? max : undefined}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={start}
      onDoubleClick={() => onCommit(clamp(reset))}
      onKeyDown={keys}
      className={`group absolute bottom-0 top-0 z-10 flex w-3 cursor-col-resize justify-center outline-none [-webkit-app-region:no-drag] ${side === "right" ? "right-[-6px]" : "left-[-6px]"} ${className}`}
    >
      <span
        className={`my-3 w-0.5 rounded-full transition-colors duration-150 group-hover:bg-line-strong group-focus-visible:bg-accent ${resizing ? "bg-line-strong" : "bg-transparent"}`}
      />
    </div>
  );
}
