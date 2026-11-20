import { useCallback, useRef, useState } from "react";
import type { ArtifactRef } from "../../model";
import { ZoomBar } from "../primitives/ZoomBar";
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
 * versions, says who saved each, picks Light, Dark or Contrast, exports, renames, moves and removes it.
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
