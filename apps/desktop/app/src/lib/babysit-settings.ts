import { useState, useSyncExternalStore } from "react";
import type { BabysitSettings } from "@milagre/shared/babysit";
import type { MilagreBridge } from "../electron.d.ts";

type Patch = Partial<BabysitSettings>;
export type BabysitChange = Patch | ((current: BabysitSettings) => Patch);
type State = { settings: BabysitSettings | null; error: string | null };

export function babysitSettingsStore(bridge: MilagreBridge) {
  let confirmed: BabysitSettings | null = null;
  let unconfirmed: Array<{ patch: Patch }> = [];
  let state: State = { settings: null, error: null };
  const listeners = new Set<() => void>();
  let off: (() => void) | null = null;
  let live = false;

  const show = (error = state.error) => {
    const settings: BabysitSettings | null = confirmed ? Object.assign({}, confirmed, ...unconfirmed.map((entry) => entry.patch)) : null;
    state = { settings, error };
    for (const listener of listeners) listener();
  };
  const read = async () => {
    try {
      const value = await bridge.readBabysitSettings();
      if (!live) return;
      confirmed = value;
      show();
    } catch {
      if (live) show("Could not read the Babysit PRs settings.");
    }
  };

  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        live = true;
        void read();
        off = bridge.onBabysitSettings((value) => {
          confirmed = value;
          show(null);
        });
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        live = false;
        off?.();
        off = null;
      };
    },
    async save(change: BabysitChange) {
      const current = state.settings;
      const patch = typeof change === "function" ? (current ? change(current) : null) : change;
      if (!patch) return;
      const entry = { patch };
      unconfirmed = [...unconfirmed, entry];
      show(null);
      try {
        const saved = await bridge.saveBabysitSettings(patch);
        unconfirmed = unconfirmed.filter((item) => item !== entry);
        confirmed = saved;
        show();
      } catch (cause) {
        unconfirmed = unconfirmed.filter((item) => item !== entry);
        show(cause instanceof Error ? cause.message : "Could not change this setting.");
        throw cause;
      }
    },
  };
}

export function useBabysitSettings() {
  const [store] = useState(() => babysitSettingsStore(window.milagre));
  const { settings, error } = useSyncExternalStore(store.subscribe, store.snapshot);
  return { settings, error, save: store.save };
}

export type SaveState = "idle" | "saving" | "saved" | "error";

export function createDebouncedSave(save: (patch: Patch) => Promise<void>, ms = 500, onState?: (state: SaveState) => void) {
  let pending: Patch | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = 0;
  let generation = 0;
  let state: SaveState = "idle";
  const set = (next: SaveState) => {
    state = next;
    onState?.(next);
  };
  const flush = async () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const patch = pending;
    pending = null;
    if (!patch) return;
    const sent = generation;
    inFlight += 1;
    set("saving");
    try {
      await save(patch);
      if (sent !== generation) return;
      inFlight -= 1;
      if (!inFlight && !pending) set("saved");
    } catch {
      if (sent !== generation) return;
      inFlight -= 1;
      set("error");
    }
  };
  return {
    edit(patch: Patch) {
      pending = { ...pending, ...patch };
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => void flush(), ms);
    },
    flush,
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
      inFlight = 0;
      generation += 1;
    },
    get state() {
      return state;
    },
  };
}
