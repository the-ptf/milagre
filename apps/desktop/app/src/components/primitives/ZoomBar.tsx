import type { HTMLAttributes } from "react";
import { FitToScreenIcon, MinusSignIcon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { IconButton } from "./Button";

/**
 * The floating zoom bar of a canvas, a pill: zoom out, the zoom (pressing it goes back to 100%), zoom in, and Fit,
 * each round with a Tooltip. The main Canvas, the artifact canvas and the Designs editor share it; each passes its own
 * actions, and `canZoomIn` / `canZoomOut` false at its limits. Extra props (a data attribute, a class to place it)
 * go on the bar.
 */
export function ZoomBar({
  zoom,
  onZoomOut,
  onZoomIn,
  onReset,
  onFit,
  canZoomIn = true,
  canZoomOut = true,
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
  canZoomIn?: boolean;
  canZoomOut?: boolean;
  /** The Fit button's accessible name and tooltip. */
  fitLabel?: string;
  /** Extra attributes for the zoom reading, e.g. a data-slot a check reads it by. */
  resetProps?: HTMLAttributes<HTMLButtonElement> & Record<`data-${string}`, string>;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={`flex items-center gap-0.5 rounded-full bg-surface p-1 shadow-raised ${className}`}>
      <IconButton label="Zoom out" icon={MinusSignIcon} size={28} shape="pill" disabled={!canZoomOut} onClick={onZoomOut} />
      <button
        {...resetProps}
        type="button"
        aria-label="Zoom to 100%"
        className="h-7 w-12 rounded-full text-center text-12 font-medium text-ink tabular-nums transition-colors hover:bg-hover"
        onClick={onReset}
      >
        {zoom === null ? "" : `${Math.round(zoom * 100)}%`}
      </button>
      <IconButton label="Zoom in" icon={PlusSignIcon} size={28} shape="pill" disabled={!canZoomIn} onClick={onZoomIn} />
      <span aria-hidden className="mx-0.5 h-4 w-px bg-line" />
      <IconButton label={fitLabel} icon={FitToScreenIcon} size={28} shape="pill" onClick={onFit} />
    </div>
  );
}
