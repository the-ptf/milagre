import { useRef, useState } from "react";
import { Comment01Icon } from "@hugeicons/core-free-icons";
import type { HtmlArtifact } from "@milagre/shared/artifact";
import type { ArtifactRef } from "../../model";
import { InlineError } from "../primitives/InlineError";
import { ZoomBar } from "../primitives/ZoomBar";
import { ArtifactCanvas, type CanvasHandle, type CanvasView } from "./ArtifactCanvas";
import { ArtifactPage, type PageHandle } from "./ArtifactPage";
import { CanvasToolButton, CanvasTools } from "./CanvasTools";
import { CommentOptions } from "./CommentOptions";
import { COMMENT_KEY } from "./comment-key";
import type { DockFeedback, DockPage } from "./dock-feedback";

export const commentLabel = (feedback: DockFeedback, page: DockPage) =>
  feedback.commenting ? "Stop commenting" : page === "page" ? "Comment on the page" : "Comment on a design";

export function PageBody({
  chatId,
  page,
  error,
  tab,
  onTab,
  feedback,
  canComment,
  onEscape,
}: {
  chatId: string;
  page: HtmlArtifact | null;
  error: string | null;
  tab: string | null;
  onTab: (id: string) => void;
  feedback: DockFeedback;
  canComment: boolean;
  onEscape: () => void;
}) {
  const view = useRef<PageHandle>(null);
  const [scale, setScale] = useState<number | null>(null);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-slot="artifact-dock-page">
      {page ? (
        <ArtifactPage
          ref={view}
          chatId={chatId}
          page={page}
          tabId={tab}
          onTab={onTab}
          commenting={feedback.commenting && canComment}
          comments={feedback.controls}
          numbers={feedback.numbers}
          reveal={feedback.reveal}
          onScale={setScale}
          onToggleComment={() => canComment && feedback.toggleComment()}
          onEscape={onEscape}
        />
      ) : (
        <p role="status" data-slot="artifact-page" className="min-h-0 flex-1 bg-paper p-4 text-12 text-ink-3">
          {error || "Loading artifact…"}
        </p>
      )}
      <ZoomBar
        data-slot="artifact-zoom-bar"
        className="absolute bottom-4 left-4"
        zoom={page ? scale : null}
        onZoomOut={() => view.current?.zoomBy(1 / 1.25)}
        onReset={() => view.current?.zoomTo(1)}
        onZoomIn={() => view.current?.zoomBy(1.25)}
        onFit={() => view.current?.fit()}
        fitLabel="Fit the page"
        resetProps={{ "data-slot": "artifact-zoom" }}
      />
      <InlineError variant="floating" className="absolute right-4 bottom-4">
        {feedback.error}
      </InlineError>
    </div>
  );
}

export function CanvasBody({
  chatId,
  allowLive,
  library = false,
  designs,
  versions,
  onVersion,
  focus,
  chosen,
  feedback,
  canComment,
  onShare,
  onAddToLibrary,
}: {
  chatId: string;
  allowLive: boolean;
  /** A page of the Project library: no comments, choices or live drafts. */
  library?: boolean;
  designs: ArtifactRef[];
  versions: Record<string, number | null>;
  onVersion: (id: string, version: number | null) => void;
  focus: { id: string | null; nonce: number };
  chosen: { id: string; version: number } | null;
  feedback: DockFeedback;
  canComment: boolean;
  onShare?: (design: ArtifactRef) => void;
  onAddToLibrary?: (design: ArtifactRef) => void;
}) {
  const canvas = useRef<CanvasHandle>(null);
  const [view, setView] = useState<CanvasView | null>(null);
  const { toggleComment, choice, setChoice } = feedback;
  const commenting = feedback.commenting && canComment;
  const label = commentLabel(feedback, "canvas");
  const [hand, setHand] = useState(false);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-slot="artifact-dock-canvas">
      <ArtifactCanvas
        ref={canvas}
        allowLive={allowLive}
        library={library}
        chatId={chatId}
        designs={designs}
        versions={versions}
        onVersion={onVersion}
        focus={focus}
        commenting={commenting}
        comments={feedback.controls}
        choice={{
          sent: chosen,
          pending: choice,
          onChoose: canComment ? (design) => setChoice((current) => (current?.id === design.id && current.version === design.version ? null : design)) : null,
        }}
        onView={setView}
        hand={hand && !commenting}
        onShare={onShare}
        onAddToLibrary={onAddToLibrary}
      />
      <ZoomBar
        data-slot="artifact-zoom-bar"
        className="absolute bottom-4 left-1/2 -translate-x-1/2"
        leading={
          <CanvasTools
            tool={commenting ? "comment" : hand ? "hand" : "pointer"}
            onTool={(tool) => {
              setHand(tool === "hand");
              if (commenting !== (tool === "comment")) toggleComment();
            }}
            comment={
              <CommentOptions shown={feedback.showResolved} onChange={feedback.setShowResolved}>
                <CanvasToolButton
                  label={label}
                  tip={`${label}. Right-click or hold for comment options`}
                  keyHint={COMMENT_KEY}
                  icon={Comment01Icon}
                  pressed={commenting}
                  tone="accent"
                  slot="artifact-mode-comment"
                  disabled={!canComment}
                  onClick={toggleComment}
                />
              </CommentOptions>
            }
          />
        }
        zoom={view?.scale ?? null}
        onZoomOut={() => canvas.current?.zoomBy(1 / 1.25)}
        onReset={() => canvas.current?.zoomTo(1)}
        onZoomIn={() => canvas.current?.zoomBy(1.25)}
        onFit={() => canvas.current?.fitAll()}
        fitLabel="Fit every design"
        resetProps={{ "data-slot": "artifact-zoom" }}
      />
    </div>
  );
}
