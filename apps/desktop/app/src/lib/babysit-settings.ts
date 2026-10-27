import { useCallback, useEffect, useRef, useState } from "react";
import type { BabysitSettings } from "@milagre/shared/babysit";

type Patch = Partial<BabysitSettings>;

/** Settings › Experimental › Babysit PRs: the one configuration this Mac's daemon keeps. Changes show at once and go back if the save fails. */
export function useBabysitSettings() {
  const [settings, setSettings] = useState<BabysitSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The last value the host confirmed, so a failed save goes back to it rather than to another optimistic one.
  const confirmed = useRef<BabysitSettings | null>(null);
  useEffect(() => {
    let live = true;
    const take = (value: BabysitSettings) => {
      confirmed.current = value;
      setSettings(value);
    };
    const read = async () => {
      try {
        const value = await window.milagre.readBabysitSettings();
        if (live) take(value);
      } catch {
        if (live) setError("Could not read the Babysit PRs settings.");
      }
    };
    void read();
    const off = window.milagre.onBabysitSettings((value) => {
      take(value);
      setError(null);
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  const save = useCallback(async (patch: Patch) => {
    setError(null);
    setSettings((current) => (current ? { ...current, ...patch } : current));
    try {
      const saved = await window.milagre.saveBabysitSettings(patch);
      confirmed.current = saved;
      setSettings(saved);
    } catch (cause) {
      setSettings(confirmed.current);
      setError(cause instanceof Error ? cause.message : "Could not change this setting.");
      throw cause;
    }
  }, []);
  return { settings, error, save };
}

export type SaveState = "idle" | "saving" | "saved" | "error";

/** A typed field's save: one call 500 ms after typing stops, or at once on flush (blur, leaving the page). */
export function createDebouncedSave(save: (patch: Patch) => Promise<void>, ms = 500, onState?: (state: SaveState) => void) {
  let pending: Patch | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
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
    set("saving");
    try {
      await save(patch);
      // A newer edit already on its way keeps the state at saving until it lands.
      if (!pending) set("saved");
    } catch {
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
    get state() {
      return state;
    },
  };
}
