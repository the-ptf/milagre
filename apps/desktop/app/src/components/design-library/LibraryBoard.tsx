import { useCallback, useRef, useState } from "react";
import type { ArtifactRef } from "../../model";
import { DESIGN_MODE_LABELS } from "@milagre/shared/design-modes";
import { Segmented } from "../primitives/Segmented";
import { ZoomBar } from "../primitives/ZoomBar";
import { usePageDesignMode } from "../agents/design-mode";
import { ArtifactCanvas, type CanvasHandle, type CanvasView, type ChoiceControls, type PinControls } from "../agents/ArtifactCanvas";
import { LibraryEditContext, type LibraryEdit } from "../agents/DesignFrameMenu";

const NO_PINS: PinControls = {
  pins: [],
  sent: [],
  open: null,
  onPin: () => {},
  onOpen: () => {},
  onText: () => {},
  onRemove: () => {},
  onSend: () => {},
};
const NO_CHOICE: ChoiceControls = { sent: null, pending: null, onChoose: null };

/**
 * A library page's designs side by side on the Artifact panel's canvas, in library mode: each frame steps through its
 * versions, says who saved each, picks Light, Dark or Contrast, exports, renames, moves and removes it. When any design
 * on the page defines Dark or Contrast, one switch above the canvas sets the mode for all of them.
 */
export function LibraryBoard({
  projectKey,
  designs,
  focus,
  onEdit,
}: {
  projectKey: string;
  designs: ArtifactRef[];
  focus: { id: string | null; nonce: number };
  onEdit: LibraryEdit;
}) {
  const canvas = useRef<CanvasHandle>(null);
  const [view, setView] = useState<CanvasView | null>(null);
  const [versions, setVersions] = useState<Record<string, number | null>>({});
  const onVersion = useCallback((id: string, version: number | null) => setVersions((current) => ({ ...current, [id]: version })), []);
  const page = usePageDesignMode(
    projectKey,
    designs.map((design) => design.id),
  );
  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-slot="library-board">
      <LibraryEditContext value={onEdit}>
        <ArtifactCanvas
          ref={canvas}
          library
          chatId={projectKey}
          designs={designs}
          versions={versions}
          onVersion={onVersion}
          focus={focus}
          commenting={false}
          comments={NO_PINS}
          choice={NO_CHOICE}
          onView={setView}
        />
      </LibraryEditContext>
      {page.modes.length > 1 && (
        <div className="absolute top-3 right-3 z-20 rounded-control bg-surface p-1 shadow-raised" data-slot="library-page-mode">
          <Segmented
            label="Color mode for every design on this page"
            dataKey="library-mode"
            value={page.mode}
            options={page.modes.map((mode) => ({ value: mode, label: DESIGN_MODE_LABELS[mode] }))}
            onChange={page.setMode}
          />
        </div>
      )}
      <ZoomBar
        className="absolute bottom-4 left-1/2 -translate-x-1/2"
        zoom={view?.scale ?? null}
        onZoomOut={() => canvas.current?.zoomBy(1 / 1.25)}
        onReset={() => canvas.current?.zoomTo(1)}
        onZoomIn={() => canvas.current?.zoomBy(1.25)}
        onFit={() => canvas.current?.fitAll()}
        fitLabel="Fit the page"
      />
    </div>
  );
}
