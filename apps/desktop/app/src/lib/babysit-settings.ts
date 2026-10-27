import { useState, useSyncExternalStore } from "react";
import type { BabysitSettings } from "@milagre/shared/babysit";
import type { MilagreBridge } from "../electron.d.ts";

type Patch = Partial<BabysitSettings>;
/** A change, or a function that builds it from the latest settings shown (changes still on their way included). */
export type BabysitChange = Patch | ((current: BabysitSettings) => Patch);
type State = { settings: BabysitSettings | null; error: string | null };

/**
 * Settings › Experimental › Babysit PRs: the one configuration this Mac's daemon keeps. Changes show at once; each
 * answer from the host is shown with the changes still on their way laid over it, so an earlier answer never undoes a
 * later change, and a failed change goes back on its own.
 */
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
    /** Rejects when the host refuses it, after the change has gone back and `error` says why. */
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

/** The Babysit PRs settings for one view: `save` takes a change or a function of the latest settings. */
export function useBabysitSettings() {
  const [store] = useState(() => babysitSettingsStore(window.milagre));
  const { settings, error } = useSyncExternalStore(store.subscribe, store.snapshot);
  return { settings, error, save: store.save };
}

export type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * A typed field's save: one call 500 ms after typing stops, or at once on flush (blur, leaving the page). `cancel` (Reset)
 * drops what was typed and not yet sent; a save already on its way still lands but no longer marks the field.
 */
export function createDebouncedSave(save: (patch: Patch) => Promise<void>, ms = 500, onState?: (state: SaveState) => void) {
  let pending: Patch | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = 0;
  // Bumped by cancel: answers to saves sent before it are not this field's any more.
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
      // Saved only once nothing newer is typed or still on its way; each save carries the whole text, so the last to land wins.
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
