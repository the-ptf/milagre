import type { HTMLAttributes, ReactNode } from "react";
import { FitToScreenIcon, MinusSignIcon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { IconButton } from "./Button";

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
  leading,
  className = "",
  children: _children,
  ...props
}: {
  zoom: number | null;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onReset: () => void;
  onFit: () => void;
  canZoomIn?: boolean;
  canZoomOut?: boolean;
  fitLabel?: string;
  resetProps?: HTMLAttributes<HTMLButtonElement> & Record<`data-${string}`, string>;
  leading?: ReactNode;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={`flex items-center gap-0.5 rounded-full bg-surface p-1 shadow-raised ${className}`}>
      {leading && (
        <>
          {leading}
          <span aria-hidden className="mx-0.5 h-4 w-px bg-line" />
        </>
      )}
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
