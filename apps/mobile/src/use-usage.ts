import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import type { Client } from "./client";
import { createUsageState, type UsageState } from "./usage-state";

const EMPTY: UsageState = { snapshot: null, loading: false, error: "" };
const idleSubscribe = () => () => {};
const empty = () => EMPTY;

export function useUsage(client: Client | null, scopeKey?: string, revision = 0) {
  const usage = useMemo(() => (client ? createUsageState(client, Date.now, scopeKey) : null), [client, scopeKey, revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const state = useSyncExternalStore(usage?.subscribe ?? idleSubscribe, usage?.get ?? empty, empty);
  // A plain effect, so usage also loads in the navigation panel, outside the router's screens.
  useEffect(() => {
    if (!usage) return;
    void usage.loadCached();
    let live: { close(): void } | null = null;
    const connect = () => {
      if (live || !client) return;
      live = client.live(scopeKey ?? "", {
        onSignal: (signal) => {
          if (signal === "usage") void usage.loadCached(true);
        },
        onStatus: (open) => {
          if (open) void usage.loadCached(true);
        },
      });
    };
    const refresh = () => {
      if (AppState.currentState === "active") {
        connect();
        void usage.refreshIfStale(60000);
      } else {
        live?.close();
        live = null;
      }
    };
    refresh();
    const timer = setInterval(refresh, 5 * 60000);
    const subscription = AppState.addEventListener("change", refresh);
    return () => {
      clearInterval(timer);
      subscription.remove();
      live?.close();
    };
  }, [usage, client, scopeKey]);
  return { ...state, refresh: usage?.refresh ?? (() => Promise.resolve()) };
}
