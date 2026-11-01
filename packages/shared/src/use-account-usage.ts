import { useCallback, useEffect, useRef, useState } from "react";
import type { UsageSnapshot } from "./model";
import { mergeSnapshot } from "./usage";

export type AccountUsageSource = {
  read: () => Promise<UsageSnapshot>;
  cached: () => Promise<UsageSnapshot>;
  subscribe: (usageChanged: () => void, accountsChanged: () => void) => () => void;
  isActive?: () => boolean;
};

const FRESH_MS = 60_000;

function fresh(snapshot: UsageSnapshot) {
  const ready = snapshot.providers.filter((item) => !item.account?.state || item.account.state === "ready");
  return ready.length > 0 && ready.every((item) => item.status === "ok" && item.windows.length > 0 && Date.now() - Date.parse(item.updatedAt) < FRESH_MS);
}

/** One computer's complete account overview. Pushes read saved numbers, never querying providers again. */
export function useAccountUsage(source: AccountUsageSource | null) {
  const [state, setState] = useState<{ source: AccountUsageSource | null; snapshot: UsageSnapshot | null; loading: boolean; error: string }>({
    source: null,
    snapshot: null,
    loading: false,
    error: "",
  });
  const refreshRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const accountsRef = useRef<() => Promise<void>>(() => Promise.resolve());
  useEffect(() => {
    if (!source) return;
    let live = true;
    let revision = 0;
    let cacheGeneration = 0;
    let snapshot: UsageSnapshot | null = null;
    let inFlight: Promise<void> | null = null;
    setState({ source, snapshot: null, loading: true, error: "" });
    const refresh = () => {
      if (inFlight) return inFlight;
      const at = revision;
      setState((current) => ({ ...current, loading: true }));
      const request = source
        .read()
        .then((next) => {
          if (!live || at !== revision) return;
          cacheGeneration++;
          snapshot = mergeSnapshot(snapshot, next, Date.now());
          setState({ source, snapshot, loading: false, error: "" });
        })
        .catch(() => {
          if (!live || at !== revision) return;
          if (snapshot) {
            snapshot = mergeSnapshot(
              snapshot,
              {
                ...snapshot,
                providers: snapshot.providers.map((entry) => (entry.windows.length ? { ...entry, status: "error", windows: [] } : entry)),
              },
              Date.now(),
            );
          }
          setState((current) => ({ ...current, snapshot, loading: false, error: "Couldn't refresh account usage. Try again." }));
        })
        .finally(() => {
          if (inFlight === request) inFlight = null;
        });
      inFlight = request;
      return request;
    };
    const cached = async (reason: "mount" | "usage" | "accounts") => {
      const at = revision;
      const generation = ++cacheGeneration;
      try {
        const next = await source.cached();
        if (!live || at !== revision || generation !== cacheGeneration) return;
        const sameAccounts = snapshot !== null && snapshot.accountKey === next.accountKey;
        snapshot = mergeSnapshot(snapshot, next, Date.now());
        setState((current) => ({ ...current, source, snapshot, loading: !!inFlight, error: "" }));
        if ((reason === "mount" && !fresh(next)) || (reason === "accounts" && !sameAccounts)) void refresh();
      } catch {
        if (live && at === revision && generation === cacheGeneration && reason !== "usage") void refresh();
      }
    };
    refreshRef.current = refresh;
    const accountsChanged = () => {
      // Discard in-flight responses, but preserve windows while the cache updates default flags.
      revision++;
      cacheGeneration++;
      inFlight = null;
      return cached("accounts");
    };
    accountsRef.current = accountsChanged;
    const off = source.subscribe(
      () => void cached("usage"),
      () => void accountsChanged(),
    );
    void cached("mount");
    const timer = setInterval(() => {
      if (source.isActive?.() !== false) void refresh();
    }, 5 * 60_000);
    return () => {
      live = false;
      clearInterval(timer);
      off();
      refreshRef.current = () => Promise.resolve();
      accountsRef.current = () => Promise.resolve();
    };
  }, [source]);
  const refresh = useCallback(() => refreshRef.current(), []);
  const refreshAccounts = useCallback(() => accountsRef.current(), []);
  return {
    snapshot: state.source === source ? state.snapshot : null,
    loading: !!source && (state.source !== source || state.loading),
    error: state.source === source ? state.error : "",
    refresh,
    refreshAccounts,
  };
}
