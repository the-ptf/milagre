import { useRef, useState } from "react";
import { Comment01Icon, Cursor01Icon } from "@hugeicons/core-free-icons";
import type { HtmlArtifact } from "@milagre/shared/artifact";
import type { ArtifactRef } from "../../model";
import Tooltip from "../primitives/Tooltip";
import { Icon } from "../primitives/Icon";
import { InlineError } from "../primitives/InlineError";
import { ZoomBar } from "../primitives/ZoomBar";
import { ArtifactCanvas, type CanvasHandle, type CanvasView } from "./ArtifactCanvas";
import { ArtifactPage, type PageHandle } from "./ArtifactPage";
import { CommentOptions } from "./CommentOptions";
import { COMMENT_KEY } from "./comment-key";
import type { DockFeedback } from "./dock-feedback";

export const commentLabel = (feedback: DockFeedback, page: "canvas" | "page") =>
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
  designs,
  versions,
  onVersion,
  focus,
  chosen,
  feedback,
  canComment,
  onShare,
}: {
  chatId: string;
  allowLive: boolean;
  designs: ArtifactRef[];
  versions: Record<string, number | null>;
  onVersion: (id: string, version: number | null) => void;
  focus: { id: string | null; nonce: number };
  chosen: { id: string; version: number } | null;
  feedback: DockFeedback;
  canComment: boolean;
  onShare?: (design: ArtifactRef) => void;
}) {
  const canvas = useRef<CanvasHandle>(null);
  const [view, setView] = useState<CanvasView | null>(null);
  const { commenting, toggleComment, choice, setChoice } = feedback;
  const label = commentLabel(feedback, "canvas");
  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-slot="artifact-dock-canvas">
      <ArtifactCanvas
        ref={canvas}
        allowLive={allowLive}
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
        onShare={onShare}
      />
      <ZoomBar
        data-slot="artifact-zoom-bar"
        className="absolute bottom-4 left-1/2 -translate-x-1/2"
        leading={
          <div role="group" aria-label="Canvas mode" className="flex items-center gap-0.5">
            <Tooltip label="View and try designs" asChild>
              <button
                type="button"
                data-slot="artifact-mode-view"
                aria-pressed={!commenting}
                onClick={() => commenting && toggleComment()}
                className={`flex h-7 items-center gap-1.5 rounded-full px-3 text-12 font-medium transition-colors ${commenting ? "text-ink-2 hover:bg-hover" : "bg-hover-2 text-ink"}`}
              >
                <Icon icon={Cursor01Icon} size={14} />
                View
              </button>
            </Tooltip>
            <CommentOptions shown={feedback.showResolved} onChange={feedback.setShowResolved}>
              <Tooltip label={`${label}. Right-click or hold for comment options`} keyHint={COMMENT_KEY} asChild>
                <button
                  type="button"
                  data-slot="artifact-mode-comment"
                  aria-label={label}
                  aria-pressed={commenting}
                  disabled={!canComment}
                  onClick={toggleComment}
                  className={`flex h-7 items-center gap-1.5 rounded-full px-3 text-12 font-medium transition-colors disabled:opacity-40 ${commenting ? "bg-accent-tint text-accent-ink" : "text-ink-2 enabled:hover:bg-hover"}`}
                >
                  <Icon icon={Comment01Icon} size={14} />
                  Comment
                </button>
              </Tooltip>
            </CommentOptions>
          </div>
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
