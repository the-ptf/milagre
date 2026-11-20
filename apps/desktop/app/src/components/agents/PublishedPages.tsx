import { useCallback, useEffect, useRef, useState } from "react";
import type { DesignPageShare } from "@milagre/shared/artifact";
import { ipcErrorMessage } from "@milagre/shared/result";
import { bridgeForKey } from "../../lib/computer-bridge";
import { scopeLabel, shareState } from "../../lib/page-share-status";
import { showToast } from "../../lib/toast";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { EmptyState } from "../primitives/EmptyState";
import { InlineError } from "../primitives/InlineError";
import { ShareLinkRow, StopSharing } from "./page-share-parts";

const when = (share: DesignPageShare) =>
  `${share.updatedAt ? "Updated" : "Published"} ${new Date(share.updatedAt ?? share.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;

/** Settings › Published pages: every link this computer published, with what each shows and where it stands. */
export function PublishedPages({ onClose }: { onClose: () => void }) {
  const alive = useRef(false);
  const working = useRef(false);
  const api = bridgeForKey(null).artifacts;
  const [shares, setShares] = useState<DesignPageShare[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const rows = await api.allPageShares();
      if (alive.current) setShares(rows);
    } catch (cause) {
      if (alive.current) {
        setLoadFailed(true);
        setError(ipcErrorMessage(cause));
      }
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);
  async function stop(id: string) {
    if (working.current) return;
    working.current = true;
    setBusy(id);
    setError("");
    try {
      await api.revokeSavedPageShare({ id });
      if (alive.current) {
        setShares((rows) => rows.map((row) => (row.id === id ? { ...row, revoked: true } : row)));
        setConfirm(null);
      }
      showToast("Stopped sharing. Copies may remain online.");
    } catch (cause) {
      if (alive.current) setError(ipcErrorMessage(cause));
    } finally {
      working.current = false;
      if (alive.current) setBusy(null);
    }
  }
  const row = (share: DesignPageShare) => (
    <div data-share-id={share.id} data-share-state={shareState(share)} className="space-y-2 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-13 font-medium">{share.title}</span>
        <span data-slot="design-page-scope" className="shrink-0 text-11 text-ink-3">
          {scopeLabel(share)} · {shareState(share)}
        </span>
      </div>
      <p className="text-11 text-ink-3">{when(share)}</p>
      {share.pending && !share.revoked && <p className="text-12 text-ink-2">Not confirmed. The link may not work yet.</p>}
      {share.revoked ? (
        <p className="text-12 text-ink-3">Removed. Copies may remain online.</p>
      ) : (
        <>
          <ShareLinkRow share={share} onError={setError} />
          <StopSharing
            confirming={confirm === share.id}
            busy={busy === share.id}
            disabled={!!busy}
            onAsk={() => setConfirm(share.id)}
            onCancel={() => setConfirm(null)}
            onConfirm={() => void stop(share.id)}
          />
        </>
      )}
    </div>
  );
  return (
    <Dialog
      title="Published pages"
      onClose={() => !working.current && onClose()}
      width={420}
      data-slot="design-page-share"
      aria-describedby="design-page-share-warning"
    >
      <div className="mt-3">
        <p id="design-page-share-warning" className="text-12 text-ink-3">
          Anyone with a link can view its page.
        </p>
        <InlineError size={12} className="mt-3">
          {error}
        </InlineError>
        {loading ? (
          <p className="mt-3 text-12 text-ink-3">Loading…</p>
        ) : loadFailed ? (
          <Button
            variant="secondary"
            size={28}
            className="mt-3"
            onClick={() => {
              setLoading(true);
              setLoadFailed(false);
              setError("");
              void load();
            }}
          >
            Retry
          </Button>
        ) : shares.length ? (
          <ul className="mt-2 divide-y divide-line">
            {shares.map((share) => (
              <li key={share.id}>{row(share)}</li>
            ))}
          </ul>
        ) : (
          <EmptyState size="compact" title="No pages published yet" />
        )}
      </div>
    </Dialog>
  );
}
