import { useCallback, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { snapSliderValue } from "./slider-value";

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export interface SliderOptions {
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  label: string;
  /** Announced instead of the bare number when the value carries a unit ("35%"). */
  formatValueText?: (value: number) => string;
}

/** Value plumbing shared by slider looks: step snapping, a pointer-capture drag anywhere on the
 * track, and arrow-key control. Visuals and motion stay in the component. */
export function useSlider({ value, onValueChange, min = 0, max = 100, step = 1, disabled = false, label, formatValueText }: SliderOptions) {
  const trackRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLElement | null>(null);
  // The ref answers the first pointermove after pointerdown without waiting on a re-render.
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const low = min;
  const high = max > min ? max : min;
  const stride = step > 0 ? step : 1;
  const current = clamp(value, low, high);
  const percent = high > low ? ((current - low) / (high - low)) * 100 : 0;

  const commit = useCallback((next: number) => onValueChange(snapSliderValue(next, low, high, stride)), [onValueChange, low, high, stride]);

  const commitFromX = useCallback(
    (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      commit(low + clamp((clientX - rect.left) / rect.width, 0, 1) * (high - low));
    },
    [commit, low, high],
  );

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      draggingRef.current = true;
      setDragging(true);
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        /* the pointer is already gone; the drag still runs */
      }
      handleRef.current?.focus({ preventScroll: true });
      commitFromX(event.clientX);
    },
    [disabled, commitFromX],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (draggingRef.current && !disabled) commitFromX(event.clientX);
    },
    [disabled, commitFromX],
  );

  const endDrag = useCallback((event: PointerEvent<HTMLDivElement>) => {
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
    draggingRef.current = false;
    setDragging(false);
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (disabled) return;
      const next: Record<string, number> = {
        ArrowRight: current + stride,
        ArrowUp: current + stride,
        ArrowLeft: current - stride,
        ArrowDown: current - stride,
        PageUp: current + stride * 10,
        PageDown: current - stride * 10,
        Home: low,
        End: high,
      };
      const value = next[event.key];
      if (value !== undefined) {
        event.preventDefault();
        commit(value);
      }
    },
    [disabled, current, stride, low, high, commit],
  );

  return {
    current,
    percent,
    dragging,
    min: low,
    max: high,
    step: stride,
    /** Pointer handlers for the track: drag anywhere on it. */
    trackProps: { ref: trackRef, onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag, onLostPointerCapture: endDrag },
    /** ARIA and keyboard props for the focusable handle. */
    handleProps: {
      ref: (node: HTMLElement | null) => {
        handleRef.current = node;
      },
      role: "slider" as const,
      tabIndex: disabled ? -1 : 0,
      "aria-label": label,
      "aria-valuemin": low,
      "aria-valuemax": high,
      "aria-valuenow": current,
      "aria-valuetext": formatValueText?.(current),
      "aria-disabled": disabled || undefined,
      onKeyDown,
    },
  };
}
