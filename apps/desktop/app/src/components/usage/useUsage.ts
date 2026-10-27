import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UsageSnapshot } from "../../model";
import { mergeSnapshot, seedSnapshot } from "./format";
import { bridgeForKey } from "../../lib/computer-bridge";

const POLL_MS = 5 * 60_000;
// A switch back to a scope read this recently shows its last numbers and reads nothing (usage:read runs the provider's
// CLI on the scope's computer); the poll, a turn's end and the host's pushes keep them current.
const FRESH_MS = 60_000;
// Each scope's last numbers, so switching Projects shows them at once instead of an empty usage row, and when they were read.
const lastSnapshots = new Map<string, UsageSnapshot>();
const lastReads = new Map<string, number>();

export function useUsage(scopeKey?: string) {
  const bridge = useMemo(() => bridgeForKey(scopeKey), [scopeKey]);
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const [snapshotScope, setSnapshotScope] = useState(scopeKey);
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const lastReadAt = useRef(0);
  const generation = useRef(0);
  const cacheGeneration = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(() => {
    if (inFlight.current) return inFlight.current;
    setLoading(true);
    const version = generation.current;
    inFlight.current = bridge
      .readUsage(scopeKey)
      .then((next) => {
        if (version !== generation.current || currentScope.current !== scopeKey) return;
        cacheGeneration.current++;
        setSnapshotScope(scopeKey);
        lastReadAt.current = Date.now();
        if (scopeKey) lastReads.set(scopeKey, lastReadAt.current);
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
  }, [scopeKey, bridge]);

  const refreshIfStale = useCallback(
    (maxAgeMs: number) => {
      if (Date.now() - lastReadAt.current > maxAgeMs) void refresh();
    },
    [refresh],
  );

  useEffect(() => {
    generation.current++;
    inFlight.current = null;
    const last = scopeKey ? lastSnapshots.get(scopeKey) : undefined;
    lastReadAt.current = scopeKey ? (lastReads.get(scopeKey) ?? 0) : 0;
    setSnapshotScope(scopeKey);
    setSnapshot(last ?? null);
    setLoading(false);
    const version = generation.current;
    if (!last || Date.now() - lastReadAt.current >= FRESH_MS) {
      // Saved numbers first, so the sidebar isn't empty while the first read runs.
      bridge
        .getCachedUsage(scopeKey)
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
    }
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    const off = bridge.onAccountsChanged?.(() => {
      generation.current++;
      inFlight.current = null;
      lastReadAt.current = 0;
      lastSnapshots.clear();
      lastReads.clear();
      // The numbers on screen stay until the new read replaces them (mergeSnapshot drops another account's),
      // so switching accounts from the usage card doesn't unmount the sidebar rows and the card with them.
      void refresh();
    });
    // Read the cache on a push, never the provider again: a live read emits this signal itself.
    const offUsage = bridge.onUsageChanged?.(({ scopeKey: changedScope }) => {
      if (changedScope !== scopeKey) return;
      const pushGeneration = generation.current;
      const cacheVersion = ++cacheGeneration.current;
      void bridge
        .getCachedUsage(scopeKey)
        .then((cached) => {
          if (pushGeneration !== generation.current || cacheVersion !== cacheGeneration.current || currentScope.current !== scopeKey) return;
          setSnapshot((previous) => {
            const merged = mergeSnapshot(previous, cached, Date.now());
            if (scopeKey && merged) lastSnapshots.set(scopeKey, merged);
            return merged;
          });
        })
        .catch(() => {});
    });
    return () => {
      generation.current++;
      window.clearInterval(timer);
      off?.();
      offUsage?.();
    };
  }, [refresh, bridge, scopeKey]);

  return { snapshot: snapshotScope === scopeKey ? snapshot : null, loading, refresh, refreshIfStale };
}

export type UsageState = ReturnType<typeof useUsage>;
