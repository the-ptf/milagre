import { useSyncExternalStore } from "react";
import { isQuietChat, type BotsSnapshot } from "@milagre/shared/bots";
import type { MilagreBridge } from "../electron.d.ts";
import { bridgeFor } from "./computer-bridge.ts";

type State = { enabled: boolean; ready: boolean; saving: boolean; snapshot: BotsSnapshot | null; error: string | null };
type Store = { subscribe: (listener: () => void) => () => void; snapshot: () => State; save: (enabled: boolean) => Promise<void> };
const stores = new WeakMap<MilagreBridge, Store>();
const initial: State = { enabled: false, ready: false, saving: false, snapshot: null, error: null };
const unavailable: Store = { subscribe: () => () => {}, snapshot: () => initial, save: async () => {} };
// A busy host turns a read away; it is asked again, sooner first (designs-enabled.ts).
const RETRY_MS = [500, 1000, 2000, 5000, 10_000];

/** This Mac's Bots switch and its bots, read when the first reader mounts. Bots never run on a paired computer. */
export function botsStore(bridge: MilagreBridge): Store {
  if (!bridge) return unavailable;
  const found = stores.get(bridge);
  if (found) return found;
  let state = initial;
  let revision = 0;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stops: Array<(() => void) | undefined> = [];
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
    // Inside the promise, so a bridge without the bot methods (an older preload, a check's stub) is a failed read, not a throw.
    Promise.resolve()
      .then(() => Promise.all([bridge.readBotsEnabled(), bridge.listBots()]))
      .then(
        ([flag, snapshot]) => {
          if (reading !== revision) return;
          failures = 0;
          update({ enabled: flag?.enabled === true, snapshot: snapshot ?? null, ready: true, error: null });
        },
        () => {
          if (reading !== revision) return;
          update({ ready: true, error: "Could not read your bots." });
          retry = setTimeout(read, RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)]);
        },
      );
  };
  const store: Store = {
    snapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        const settled = () => {
          revision++;
          cancelRetry();
          failures = 0;
        };
        stops = [
          bridge.onBotsEnabledChanged?.((value) => {
            settled();
            update({ enabled: value.enabled === true, ready: true, error: null });
          }),
          bridge.onBotsChanged?.((snapshot) => {
            settled();
            update({ enabled: snapshot.enabled === true, snapshot, ready: true, error: null });
          }),
        ];
        read();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          for (const stop of stops) stop?.();
          stops = [];
          cancelRetry();
          failures = 0;
          revision++;
        }
      };
    },
    save: async (enabled) => {
      if (state.saving || !state.ready) return;
      const saving = ++revision;
      update({ saving: true, error: null });
      try {
        const result = await bridge.saveBotsEnabled(enabled);
        if (saving === revision) update({ enabled: result.enabled === true });
      } catch (cause) {
        update({ error: cause instanceof Error ? cause.message : "Could not change the Bots setting." });
      } finally {
        update({ saving: false });
      }
    },
  };
  stores.set(bridge, store);
  return store;
}

/** This Mac's bots: the Experimental switch and the snapshot the runtime sends on every change. */
export function useBots() {
  const store = botsStore(bridgeFor(null));
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  return { ...state, setEnabled: store.save };
}

/** A bot's thread and the Chats a bot runs finish without telling the user; approvals and questions still do. */
export function shouldNotifyCompletion(snapshot: BotsSnapshot | null, chatKey: string): boolean {
  return !isQuietChat(snapshot, chatKey);
}
