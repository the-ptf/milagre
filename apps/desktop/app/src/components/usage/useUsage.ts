import { useCallback, useEffect, useRef, useState } from "react";
import type { UsageSnapshot } from "../../model";
import { mergeSnapshot, seedSnapshot } from "./format";
import { isRemoteKey } from "../../lib/computer-bridge";

const POLL_MS = 5 * 60_000;
// Each scope's last numbers, so switching Projects shows them at once instead of an empty usage row.
const lastSnapshots = new Map<string, UsageSnapshot>();

export function useUsage(scopeKey?: string) {
  // Accounts and their usage stay on their own computer (ADR-0005).
  // A remote scope shows no usage at all: reading with no scope would show this Mac's accounts under that computer.
  const remote = isRemoteKey(scopeKey);
  const localScope = remote ? undefined : scopeKey;
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const [snapshotScope, setSnapshotScope] = useState(scopeKey);
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const lastReadAt = useRef(0);
  const generation = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(() => {
    if (remote) return Promise.resolve();
    if (inFlight.current) return inFlight.current;
    setLoading(true);
    const version = generation.current;
    inFlight.current = window.milagre
      .readUsage(localScope)
      .then((next) => {
        if (version !== generation.current || currentScope.current !== scopeKey) return;
        setSnapshotScope(scopeKey);
        lastReadAt.current = Date.now();
        setSnapshot((previous) => {
          const merged = mergeSnapshot(previous, next, Date.now());
          if (scopeKey && merged) lastSnapshots.set(scopeKey, merged);
          return merged;
        });
      })
      .catch(() => {})
      .finally(() => {
        if (version === generation.current) {
          inFlight.current = null;
          setLoading(false);
        }
      });
    return inFlight.current;
  }, [scopeKey, remote]);

  const refreshIfStale = useCallback(
    (maxAgeMs: number) => {
      if (Date.now() - lastReadAt.current > maxAgeMs) void refresh();
    },
    [refresh],
  );

  useEffect(() => {
    generation.current++;
    inFlight.current = null;
    lastReadAt.current = 0;
    if (remote) {
      setSnapshotScope(scopeKey);
      setSnapshot(null);
      setLoading(false);
      return;
    }
    const last = scopeKey ? lastSnapshots.get(scopeKey) : undefined;
    setSnapshotScope(scopeKey);
    setSnapshot(last ?? null);
    setLoading(false);
    // Saved numbers first, so the sidebar isn't empty while the first read runs.
    const version = generation.current;
    window.milagre
      .getCachedUsage(localScope)
      .then((cached) => {
        if (version === generation.current && currentScope.current === scopeKey) {
          setSnapshotScope(scopeKey);
          setSnapshot((current) => {
            const seeded = seedSnapshot(current, cached);
            if (scopeKey && seeded) lastSnapshots.set(scopeKey, seeded);
            return seeded;
          });
        }
      })
      .catch(() => {});
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    const off = window.milagre.onAccountsChanged?.(() => {
      generation.current++;
      inFlight.current = null;
      lastReadAt.current = 0;
      lastSnapshots.clear();
      // The numbers on screen stay until the new read replaces them (mergeSnapshot drops another account's),
      // so switching accounts from the usage card doesn't unmount the sidebar rows and the card with them.
      void refresh();
    });
    return () => {
      generation.current++;
      window.clearInterval(timer);
      off?.();
    };
  }, [refresh]);

  return { snapshot: !remote && snapshotScope === scopeKey ? snapshot : null, loading, refresh, refreshIfStale };
}

export type UsageState = ReturnType<typeof useUsage>;
