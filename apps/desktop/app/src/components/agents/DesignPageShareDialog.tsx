import { useState } from "react";
import type { DesignPageShare, PageShareScope } from "@milagre/shared/artifact";
import { shareNotice, shareStatusLine, shareTitle, shareTone } from "../../lib/page-share-status";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { InlineError } from "../primitives/InlineError";
import { ShareLinkRow, StopSharing } from "./page-share-parts";
import { PublishedPages } from "./PublishedPages";
import { usePageShare } from "./use-page-share";

const WORKSPACE: PageShareScope = { kind: "workspace" };
const DOTS = { green: "bg-green", red: "bg-red", muted: "bg-ink-4" } as const;

/**
 * Sharing from a Chat: the Artifact panel's whole workspace by default, or one design or the HTML page (`scope`). A link
 * is live: it follows the agent's saves until paused or taken down. Without a Chat, Settings › Published pages.
 */
export function DesignPageShareDialog({
  chatId,
  scope = WORKSPACE,
  revision = "",
  onClose,
}: {
  chatId?: string | null;
  scope?: PageShareScope;
  revision?: string;
  onClose: () => void;
}) {
  if (!chatId) return <PublishedPages onClose={onClose} />;
  return <ChatShare chatId={chatId} scope={scope} revision={revision} onClose={onClose} />;
}

function ChatShare({ chatId, scope, revision, onClose }: { chatId: string; scope: PageShareScope; revision: string; onClose: () => void }) {
  const state = usePageShare(chatId, scope, revision);
  const { share, busy, availability, checking, loading, loadFailed } = state;
  const canPublish = !checking && !!availability?.available && !loading && !loadFailed && !busy;
  return (
    <Dialog
      title={shareTitle(scope)}
      onClose={() => !state.working.current && onClose()}
      width={420}
      data-slot="design-page-share"
      aria-describedby="design-page-share-warning"
    >
      <div className="mt-3">
        {share && <SharedLink share={share} now={state.now} onError={state.setError} />}
        <p id="design-page-share-warning" className={`text-12 text-ink-3 ${share ? "mt-3" : ""}`}>
          {shareNotice(scope, !!share && !share.live)}
        </p>
        {checking ? (
          <p role="status" className="mt-3 text-12 text-ink-3">
            Checking the sharing service…
          </p>
        ) : !availability?.available ? (
          <div className="mt-3 text-12" data-slot="design-page-unavailable">
            <p className="text-ink-2">Publishing is unavailable. {availability?.reason && <span className="text-ink-3">{availability.reason}</span>}</p>
            <Button variant="link" size={24} className="mt-1 -ml-2" disabled={!!busy} onClick={() => void state.checkAvailability()}>
              Retry check
            </Button>
          </div>
        ) : null}
        {!share ? (
          <Button data-slot="design-page-publish" disabled={!canPublish} onClick={() => void state.publish()} className="mt-4 w-full">
            {busy === "publish" ? "Publishing…" : "Publish"}
          </Button>
        ) : (
          <ShareActions
            key={share.id}
            share={share}
            busy={busy}
            canPublish={canPublish}
            onPublish={() => void state.publish()}
            onPause={(paused) => void state.setPaused(paused)}
            onRevoke={() => void state.revoke()}
          />
        )}
        <InlineError size={12} className="mt-3">
          {state.error}
        </InlineError>
        {loading ? (
          <p className="mt-3 text-12 text-ink-3">Loading…</p>
        ) : (
          loadFailed && (
            <Button variant="secondary" size={28} onClick={state.retryLoad} className="mt-3">
              Retry
            </Button>
          )
        )}
      </div>
    </Dialog>
  );
}

function SharedLink({ share, now, onError }: { share: DesignPageShare; now: number; onError: (message: string) => void }) {
  return (
    <div data-share-id={share.id} className="space-y-2">
      <ShareLinkRow share={share} onError={onError} />
      <p data-slot="design-page-status" className="flex items-center gap-2 text-12 text-ink-2">
        <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${DOTS[shareTone(share)]}`} />
        {shareStatusLine(share, now)}
      </p>
      {share.pending && <p className="text-12 text-ink-2">Not confirmed yet. {share.live ? "Update now" : "Share again"} to retry.</p>}
    </div>
  );
}

function ShareActions({
  share,
  busy,
  canPublish,
  onPublish,
  onPause,
  onRevoke,
}: {
  share: DesignPageShare;
  busy: string | null;
  canPublish: boolean;
  onPublish: () => void;
  onPause: (paused: boolean) => void;
  onRevoke: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const updatable = share.paused || share.stale || share.pending;
  return (
    <div className="mt-4 flex min-h-7 flex-wrap items-center gap-2">
      {!confirming &&
        (share.live ? (
          <>
            <Button variant="secondary" size={28} data-slot="design-page-pause" disabled={!!busy} onClick={() => onPause(!share.paused)}>
              {busy === "pause" ? (share.paused ? "Resuming…" : "Pausing…") : share.paused ? "Resume" : "Pause"}
            </Button>
            {updatable && (
              <Button variant="secondary" size={28} data-slot="design-page-publish" disabled={!canPublish} onClick={onPublish}>
                {busy === "publish" ? "Updating…" : "Update now"}
              </Button>
            )}
          </>
        ) : (
          <Button size={28} data-slot="design-page-publish" disabled={!canPublish} onClick={onPublish}>
            {busy === "publish" ? "Sharing…" : "Share again"}
          </Button>
        ))}
      <div className={confirming ? "w-full" : "ml-auto"}>
        <StopSharing
          confirming={confirming}
          busy={busy === "revoke"}
          disabled={!!busy}
          onAsk={() => setConfirming(true)}
          onCancel={() => setConfirming(false)}
          onConfirm={onRevoke}
        />
      </div>
    </div>
  );
}
