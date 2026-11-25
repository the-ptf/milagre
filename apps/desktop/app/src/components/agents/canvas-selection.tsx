import { createContext, useContext, useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Cancel01Icon, Presentation01Icon } from "@hugeicons/core-free-icons";
import { MAX_SHARED_SELECTION } from "@milagre/shared/artifact";
import type { ArtifactRef } from "../../model";
import { Button, IconButton } from "../primitives/Button";
import { Icon } from "../primitives/Icon";

/** The designs picked on a Chat's canvas to share as one presentation, in the order they were picked. */
export type CanvasSelection = { ids: readonly string[]; toggle: (id: string) => void; clear: () => void };

export const CanvasSelectionContext = createContext<CanvasSelection | null>(null);

export function useCanvasSelection(designs: readonly ArtifactRef[]): CanvasSelection {
  const [picked, setPicked] = useState<string[]>([]);
  const ids = useMemo(() => {
    const present = new Set(designs.map((design) => design.id));
    return picked.filter((id) => present.has(id));
  }, [designs, picked]);
  return useMemo(
    () => ({
      ids,
      toggle: (id: string) =>
        setPicked((current) =>
          current.includes(id) ? current.filter((item) => item !== id) : current.length < MAX_SHARED_SELECTION ? [...current, id] : current,
        ),
      clear: () => setPicked([]),
    }),
    [ids],
  );
}

/** The canvas's selection, or null where designs can't be picked (the Design library, or sharing unavailable). */
export const useSelection = () => useContext(CanvasSelectionContext);

/** Where a design stands in the selection: 1 for the first picked, 0 when it isn't picked. */
export const useSelectionOrder = (id: string) => (useSelection()?.ids.indexOf(id) ?? -1) + 1;

/** Shift- or Command-click on a design's frame adds it to the selection or takes it out. True when the click was a pick. */
function pickFrame(selection: CanvasSelection | null, event: ReactPointerEvent<HTMLElement>): boolean {
  if (!selection || event.button !== 0 || !(event.shiftKey || event.metaKey)) return false;
  const target = event.target as HTMLElement;
  if (target.closest("button, textarea, input")) return false;
  const id = target.closest<HTMLElement>("[data-slot=artifact-frame]")?.dataset.artifact;
  if (!id) return false;
  event.preventDefault();
  selection.toggle(id);
  return true;
}

/** Wraps the canvas's pointer-down so a Shift- or Command-click on a frame picks it before anything else sees it. */
export function usePickFirst<T extends HTMLElement>(handler: (event: ReactPointerEvent<T>) => void) {
  const selection = useSelection();
  return (event: ReactPointerEvent<T>) => {
    if (!pickFrame(selection, event)) handler(event);
  };
}

/** A design's border on the canvas: accent while in use or picked, ink when chosen. */
export const frameBorder = (active: boolean, order: number, chosen: boolean) =>
  active || order ? "border-accent" : chosen ? "border-ink" : "border-transparent";

export function SelectionOrder({ order }: { order: number }) {
  if (!order) return null;
  return (
    <span
      data-slot="artifact-selection-order"
      aria-label={`Screen ${order} of the presentation`}
      className="flex size-5 shrink-0 items-center justify-center rounded-full bg-accent text-11 font-semibold text-on-accent tabular-nums"
    >
      {order}
    </span>
  );
}

/** Over the canvas while designs are picked: how many, share them as a presentation, or clear. Escape clears too. */
export function SelectionBar({ selection, onShare }: { selection: CanvasSelection; onShare?: (ids: string[]) => void }) {
  const count = selection.ids.length;
  const { clear } = selection;
  useEffect(() => {
    if (!count) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector("dialog[open], [role=menu]")) return;
      event.preventDefault();
      clear();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [count, clear]);
  if (!count) return null;
  return (
    <div
      data-slot="artifact-selection-bar"
      role="toolbar"
      aria-label="Selected designs"
      className="absolute top-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full bg-surface py-1 pr-1 pl-3 text-13 whitespace-nowrap shadow-raised"
    >
      <span className="font-medium text-ink tabular-nums">{count === 1 ? "1 screen" : `${count} screens`}</span>
      <span className="text-ink-3 @max-[640px]:hidden">Shift-click to add or remove</span>
      {onShare && (
        <Button size={28} shape="pill" data-slot="artifact-share-selection" onClick={() => onShare([...selection.ids])}>
          <Icon icon={Presentation01Icon} size={14} />
          Share presentation…
        </Button>
      )}
      <IconButton label="Clear the selection" icon={Cancel01Icon} size={28} shape="pill" onClick={clear} />
    </div>
  );
}
