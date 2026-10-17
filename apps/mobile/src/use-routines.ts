import { useCallback, useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import type { Routine, RoutineRun } from "@milagre/shared/model";
import type { LiveOptions } from "./live";

/** A Routine as `routines:list` gives it: with its recent Runs. */
export type RoutineWithRuns = Routine & { runs: RoutineRun[] };
/** The connected Mac's Routines. `enabled` is the Mac's Routines switch, null until it answers (or on an older Mac). */
export type RoutinesState = { routines: RoutineWithRuns[]; enabled: boolean | null; error: string; loading: boolean };
/** What the store needs from a client: its calls and its live socket. */
export type RoutinesClient = {
  call: <T>(method: string, args: unknown[]) => Promise<T>;
  live: (path: string, options: Pick<LiveOptions, "onSignal" | "onStatus">) => { close(): void };
};
type AppStateLike = { subscribe: (listener: (active: boolean) => void) => () => void };

const EMPTY: RoutinesState = { routines: [], enabled: null, error: "", loading: true };
const IDLE: RoutinesState = { routines: [], enabled: null, error: "", loading: false };

// "inactive" (a system sheet over the app) changes nothing; only coming back to the foreground reads again.
const nativeAppState: AppStateLike = {
  subscribe(listener) {
    const watch = AppState.addEventListener("change", (status) => {
      if (status === "active") listener(true);
      else if (status === "background") listener(false);
    });
    return () => watch.remove();
  },
};

/**
 * One computer's Routines, shared by every screen that shows them (the Routines screen, a Chat's header). While any
 * screen holds it, it keeps a live socket open and reads again on each `routines` signal and on return to the app.
 */
export function createRoutinesStore(client: RoutinesClient, appState: AppStateLike = nativeAppState) {
  let state = EMPTY;
  const listeners = new Set<() => void>();
  // Optimistic switches: the value a Routine was just flipped to, until the Mac's answer lands.
  const flipped = new Map<string, boolean>();
  let refs = 0;
  let live: { close(): void } | null = null;
  let unwatch: (() => void) | null = null;
  let reading: Promise<void> | null = null;
  let again = false;
  const view = (): RoutinesState =>
    flipped.size
      ? { ...state, routines: state.routines.map((routine) => (flipped.has(routine.id) ? { ...routine, enabled: flipped.get(routine.id)! } : routine)) }
      : state;
  // What screens read: a new object only when something changed, as useSyncExternalStore needs.
  let shown = view();
  const emit = () => {
    shown = view();
    for (const listener of listeners) listener();
  };
  const set = (next: Partial<RoutinesState>) => {
    state = { ...state, ...next };
    emit();
  };
  async function read() {
    try {
      const [enabled, list] = await Promise.all([
        client.call<{ enabled: boolean } | null>("routines:enabled:read", []),
        client.call<{ routines: RoutineWithRuns[] } | null>("routines:list", []),
      ]);
      set({ enabled: enabled ? enabled.enabled === true : null, routines: Array.isArray(list?.routines) ? list.routines : [], error: "", loading: false });
    } catch (failure) {
      set({ error: failure instanceof Error ? failure.message : "Could not read Routines.", loading: false });
    }
  }
  /** Reads again; a call while a read runs queues one more read after it, whose answer can't predate the change. */
  function refresh(): Promise<void> {
    if (reading) {
      again = true;
      return reading;
    }
    reading = (async () => {
      try {
        do {
          again = false;
          await read();
        } while (again);
      } finally {
        reading = null;
      }
    })();
    return reading;
  }
  function open() {
    let down = false;
    live = client.live("", {
      onSignal: (signal) => {
        if (signal === "routines") void refresh();
      },
      // A dropped socket may have missed a signal; read again once it is back.
      onStatus: (up) => {
        if (up && down) void refresh();
        down = !up;
      },
    });
    unwatch = appState.subscribe((active) => {
      if (active) void refresh();
    });
  }
  return {
    get: () => shown,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Holds the store open for one screen; the returned function lets go. */
    acquire() {
      refs++;
      if (refs === 1) {
        open();
        void refresh();
      }
      return () => {
        refs--;
        if (refs > 0) return;
        live?.close();
        live = null;
        unwatch?.();
        unwatch = null;
      };
    },
    refresh,
    /** Writes a change to a Routine. A switch shows its new value at once; a refused write puts it back and throws. */
    async update(id: string, patch: Partial<Pick<Routine, "enabled">> & Record<string, unknown>) {
      if (typeof patch.enabled === "boolean") {
        flipped.set(id, patch.enabled);
        emit();
      }
      try {
        await client.call("routines:update", [id, patch]);
        await refresh();
      } finally {
        if (flipped.delete(id)) emit();
      }
    },
  };
}

type RoutinesStore = ReturnType<typeof createRoutinesStore>;
// One store per client: the session makes a new client each time it connects, and a late answer from the computer the
// phone left lands on that client's store, never this one's.
const stores = new WeakMap<object, RoutinesStore>();
export function routinesStore(client: RoutinesClient): RoutinesStore {
  let store = stores.get(client);
  if (!store) {
    store = createRoutinesStore(client);
    stores.set(client, store);
  }
  return store;
}

const subscribeNone = () => () => {};
const idle = () => IDLE;

/** The connected Mac's Routines and its Routines switch, read on focus and again on every `routines` signal. */
export function useRoutines(client: RoutinesClient | null) {
  const store = client ? routinesStore(client) : null;
  const state = useSyncExternalStore(store?.subscribe ?? subscribeNone, store?.get ?? idle);
  useEffect(() => store?.acquire(), [store]);
  useFocusEffect(
    useCallback(() => {
      void store?.refresh();
    }, [store]),
  );
  const refresh = useCallback(() => store?.refresh() ?? Promise.resolve(), [store]);
  const update = useCallback(
    (id: string, patch: Partial<Pick<Routine, "enabled">> & Record<string, unknown>) => store?.update(id, patch) ?? Promise.resolve(),
    [store],
  );
  return { ...state, refresh, update };
}
