import { useSyncExternalStore } from "react";
import type { MilagreBridge } from "../electron.d.ts";
import { bridgeForKey } from "./computer-bridge.ts";

type State = { enabled: boolean; ready: boolean; saving: boolean; error: string };
type Store = { subscribe: (listener: () => void) => () => void; snapshot: () => State; save: (enabled: boolean) => Promise<void> };
const stores = new WeakMap<MilagreBridge, Store>();
const initial: State = { enabled: false, ready: false, saving: false, error: "" };
const unavailable: Store = { subscribe: () => () => {}, snapshot: () => initial, save: async () => {} };
// A busy or reconnecting host rejects a read (the client turns calls away past 32 pending, or one times out), so a
// failed read is asked again, sooner first.
const RETRY_MS = [500, 1000, 2000, 5000, 10_000];

/** One host's Designs switch, read when its first reader mounts. Exported for its tests. */
export function designsEnabledStore(bridge: MilagreBridge): Store {
  if (!bridge) return unavailable;
  const found = stores.get(bridge);
  if (found) return found;
  let state = initial;
  let revision = 0;
  let failures = 0;
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
          update({ enabled: value?.enabled === true, ready: true, error: "" });
          return null;
        },
        () => {
          if (reading !== revision) return null;
          // The last answer stays: a failed read says nothing about the switch, and treating it as off hid every design.
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
          update({ enabled: value.enabled === true, ready: true, error: "" });
        });
        read();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          stop?.();
          stop = undefined;
          cancelRetry();
          failures = 0;
          // The answer is kept for the next reader, which reads it again.
          revision++;
        }
      };
    },
    save: async (enabled) => {
      if (state.saving || !state.ready) return;
      const saving = ++revision;
      update({ saving: true, error: "" });
      try {
        const result = await bridge.saveDesignsEnabled(enabled);
        if (saving === revision) update({ enabled: result.enabled === true });
      } catch (cause) {
        update({
          error: cause instanceof Error ? cause.message : "Could not change the Designs setting.",
        });
      } finally {
        update({ saving: false });
      }
    },
  };
  stores.set(bridge, store);
  return store;
}

/** The Chat's host owns this switch. Unknown and older hosts never expose a legacy design fallback. */
export function useDesignsEnabled(key?: string | null) {
  const store = designsEnabledStore(bridgeForKey(key));
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  return { ...state, save: store.save };
}
