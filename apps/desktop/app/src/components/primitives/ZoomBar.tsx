import type { HTMLAttributes } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { FitToScreenIcon, MinusSignIcon, PlusSignIcon } from "@hugeicons/core-free-icons";

/**
 * The floating zoom bar of a canvas: zoom out, the zoom (pressing it goes back to 100%), zoom in, and Fit. The main
 * Canvas and the Designs canvas share it; each passes its own actions. Extra props (a data attribute, a class to place
 * it) go on the bar.
 */
export function ZoomBar({
  zoom,
  onZoomOut,
  onZoomIn,
  onReset,
  onFit,
  fitLabel = "Fit everything",
  resetProps,
  className = "",
  ...props
}: {
  /** The zoom as a fraction (1 is 100%), or null before the canvas has one. */
  zoom: number | null;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onReset: () => void;
  onFit: () => void;
  /** The Fit button's accessible name. */
  fitLabel?: string;
  /** Extra attributes for the zoom reading, e.g. a data-slot a check reads it by. */
  resetProps?: HTMLAttributes<HTMLButtonElement> & Record<`data-${string}`, string>;
} & HTMLAttributes<HTMLDivElement>) {
  const button = "flex size-8 items-center justify-center text-ink-2 transition-colors hover:text-ink";
  return (
    <div {...props} className={`flex h-8 items-center rounded-control bg-surface shadow-card ${className}`}>
      <button type="button" aria-label="Zoom out" className={button} onClick={onZoomOut}>
        <HugeiconsIcon icon={MinusSignIcon} size={14} strokeWidth={1.8} color="currentColor" />
      </button>
      <button
        {...resetProps}
        type="button"
        aria-label="Zoom to 100%"
        className="w-11 text-center text-[12px] font-medium text-ink tabular-nums"
        onClick={onReset}
      >
        {zoom === null ? "" : `${Math.round(zoom * 100)}%`}
      </button>
      <button type="button" aria-label="Zoom in" className={button} onClick={onZoomIn}>
        <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={1.8} color="currentColor" />
      </button>
      <span className="h-4 w-px bg-line" />
      <button
        type="button"
        aria-label={fitLabel}
        className="flex h-8 items-center gap-1.5 px-2.5 text-[12px] font-medium text-ink transition-colors hover:text-ink-2"
        onClick={onFit}
      >
        <HugeiconsIcon icon={FitToScreenIcon} size={13} strokeWidth={1.8} color="currentColor" />
        Fit
      </button>
    </div>
  );
}
