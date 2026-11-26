import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesignPageShare, PageShareScope } from "@milagre/shared/artifact";
import { ipcErrorMessage } from "@milagre/shared/result";
import { bridgeForKey } from "../../lib/computer-bridge";
import { confirmDesignSharingAvailability } from "../../lib/design-sharing-available";
import { showToast } from "../../lib/toast";
import { olderLinksNotice } from "./page-share-parts";

const REREAD_EVERY = 2000;
const REREADS = 10;
const TICK = 30_000;

export type PageShareBusy = "publish" | "pause" | "revoke" | null;

const scopeOf = (scope: PageShareScope): PageShareScope => ({
  kind: scope.kind ?? "workspace",
  ...(scope.designId ? { designId: scope.designId } : {}),
  ...(scope.designIds ? { designIds: scope.designIds } : {}),
});

/**
 * One scope's link in a Chat, kept current while the Share dialog is open: read again whenever the Chat's artifacts
 * change (`revision`), then every few seconds until the host has republished it, and `now` ticks so "updated 2 min
 * ago" stays true.
 */
export function usePageShare(chatId: string, scope: PageShareScope, revision: string) {
  const selected = scope.designIds?.join(",");
  const request = useMemo(
    () => scopeOf({ kind: scope.kind, designId: scope.designId, designIds: selected ? selected.split(",") : undefined }),
    [scope.kind, scope.designId, selected],
  );
  const api = bridgeForKey(chatId).artifacts;
  const alive = useRef(false);
  const working = useRef(false);
  const reads = useRef(0);
  const [share, setShare] = useState<DesignPageShare | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<PageShareBusy>(null);
  const [error, setError] = useState("");
  const [availability, setAvailability] = useState<{ available: boolean; reason?: string } | null>(null);
  const [checking, setChecking] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const shareRef = useRef(share);
  shareRef.current = share;

  const load = useCallback(
    async (quiet = false) => {
      const read = ++reads.current;
      try {
        const rows = await api.pageShares({ chatId, ...request });
        if (alive.current && read === reads.current) {
          setShare(rows.find((row) => !row.revoked) ?? null);
          setLoadFailed(false);
          setNow(Date.now());
        }
      } catch (cause) {
        if (alive.current && read === reads.current && !quiet) {
          setLoadFailed(true);
          setError(ipcErrorMessage(cause));
        }
      } finally {
        if (alive.current && read === reads.current) setLoading(false);
      }
    },
    [api, chatId, request],
  );
  const checkAvailability = useCallback(async () => {
    setChecking(true);
    try {
      const status = await api.sharingStatus({ chatId, ...request });
      if (alive.current) {
        setAvailability(status);
        confirmDesignSharingAvailability(chatId, status.available === true, request.kind);
      }
    } catch (cause) {
      if (alive.current) {
        setAvailability({ available: false, reason: ipcErrorMessage(cause) });
        confirmDesignSharingAvailability(chatId, false, request.kind);
      }
    } finally {
      if (alive.current) setChecking(false);
    }
  }, [api, chatId, request]);
  useEffect(() => {
    alive.current = true;
    void load();
    void checkAvailability();
    const tick = setInterval(() => setNow(Date.now()), TICK);
    return () => {
      alive.current = false;
      reads.current++;
      clearInterval(tick);
    };
  }, [load, checkAvailability]);
  const seen = useRef(revision);
  useEffect(() => {
    if (revision === seen.current) return;
    seen.current = revision;
    const before = shareRef.current?.updatedAt ?? shareRef.current?.createdAt;
    void load(true);
    let left = REREADS;
    const timer = setInterval(() => {
      const current = shareRef.current;
      const moved = (current?.updatedAt ?? current?.createdAt) !== before;
      if (!current?.live || current.paused || moved || --left < 0) clearInterval(timer);
      else void load(true);
    }, REREAD_EVERY);
    return () => clearInterval(timer);
  }, [revision, load]);

  const act = async (kind: Exclude<PageShareBusy, null>, run: () => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    setBusy(kind);
    setError("");
    try {
      await run();
    } catch (cause) {
      if (alive.current) {
        setError(ipcErrorMessage(cause));
        await load(true);
      }
    } finally {
      working.current = false;
      if (alive.current) setBusy(null);
    }
  };
  const took = (next: DesignPageShare | null) => {
    if (!alive.current) return;
    reads.current++;
    setShare(next);
    setNow(Date.now());
  };
  const publish = () =>
    act("publish", async () => {
      const before = shareRef.current;
      const next = await api.sharePage({ chatId, title: before?.title ?? "Artifact", acknowledgePublic: true, ...request });
      took(next);
      const updated = !!before?.live && next.id === before.id;
      const copied = updated
        ? false
        : await navigator.clipboard.writeText(next.url).then(
            () => true,
            () => false,
          );
      showToast([updated ? "Updated." : "Published.", copied ? "Link copied." : "", olderLinksNotice(next.olderLinks)].filter(Boolean).join(" "));
    });
  const setPaused = (paused: boolean) =>
    act("pause", async () => {
      const current = shareRef.current;
      if (!current) return;
      if (typeof api.setPageSharePaused !== "function") throw new Error("Milagre on that computer can't pause links yet. Update it and try again.");
      took(await api.setPageSharePaused({ chatId, id: current.id, paused }));
    });
  const revoke = () =>
    act("revoke", async () => {
      const current = shareRef.current;
      if (!current) return;
      await api.revokePageShare({ chatId, id: current.id, ...request });
      took(null);
      showToast("Stopped sharing. Copies may remain online.");
    });
  return {
    share,
    loading,
    loadFailed,
    busy,
    error,
    setError,
    availability,
    checking,
    now,
    working,
    retryLoad: () => {
      setLoading(true);
      setLoadFailed(false);
      setError("");
      void load();
    },
    checkAvailability,
    publish,
    setPaused,
    revoke,
  };
}
