import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DesignPageShare } from "@milagre/shared/artifact";
import { ipcErrorMessage } from "@milagre/shared/result";
import { bridgeForKey } from "../../lib/computer-bridge";
import { confirmDesignSharingAvailability } from "../../lib/design-sharing-available";
import { ScrollArea } from "../primitives/ScrollArea";
import { Button } from "../primitives/Button";
import { EmptyState } from "../primitives/EmptyState";
import { InlineError } from "../primitives/InlineError";
import { showToast } from "../../lib/toast";

const when = (share: DesignPageShare) =>
  `${share.updatedAt ? "Updated" : "Published"} ${new Date(share.updatedAt ?? share.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
const olderLinksNotice = (count = 0) =>
  count ? `${count === 1 ? "An older link" : `${count} older links`} could not be revoked yet. Revoke in Settings > Published pages.` : "";

/** A Chat page has one public link. Sharing again replaces the snapshot behind it; without a chatId this lists every
 * published page on this computer. A snapshot always holds the entire saved page, whatever version or selection is viewed. */
export function DesignPageShareDialog({ chatId, kind = "designs", onClose }: { chatId?: string | null; kind?: "designs" | "artifacts"; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(false);
  const working = useRef(false);
  const reads = useRef(0);
  const [shares, setShares] = useState<DesignPageShare[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [availability, setAvailability] = useState<{ available: boolean; reason?: string } | null>(null);
  const [checking, setChecking] = useState(true);
  const [revoke, setRevoke] = useState<string | null>(null);
  const current = chatId ? shares.find((share) => !share.revoked) : undefined;
  const api = bridgeForKey(chatId).artifacts;

  const load = useCallback(
    async (preserveError = false) => {
      const read = ++reads.current;
      try {
        const rows = await (chatId ? api.pageShares({ chatId, kind }) : api.allPageShares());
        if (alive.current && read === reads.current) {
          setShares(rows);
        }
      } catch (cause) {
        if (alive.current && read === reads.current) {
          setLoadFailed(true);
          if (!preserveError) setError(ipcErrorMessage(cause));
        }
      } finally {
        if (alive.current && read === reads.current) setLoading(false);
      }
    },
    [api, chatId, kind],
  );
  const checkAvailability = useCallback(async () => {
    setChecking(true);
    try {
      const status = await api.sharingStatus({ kind });
      if (alive.current) {
        setAvailability(status);
        if (chatId) confirmDesignSharingAvailability(chatId, status.available === true, kind);
      }
    } catch (cause) {
      if (alive.current) {
        setAvailability({ available: false, reason: ipcErrorMessage(cause) });
        if (chatId) confirmDesignSharingAvailability(chatId, false, kind);
      }
    } finally {
      if (alive.current) setChecking(false);
    }
  }, [api, chatId, kind]);
  useEffect(() => {
    alive.current = true;
    const element = dialog.current;
    element?.showModal();
    void load();
    if (chatId) void checkAvailability();
    return () => {
      alive.current = false;
      reads.current++;
      element?.close();
    };
  }, [load, chatId, checkAvailability]);

  async function publish() {
    if (!chatId || checking || !availability?.available || working.current || loading || loadFailed) return;
    const updating = !!current;
    working.current = true;
    setBusy("publish");
    setError("");
    setRevoke(null);
    try {
      const share = await api.sharePage({
        chatId,
        // The host names the page after its Chat; an older host still requires a title.
        title: current?.title ?? (kind === "artifacts" ? "Artifact" : "Designs"),
        acknowledgePublic: true,
        kind,
      });
      if (alive.current) {
        reads.current++;
        setShares([share]);
      }
      // Publishing copies the link right away: sharing it is what comes next.
      const copied = await navigator.clipboard.writeText(share.url).then(
        () => true,
        () => false,
      );
      showToast([updating ? "Snapshot updated." : "Published.", copied ? "Link copied." : "", olderLinksNotice(share.olderLinks)].filter(Boolean).join(" "));
    } catch (cause) {
      if (alive.current) {
        setError(ipcErrorMessage(cause));
        // The upload may have reached the service even if its acknowledgement was lost.
        await load(true);
      }
    } finally {
      working.current = false;
      if (alive.current) setBusy(null);
    }
  }
  async function revokeLink(id: string) {
    if (working.current) return;
    working.current = true;
    setBusy(id);
    setError("");
    try {
      if (chatId) await api.revokePageShare({ chatId, id, kind });
      else await api.revokeSavedPageShare({ id });
      if (alive.current) {
        reads.current++;
        // A Chat page drops its revoked link; the next Publish creates a new one. The global list keeps the row.
        setShares((rows) => (chatId ? rows.filter((row) => row.id !== id) : rows.map((row) => (row.id === id ? { ...row, revoked: true } : row))));
        setRevoke(null);
      }
      showToast("Link revoked. Copies may remain online.");
    } catch (cause) {
      if (alive.current) setError(ipcErrorMessage(cause));
    } finally {
      working.current = false;
      if (alive.current) setBusy(null);
    }
  }
  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      showToast("Link copied.");
    } catch {
      if (alive.current) setError("Could not copy the link. Select it and copy it.");
    }
  }
  const linkRow = (share: DesignPageShare) => (
    <div className="flex items-center gap-2 rounded-control bg-field p-1.5 pl-2 ring-1 ring-line">
      <a
        href={share.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open link for ${share.title}`}
        className="min-w-0 flex-1 select-text truncate px-1 text-12 text-ink-2 hover:underline"
      >
        {share.url}
      </a>
      <Button variant="secondary" size={28} onClick={() => void copy(share.url)}>
        Copy link
      </Button>
    </div>
  );
  const revokeControl = (share: DesignPageShare) =>
    revoke === share.id ? (
      <div className="w-full space-y-2">
        <p className="text-12 text-ink-2">Remove this page? Copies may remain online.</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size={28} disabled={!!busy} onClick={() => setRevoke(null)}>
            Cancel
          </Button>
          <Button variant="danger" size={28} data-slot="design-page-revoke-confirm" disabled={!!busy} onClick={() => void revokeLink(share.id)}>
            {busy === share.id ? "Revoking…" : "Revoke link"}
          </Button>
        </div>
      </div>
    ) : (
      <button
        type="button"
        className="h-6 text-12 text-ink-3 transition-colors hover:text-red-ink disabled:opacity-40"
        disabled={!!busy}
        onClick={() => setRevoke(share.id)}
      >
        Revoke link
      </button>
    );
  const savedPage = (share: DesignPageShare) => (
    <div data-share-id={share.id} className="space-y-2 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-13 font-medium">{share.title}</span>
        <span className="shrink-0 text-11 text-ink-3">
          {share.designCount}{" "}
          {share.kind === "artifacts" ? (share.designCount === 1 ? "artifact" : "artifacts") : share.designCount === 1 ? "design" : "designs"}
          {share.revoked ? " · Revoked" : ""}
        </span>
      </div>
      <p className="text-11 text-ink-3">{when(share)}</p>
      {share.pending && !share.revoked && <p className="text-12 text-ink-2">Not confirmed. The link may not work yet.</p>}
      {share.revoked ? (
        <p className="text-12 text-ink-3">Removed. Copies may remain online.</p>
      ) : (
        <>
          {linkRow(share)}
          {revokeControl(share)}
        </>
      )}
    </div>
  );
  const retryLoad = (
    <Button
      variant="secondary"
      size={28}
      onClick={() => {
        setLoading(true);
        setLoadFailed(false);
        setError("");
        void load();
      }}
      className="mt-3"
    >
      Retry
    </Button>
  );
  const messages = (
    <InlineError size={12} className="mt-3">
      {error}
    </InlineError>
  );
  return createPortal(
    <dialog
      ref={dialog}
      data-slot="design-page-share"
      aria-labelledby="design-page-share-title"
      aria-describedby="design-page-share-warning"
      onKeyDown={(event) => {
        // Escape belongs to this modal, never the Designs canvas beneath it.
        if (event.key === "Escape") event.stopPropagation();
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!working.current) onClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current && !working.current) onClose();
      }}
      className="m-auto w-[420px] max-w-[calc(100vw-32px)] overflow-hidden rounded-window bg-surface p-0 text-ink shadow-overlay backdrop:bg-scrim backdrop:backdrop-blur-overlay"
    >
      <div className="flex max-h-[calc(100vh-64px)] flex-col">
        <header className="flex shrink-0 items-center justify-between gap-3 px-5 pb-2 pt-5">
          <h2 id="design-page-share-title" className="text-17 font-semibold">
            {chatId ? "Share" : "Published pages"}
          </h2>
          <Button variant="ghost" size={24} disabled={!!busy} onClick={onClose}>
            Close
          </Button>
        </header>
        <ScrollArea className="px-5 pb-5 pt-1">
          {chatId ? (
            <>
              {current && (
                <div data-share-id={current.id} className="mb-4 space-y-2">
                  {linkRow(current)}
                  {current.pending && <p className="text-12 text-ink-2">Not confirmed yet. Update to retry.</p>}
                </div>
              )}
              <p id="design-page-share-warning" className="text-12 text-ink-3">
                {kind === "artifacts" ? "Anyone with the link can view it, hidden HTML included." : "Anyone with the link can view it."}
              </p>
              {checking ? (
                <p role="status" className="mt-3 text-12 text-ink-3">
                  Checking the sharing service…
                </p>
              ) : !availability?.available ? (
                <div className="mt-3 text-12" data-slot="design-page-unavailable">
                  <p className="text-ink-2">Publishing is unavailable. {availability?.reason && <span className="text-ink-3">{availability.reason}</span>}</p>
                  <button type="button" className="mt-1 h-6 text-accent disabled:opacity-40" disabled={!!busy} onClick={() => void checkAvailability()}>
                    Retry check
                  </button>
                </div>
              ) : null}
              <Button
                data-slot="design-page-publish"
                disabled={checking || !availability?.available || loading || loadFailed || !!busy}
                onClick={() => void publish()}
                className="mt-4 w-full"
              >
                {busy === "publish" ? (current ? "Updating…" : "Publishing…") : current ? "Update snapshot" : "Publish"}
              </Button>
              {current && (
                <div className="mt-3 flex min-h-7 items-center justify-between gap-3">
                  {revoke !== current.id && <span className="text-11 text-ink-3">{when(current)}</span>}
                  {revokeControl(current)}
                </div>
              )}
              {messages}
              {loading ? <p className="mt-3 text-12 text-ink-3">Loading…</p> : loadFailed && retryLoad}
            </>
          ) : (
            <>
              <p id="design-page-share-warning" className="text-12 text-ink-3">
                Anyone with a link can view its page.
              </p>
              {messages}
              {loading ? (
                <p className="mt-3 text-12 text-ink-3">Loading…</p>
              ) : loadFailed ? (
                retryLoad
              ) : shares.length ? (
                <ul className="mt-2 divide-y divide-line">
                  {shares.map((share) => (
                    <li key={share.id}>{savedPage(share)}</li>
                  ))}
                </ul>
              ) : (
                <EmptyState className="mt-2">No pages published yet.</EmptyState>
              )}
            </>
          )}
        </ScrollArea>
      </div>
    </dialog>,
    document.body,
  );
}
