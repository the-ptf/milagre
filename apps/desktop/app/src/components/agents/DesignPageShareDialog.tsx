import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DesignPageShare } from "@milagre/shared/artifact";
import { ipcErrorMessage } from "@milagre/shared/result";
import { bridgeForKey } from "../../lib/computer-bridge";
import { confirmDesignSharingAvailability } from "../../lib/design-sharing-available";
import { ScrollArea } from "../primitives/ScrollArea";

const button = "rounded-[8px] border border-line px-3 py-1.5 text-[12px] hover:bg-hover disabled:opacity-40";

/** A public snapshot always contains the entire saved Designs page, regardless of the viewed version or selection. */
export function DesignPageShareDialog({ chatId, kind = "designs", onClose }: { chatId?: string | null; kind?: "designs" | "artifacts"; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(false);
  const working = useRef(false);
  const reads = useRef(0);
  const [title, setTitle] = useState(kind === "artifacts" ? "Artifact" : "Designs");
  const [shares, setShares] = useState<DesignPageShare[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [availability, setAvailability] = useState<{ available: boolean; reason?: string } | null>(null);
  const [checking, setChecking] = useState(true);
  const [revoke, setRevoke] = useState<string | null>(null);
  const [publishedId, setPublishedId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const featured = shares.find((share) => share.id === publishedId);
  const history = shares.filter((share) => share.id !== publishedId);
  const showHistory = !chatId || historyOpen || !!error || history.some((share) => share.pending && !share.revoked);
  const api = bridgeForKey(chatId).artifacts;

  const load = useCallback(
    async (preserveError = false) => {
      const read = ++reads.current;
      try {
        const rows = await (chatId ? api.pageShares({ chatId, kind }) : api.allPageShares());
        if (alive.current && read === reads.current) {
          setShares(rows);
          if (rows.some((share) => share.pending && !share.revoked)) setHistoryOpen(true);
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
    if (!chatId || checking || !availability?.available || working.current || loading || loadFailed || !title.trim()) return;
    working.current = true;
    setBusy("publish");
    setError("");
    setNotice("");
    try {
      const share = await api.sharePage({
        chatId,
        title: title.trim(),
        acknowledgePublic: true,
        kind,
      });
      if (alive.current) {
        setShares((rows) => [share, ...rows.filter((row) => row.id !== share.id)]);
        if (!share.pending) {
          setPublishedId(share.id);
          setHistoryOpen(false);
        } else setHistoryOpen(true);
        setNotice(share.pending ? "Publication not confirmed. Check the link before publishing again." : "");
      }
    } catch (cause) {
      if (alive.current) {
        setError(ipcErrorMessage(cause));
        // The upload may have reached the service even if its acknowledgement was lost.
        await load(true);
        setHistoryOpen(true);
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
    setNotice("");
    try {
      if (chatId) await api.revokePageShare({ chatId, id, kind });
      else await api.revokeSavedPageShare({ id });
      if (alive.current) {
        setShares((rows) => rows.map((row) => (row.id === id ? { ...row, revoked: true } : row)));
        setRevoke(null);
        setNotice("Hosted page removed. Copies may remain online.");
      }
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
      if (alive.current) setNotice("Link copied.");
    } catch {
      if (alive.current) setError("Could not copy the link. Select the link below and copy it.");
    }
  }
  const shareDetails = (share: DesignPageShare, prominent = false) => (
    <div data-share-id={share.id} className={prominent ? "space-y-3" : "space-y-2 py-3"}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-[13px] font-medium">{share.title}</span>
        <span className="shrink-0 text-[11px] text-ink-3">
          {share.designCount}{" "}
          {share.kind === "artifacts" ? (share.designCount === 1 ? "artifact" : "artifacts") : share.designCount === 1 ? "design" : "designs"}
          {share.revoked ? " · Revoked" : ""}
        </span>
      </div>
      {!prominent && <p className="text-[11px] text-ink-3">{new Date(share.createdAt).toLocaleString()}</p>}
      {share.pending && !share.revoked && <p className="text-[12px] text-ink-2">Publication not confirmed. Check this link before publishing again.</p>}
      {share.revoked ? (
        <p className="text-[12px] text-ink-3">Hosted page removed. Copies may remain online.</p>
      ) : (
        <>
          <div className="flex items-center gap-2 rounded-control bg-field p-2 ring-1 ring-line">
            <a
              href={share.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open link for ${share.title}`}
              className="min-w-0 flex-1 select-text truncate px-1 text-[12px] text-ink-2 hover:underline"
            >
              {share.url}
            </a>
            <button
              type="button"
              className="shrink-0 rounded-control bg-ink px-3 py-2 text-[12px] font-medium text-surface"
              onClick={() => void copy(share.url)}
            >
              Copy link
            </button>
          </div>
          {revoke === share.id ? (
            <div className="space-y-2">
              <p className="text-[12px] text-ink-2">Remove this hosted page? Copies may remain online.</p>
              <div className="flex justify-end gap-2">
                <button type="button" className={button} disabled={!!busy} onClick={() => setRevoke(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  data-slot="design-page-revoke-confirm"
                  className={`${button} text-red`}
                  disabled={!!busy}
                  onClick={() => void revokeLink(share.id)}
                >
                  {busy === share.id ? "Revoking..." : "Revoke link"}
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="text-[12px] text-ink-3 hover:text-red disabled:opacity-40" disabled={!!busy} onClick={() => setRevoke(share.id)}>
              Revoke link
            </button>
          )}
        </>
      )}
    </div>
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
      className="m-auto w-[440px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[14px] bg-surface p-0 text-ink shadow-overlay backdrop:bg-black/20 backdrop:backdrop-blur-overlay"
    >
      <div className="flex max-h-[calc(100vh-64px)] flex-col">
        <header className="flex shrink-0 items-center justify-between gap-3 px-5 pb-2 pt-5">
          <h2 id="design-page-share-title" className="text-[17px] font-semibold">
            {!chatId ? "Published pages" : featured ? (featured.revoked ? "Snapshot removed" : "Snapshot shared") : "Share a snapshot"}
          </h2>
          <button type="button" className="text-[12px] text-ink-3 hover:text-ink disabled:opacity-40" disabled={!!busy} onClick={onClose}>
            Close
          </button>
        </header>
        <ScrollArea className="px-5 pb-5 pt-1">
          {chatId && (
            <p className="mb-4 text-[13px] leading-5 text-ink-2">
              {featured
                ? "This snapshot stays frozen. Later edits stay private."
                : kind === "artifacts"
                  ? "A frozen copy of this Chat's saved artifact page. Later edits stay private."
                  : "A frozen copy of every saved design on this page. Later edits stay private."}
            </p>
          )}
          {featured && shareDetails(featured, true)}
          <div id="design-page-share-warning" className={`${featured ? "mt-4" : ""} space-y-1 text-[12px] leading-5`}>
            <p className="font-medium text-ink">Public access</p>
            <p className="text-ink-2">Anyone with the link can view, copy or redistribute it. Copies may remain online permanently.</p>
            {chatId && (
              <p className="text-ink-3">
                {kind === "artifacts"
                  ? "Comments and Chat messages stay private. The full saved HTML, including hidden content, is shared. External resources are blocked."
                  : "Unsaved edits, comments and Chat messages stay private. Shared files can include content clipped by frames."}
              </p>
            )}
          </div>
          {chatId && !featured && (
            <>
              <label htmlFor="design-page-share-name" className="mb-2 mt-4 block text-[12px] text-ink-2">
                Page title
              </label>
              <input
                id="design-page-share-name"
                autoFocus
                value={title}
                maxLength={120}
                disabled={!!busy}
                onChange={(event) => setTitle(event.target.value)}
                className="h-9 w-full rounded-control bg-field px-2.5 text-[13px] outline-none ring-1 ring-line-strong focus-visible:ring-accent"
              />
              {checking ? (
                <p role="status" className="mt-3 text-[12px] text-ink-3">
                  Checking publishing availability...
                </p>
              ) : !availability?.available ? (
                <div className="mt-3 text-[12px]" data-slot="design-page-unavailable">
                  <p className="text-ink-2">Publishing is unavailable</p>
                  {availability?.reason && <p className="mt-1 text-ink-3">{availability.reason}</p>}
                  <button type="button" className="mt-2 text-accent disabled:opacity-40" disabled={!!busy} onClick={() => void checkAvailability()}>
                    Retry check
                  </button>
                </div>
              ) : null}
              <button
                type="button"
                data-slot="design-page-publish"
                disabled={checking || !availability?.available || loading || loadFailed || !!busy || !title.trim()}
                onClick={() => void publish()}
                className="mt-4 w-full rounded-control bg-ink px-3 py-2.5 text-[13px] font-medium text-surface disabled:opacity-40"
              >
                {busy === "publish" ? "Publishing..." : "Publish snapshot"}
              </button>
            </>
          )}
          {featured && (
            <button
              type="button"
              className={`${button} mt-4 w-full`}
              disabled={!!busy}
              onClick={() => {
                setPublishedId(null);
                setNotice("");
              }}
            >
              Publish another snapshot
            </button>
          )}
          {!!error && (
            <p role="alert" className="mt-3 text-[12px] text-red">
              {error}
            </p>
          )}
          {!!notice && (
            <p role="status" className="mt-3 text-[12px] text-ink-2">
              {notice}
            </p>
          )}
          {loading ? (
            <p className="mt-3 text-[12px] text-ink-3">Loading snapshots...</p>
          ) : loadFailed ? (
            <button
              type="button"
              onClick={() => {
                setLoading(true);
                setLoadFailed(false);
                setError("");
                setHistoryOpen(true);
                void load();
              }}
              className={`${button} mt-3`}
            >
              Retry
            </button>
          ) : history.length ? (
            <section className="mt-4 border-t border-line pt-3">
              {chatId ? (
                <button
                  type="button"
                  data-slot="design-page-history-toggle"
                  aria-expanded={showHistory}
                  className="flex w-full items-center justify-between text-left text-[12px] text-ink-2"
                  onClick={() => setHistoryOpen((open) => !open)}
                >
                  <span>Published snapshots ({history.length})</span>
                  <span aria-hidden>{showHistory ? "−" : "+"}</span>
                </button>
              ) : (
                <h3 className="text-[13px] font-medium">Published snapshots</h3>
              )}
              {showHistory && (
                <ul className="mt-2 divide-y divide-line">
                  {history.map((share) => (
                    <li key={share.id}>{shareDetails(share)}</li>
                  ))}
                </ul>
              )}
            </section>
          ) : (
            !chatId && <p className="mt-4 text-[12px] text-ink-3">No snapshots published yet.</p>
          )}
        </ScrollArea>
      </div>
    </dialog>,
    document.body,
  );
}
