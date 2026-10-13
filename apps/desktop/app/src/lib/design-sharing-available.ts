import { useSyncExternalStore } from "react";
import type { MilagreBridge } from "../electron";
import { bridgeForKey } from "./computer-bridge";

type Store = { subscribe: (listener: () => void) => () => void; snapshot: () => boolean; confirm: (available: boolean) => void };
type PageKind = "designs" | "artifacts";
const stores = new WeakMap<MilagreBridge, Map<PageKind, Store>>();

function storeFor(bridge: MilagreBridge, kind: PageKind): Store {
  let host = stores.get(bridge);
  if (!host) {
    host = new Map();
    stores.set(bridge, host);
  }
  const existing = host.get(kind);
  if (existing) return existing;
  let available = false;
  let generation = 0;
  let pending = false;
  const listeners = new Set<() => void>();
  const update = (next: boolean) => {
    if (available === next) return;
    available = next;
    for (const listener of listeners) listener();
  };
  const refresh = async () => {
    if (pending) return;
    pending = true;
    const current = ++generation;
    try {
      const result = await bridge.artifacts.sharingStatus({ kind });
      if (current === generation) update(result?.available === true);
    } catch {
      if (current === generation) update(false);
    } finally {
      if (current === generation) pending = false;
    }
  };
  const foreground = () => {
    if (document.visibilityState === "visible") void refresh();
  };
  const offline = () => {
    generation++;
    pending = false;
    update(false);
  };
  const store: Store = {
    snapshot: () => available,
    confirm(next) {
      generation++;
      pending = false;
      update(next);
    },
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        void refresh();
        window.addEventListener("online", refresh);
        window.addEventListener("offline", offline);
        document.addEventListener("visibilitychange", foreground);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        generation++;
        pending = false;
        available = false;
        window.removeEventListener("online", refresh);
        window.removeEventListener("offline", offline);
        document.removeEventListener("visibilitychange", foreground);
      };
    },
  };
  host.set(kind, store);
  return store;
}

/** One health check per host, shared by the review canvas and editor. Unknown or older hosts keep Share hidden. */
export function useDesignSharingAvailable(chatId: string, kind: PageKind = "designs") {
  const store = storeFor(bridgeForKey(chatId), kind);
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}

/** A newer dialog check also updates the page entry points, including a service failure after opening. */
export function confirmDesignSharingAvailability(chatId: string, available: boolean, kind: PageKind = "designs") {
  storeFor(bridgeForKey(chatId), kind).confirm(available);
}
