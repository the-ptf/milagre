import { useCallback, useMemo, useRef, useState } from "react";
import type { DesignLibraryEntry } from "@milagre/shared/artifact";
import type { ArtifactRef } from "../../model";
import { ZoomBar } from "../primitives/ZoomBar";
import { ArtifactCanvas, type CanvasHandle, type CanvasView, type ChoiceControls, type PinControls } from "../agents/ArtifactCanvas";

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
 * One library design large on the Artifact panel's canvas, in library mode: its frame steps through versions, says who
 * saved each, picks Light, Dark or Contrast, exports and deletes it.
 */
export function LibraryDesignView({ projectKey, design }: { projectKey: string; design: DesignLibraryEntry }) {
  const canvas = useRef<CanvasHandle>(null);
  const [view, setView] = useState<CanvasView | null>(null);
  const [versions, setVersions] = useState<Record<string, number | null>>({});
  const refs = useMemo<ArtifactRef[]>(
    () => [{ id: design.id, version: design.version, title: design.title, format: "design", ...(design.group ? { group: design.group } : {}) }],
    [design.id, design.version, design.title, design.group],
  );
  const [focus] = useState(() => ({ id: design.id, nonce: 1 }));
  const onVersion = useCallback((id: string, version: number | null) => setVersions((current) => ({ ...current, [id]: version })), []);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-slot="library-design-view">
      <ArtifactCanvas
        ref={canvas}
        library
        chatId={projectKey}
        designs={refs}
        versions={versions}
        onVersion={onVersion}
        focus={focus}
        commenting={false}
        comments={NO_PINS}
        choice={NO_CHOICE}
        onView={setView}
      />
      <ZoomBar
        className="absolute bottom-4 left-1/2 -translate-x-1/2"
        zoom={view?.scale ?? null}
        onZoomOut={() => canvas.current?.zoomBy(1 / 1.25)}
        onReset={() => canvas.current?.zoomTo(1)}
        onZoomIn={() => canvas.current?.zoomBy(1.25)}
        onFit={() => canvas.current?.fitAll()}
        fitLabel="Fit the design"
      />
    </div>
  );
}
