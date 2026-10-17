import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import type { Routine, RoutineRun } from "@milagre/shared/model";
import type { LiveOptions } from "./live";

/** A Routine as `routines:list` gives it: with its recent Runs. */
export type RoutineWithRuns = Routine & { runs: RoutineRun[] };
/**
 * Why this phone can't use the Mac's Routines: `older` when its Milagre has no Routines (the bridge refuses the command),
 * `confined` when the connection is limited to one Project (the Mac answers its reads with nothing).
 */
export type RoutinesUnavailable = "older" | "confined";
/**
 * The connected Mac's Routines. `enabled` is the Mac's Routines switch, null until it answers; `unavailable` is set
 * instead when this phone can't reach Routines at all, so the screen never claims they are off.
 */
export type RoutinesState = {
  routines: RoutineWithRuns[];
  enabled: boolean | null;
  unavailable: RoutinesUnavailable | null;
  error: string;
  loading: boolean;
};
/** What the store needs from a client: its calls and its live socket. */
export type RoutinesClient = {
  call: <T>(method: string, args: unknown[]) => Promise<T>;
  live: (path: string, options: Pick<LiveOptions, "onSignal" | "onStatus">) => { close(): void };
};
type AppStateLike = { subscribe: (listener: (active: boolean) => void) => () => void };

const EMPTY: RoutinesState = { routines: [], enabled: null, unavailable: null, error: "", loading: true };
const IDLE: RoutinesState = { routines: [], enabled: null, unavailable: null, error: "", loading: false };
/** What the bridge says for a command its daemon doesn't list: a Mac older than Routines. */
const refused = (failure: unknown) => /not available from mobile/i.test((failure as Error)?.message ?? "");

/**
 * What the Mac's switch read means for this phone. A Mac with Routines answers `{ enabled }`; a confined connection
 * answers with nothing (an empty list, or null); an older Mac refuses the command.
 */
async function readSwitch(client: Pick<RoutinesClient, "call">): Promise<{ enabled: boolean } | { unavailable: RoutinesUnavailable }> {
  let answer: unknown;
  try {
    answer = await client.call<unknown>("routines:enabled:read", []);
  } catch (failure) {
    if (refused(failure)) return { unavailable: "older" };
    throw failure;
  }
  const enabled = (answer as { enabled?: unknown } | null)?.enabled;
  return typeof enabled === "boolean" && !Array.isArray(answer) ? { enabled } : { unavailable: "confined" };
}

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
 * screen holds it and the Mac has Routines for this phone, it keeps a live socket open and reads again on each
 * `routines` signal; it also reads again on return to the app. A confined or older connection gets no socket: the bridge
 * refuses a confined phone's Project-less socket, which would only retry forever.
 */
export function createRoutinesStore(client: RoutinesClient, appState: AppStateLike = nativeAppState) {
  let state = EMPTY;
  const listeners = new Set<() => void>();
  // Optimistic switches: the value a Routine was just flipped to and the write that flipped it, until it settles.
  const flipped = new Map<string, { enabled: boolean; write: number }>();
  let writes = 0;
  let refs = 0;
  let live: { close(): void } | null = null;
  let unwatch: (() => void) | null = null;
  let reading: Promise<void> | null = null;
  let again = false;
  const view = (): RoutinesState =>
    flipped.size
      ? { ...state, routines: state.routines.map((routine) => (flipped.has(routine.id) ? { ...routine, enabled: flipped.get(routine.id)!.enabled } : routine)) }
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
  function openLive() {
    if (live || refs === 0) return;
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
  }
  async function read() {
    try {
      const reached = await readSwitch(client);
      if ("unavailable" in reached) {
        set({ unavailable: reached.unavailable, enabled: null, routines: [], error: "", loading: false });
        return;
      }
      const list = await client.call<{ routines?: RoutineWithRuns[] } | null>("routines:list", []);
      set({ unavailable: null, enabled: reached.enabled, routines: Array.isArray(list?.routines) ? list.routines : [], error: "", loading: false });
      openLive();
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
  return {
    get: () => shown,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Holds the store open for one screen; the returned function lets go. Screens read on focus (`refresh`). */
    acquire() {
      refs++;
      if (refs === 1) {
        unwatch = appState.subscribe((active) => {
          if (active) void refresh();
        });
        if (state.unavailable === null && state.enabled !== null) openLive();
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
      const write = ++writes;
      if (typeof patch.enabled === "boolean") {
        flipped.set(id, { enabled: patch.enabled, write });
        emit();
      }
      try {
        await client.call("routines:update", [id, patch]);
        await refresh();
      } finally {
        // A later flip of the same Routine owns the optimistic value now; only this write's own is cleared.
        if (flipped.get(id)?.write === write) {
          flipped.delete(id);
          emit();
        }
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

// The last answer per client, so the dock doesn't flash its button away and back on each focus.
const reachable = new WeakMap<object, boolean>();
/**
 * Whether this phone can use the connected Mac's Routines: false on a Mac without them and on a confined connection.
 * Read on focus, without the store's socket, for the project dock.
 */
export function useRoutinesAvailable(client: Pick<RoutinesClient, "call"> | null) {
  const [available, setAvailable] = useState(() => (client ? (reachable.get(client) ?? false) : false));
  useFocusEffect(
    useCallback(() => {
      if (!client) {
        setAvailable(false);
        return;
      }
      let live = true;
      void (async () => {
        try {
          const next = !("unavailable" in (await readSwitch(client)));
          reachable.set(client, next);
          if (live) setAvailable(next);
        } catch {
          // A failed read keeps the last answer.
        }
      })();
      return () => {
        live = false;
      };
    }, [client]),
  );
  return available;
}
