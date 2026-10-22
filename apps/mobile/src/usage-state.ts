import type { UsageSnapshot } from "@milagre/shared/model";
import { mergeSnapshot, seedSnapshot } from "@milagre/shared/usage";

type UsageClient = { call: <T>(method: string, args?: unknown[]) => Promise<T> };
export type UsageState = { snapshot: UsageSnapshot | null; loading: boolean; error: string };

/** One computer's usage. Reads share a request, and a failed refresh keeps unexpired last-known limits. */
export function createUsageState(client: UsageClient, now = Date.now, scopeKey?: string) {
  let state: UsageState = { snapshot: null, loading: true, error: "" };
  let inFlight: Promise<void> | null = null;
  let cached: Promise<void> | null = null;
  let revision = 0;
  let cacheGeneration = 0;
  let lastAttempt = -Infinity;
  const listeners = new Set<() => void>();
  const publish = (next: UsageState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const loadCached = (reload = false) => {
    if (!reload && cached) return cached;
    const version = revision;
    const generation = ++cacheGeneration;
    return (cached = client
      .call<UsageSnapshot>("usage:cached", scopeKey ? [scopeKey] : [])
      .then((value) => {
        if ((reload && version !== revision) || generation !== cacheGeneration) return;
        const snapshot = reload
          ? mergeSnapshot(state.snapshot, value, now())
          : state.snapshot?.providers.every((provider) => provider.status === "error")
            ? mergeSnapshot(value, state.snapshot, now())
            : seedSnapshot(state.snapshot, value);
        publish({ ...state, snapshot });
      })
      .catch(() => {}));
  };
  const refresh = (): Promise<void> => {
    if (inFlight) return inFlight;
    lastAttempt = now();
    publish({ ...state, loading: true });
    inFlight = client
      .call<UsageSnapshot>("usage:read", scopeKey ? [scopeKey] : [])
      .then((next) => {
        revision++;
        publish({ snapshot: mergeSnapshot(state.snapshot, next, now()), loading: false, error: "" });
      })
      .catch((error) => {
        const next: UsageSnapshot | null = state.snapshot && {
          ...(state.snapshot.accountKey ? { accountKey: state.snapshot.accountKey } : {}),
          providers: state.snapshot.providers.map((provider) => ({
            ...provider,
            status: provider.status === "unavailable" ? "unavailable" : "error",
            windows: [],
          })),
        };
        publish({
          snapshot: next ? mergeSnapshot(state.snapshot, next, now()) : null,
          loading: false,
          error: error instanceof Error ? error.message : "Could not read usage. Try refreshing.",
        });
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  return {
    get: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    loadCached,
    refresh,
    refreshIfStale: (maxAge: number) => (now() - lastAttempt >= maxAge ? refresh() : Promise.resolve()),
  };
}
