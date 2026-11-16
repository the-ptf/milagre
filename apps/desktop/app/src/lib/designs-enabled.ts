import { useSyncExternalStore } from "react";
import type { MilagreBridge } from "../electron.d.ts";
import { bridgeForKey } from "./computer-bridge.ts";

type State = { enabled: boolean; ready: boolean; error: string };
type Store = { subscribe: (listener: () => void) => () => void; snapshot: () => State };
const stores = new WeakMap<MilagreBridge, Store>();
const initial: State = { enabled: false, ready: false, error: "" };
const unavailable: Store = { subscribe: () => () => {}, snapshot: () => initial };
const RETRY_MS = [500, 1000, 2000, 5000, 10_000];
const FRESH_MS = 60_000;

export function designsEnabledStore(bridge: MilagreBridge): Store {
  if (!bridge) return unavailable;
  const found = stores.get(bridge);
  if (found) return found;
  let state = initial;
  let revision = 0;
  let failures = 0;
  let answeredAt = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stop: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<State>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const cancelRetry = () => {
    clearTimeout(retry);
    retry = undefined;
  };
  const read = () => {
    retry = undefined;
    const reading = ++revision;
    Promise.resolve()
      .then(() => bridge.readDesignsEnabled())
      .then(
        (value) => {
          if (reading !== revision) return null;
          failures = 0;
          answeredAt = Date.now();
          update({ enabled: value?.enabled === true, ready: true, error: "" });
          return null;
        },
        () => {
          if (reading !== revision) return null;
          update({ ready: true, error: "Could not read the Designs setting." });
          retry = setTimeout(read, RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)]);
          return null;
        },
      );
  };
  const store: Store = {
    snapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        stop = bridge.onDesignsEnabledChanged?.((value) => {
          revision++;
          cancelRetry();
          failures = 0;
          answeredAt = Date.now();
          update({ enabled: value.enabled === true, ready: true, error: "" });
        });
        if (!state.ready || state.error || Date.now() - answeredAt >= FRESH_MS) read();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          stop?.();
          stop = undefined;
          cancelRetry();
          failures = 0;
          revision++;
        }
      };
    },
  };
  stores.set(bridge, store);
  return store;
}

export function useDesignsEnabled(key?: string | null) {
  const store = designsEnabledStore(bridgeForKey(key));
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}
