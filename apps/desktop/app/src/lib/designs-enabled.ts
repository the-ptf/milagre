import { useSyncExternalStore } from "react";
import type { MilagreBridge } from "../electron";
import { bridgeForKey } from "./computer-bridge";

type State = { enabled: boolean; ready: boolean; saving: boolean; error: string };
type Store = { subscribe: (listener: () => void) => () => void; snapshot: () => State; save: (enabled: boolean) => Promise<void> };
const stores = new WeakMap<MilagreBridge, Store>();
const initial: State = { enabled: false, ready: false, saving: false, error: "" };
const unavailable: Store = { subscribe: () => () => {}, snapshot: () => initial, save: async () => {} };

function storeFor(bridge: MilagreBridge): Store {
  if (!bridge) return unavailable;
  const found = stores.get(bridge);
  if (found) return found;
  let state = initial;
  let revision = 0;
  let stop: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<State>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const store: Store = {
    snapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        const reading = ++revision;
        stop = bridge.onDesignsEnabledChanged?.((value) => {
          revision++;
          update({ enabled: value.enabled === true, ready: true, error: "" });
        });
        Promise.resolve()
          .then(() => bridge.readDesignsEnabled())
          .then(
            (value) => {
              if (reading === revision) update({ enabled: value?.enabled === true, ready: true });
              return null;
            },
            () => {
              if (reading === revision) update({ enabled: false, ready: true, error: "Could not read the Designs setting." });
              return null;
            },
          );
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          stop?.();
          stop = undefined;
          revision++;
          state = initial;
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
  const store = storeFor(bridgeForKey(key));
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  return { ...state, save: store.save };
}
