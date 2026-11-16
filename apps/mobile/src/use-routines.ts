import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import type { Routine, RoutineRun } from "@milagre/shared/model";
import type { LiveOptions } from "./live";

export type RoutineWithRuns = Routine & { runs: RoutineRun[] };
export type RoutinesUnavailable = "older" | "confined";
type RoutinesState = {
  routines: RoutineWithRuns[];
  enabled: boolean | null;
  unavailable: RoutinesUnavailable | null;
  error: string;
  loading: boolean;
};
export type RoutinesClient = {
  call: <T>(method: string, args: unknown[]) => Promise<T>;
  live: (path: string, options: Pick<LiveOptions, "onSignal" | "onStatus">) => { close(): void };
};
type AppStateLike = { subscribe: (listener: (active: boolean) => void) => () => void };

const EMPTY: RoutinesState = { routines: [], enabled: null, unavailable: null, error: "", loading: true };
const IDLE: RoutinesState = { routines: [], enabled: null, unavailable: null, error: "", loading: false };
const refused = (failure: unknown) => /not available from mobile/i.test((failure as Error)?.message ?? "");

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

const nativeAppState: AppStateLike = {
  subscribe(listener) {
    const watch = AppState.addEventListener("change", (status) => {
      if (status === "active") listener(true);
      else if (status === "background") listener(false);
    });
    return () => watch.remove();
  },
};

function createRoutinesStore(client: RoutinesClient, appState: AppStateLike = nativeAppState) {
  let state = EMPTY;
  const listeners = new Set<() => void>();
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
        if (flipped.get(id)?.write === write) {
          flipped.delete(id);
          emit();
        }
      }
    },
  };
}

type RoutinesStore = ReturnType<typeof createRoutinesStore>;
const stores = new WeakMap<object, RoutinesStore>();
function routinesStore(client: RoutinesClient): RoutinesStore {
  let store = stores.get(client);
  if (!store) {
    store = createRoutinesStore(client);
    stores.set(client, store);
  }
  return store;
}

const subscribeNone = () => () => {};
const idle = () => IDLE;

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

const reachable = new WeakMap<object, boolean>();
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
        } catch {}
      })();
      return () => {
        live = false;
      };
    }, [client]),
  );
  return available;
}
