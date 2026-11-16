import { useCallback, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import { CONTEXT_DEFAULTS, type ContextSettings } from "@milagre/shared/context-settings";
import { rpcDataKey } from "./use-rpc";
import type { Client } from "./client";
import { useSession } from "./session";

type SettingsSnapshot = { settings: ContextSettings; ready: boolean; error: string };
const EMPTY: SettingsSnapshot = { settings: CONTEXT_DEFAULTS, ready: false, error: "" };

export function createContextSettingsStore(client: Pick<Client, "call">) {
  let snapshot = EMPTY;
  let dataKey = "";
  let reading: Promise<void> | null = null;
  let generation = 0;
  const listeners = new Set<() => void>();
  let foreground: ReturnType<typeof AppState.addEventListener> | undefined;
  function publish(next: SettingsSnapshot) {
    if (snapshot.settings === next.settings && snapshot.ready === next.ready && snapshot.error === next.error) return;
    snapshot = next;
    listeners.forEach((listener) => listener());
  }
  function refresh(afterSave = false): Promise<void> {
    if (afterSave) {
      generation++;
      reading = null;
    }
    if (reading) return reading;
    const started = generation;
    const read = (async () => {
      await Promise.resolve();
      try {
        const settings = await client.call<ContextSettings | null | undefined>("context:settings:read", []);
        if (started !== generation) return;
        if (!settings) return publish(EMPTY);
        const nextKey = rpcDataKey(settings);
        publish({ settings: nextKey === dataKey ? snapshot.settings : settings, ready: true, error: "" });
        dataKey = nextKey;
      } catch (error) {
        if (started === generation) publish({ ...snapshot, error: error instanceof Error ? error.message : String(error) });
      } finally {
        if (started === generation) reading = null;
      }
    })();
    reading = read;
    return read;
  }
  return {
    getSnapshot: () => snapshot,
    refresh: () => refresh(),
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        let state = AppState.currentState;
        foreground = AppState.addEventListener("change", (next) => {
          const returned = next === "active" && state !== "active";
          state = next;
          if (returned) void refresh();
        });
        void refresh();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          foreground?.remove();
          foreground = undefined;
        }
      };
    },
    async save(patch: Partial<ContextSettings>) {
      await client.call("context:settings:save", [patch]);
      await refresh(true);
    },
  };
}

const stores = new WeakMap<Client, ReturnType<typeof createContextSettingsStore>>();
export function contextSettingsStore(client: Client) {
  let store = stores.get(client);
  if (!store) {
    store = createContextSettingsStore(client);
    stores.set(client, store);
  }
  return store;
}
const subscribeEmpty = () => () => {};
const getEmpty = () => EMPTY;

export function useContextSettings() {
  const { client } = useSession();
  const store = client ? contextSettingsStore(client) : null;
  const query = useSyncExternalStore(store?.subscribe ?? subscribeEmpty, store?.getSnapshot ?? getEmpty);
  useFocusEffect(
    useCallback(() => {
      void store?.refresh();
    }, [store]),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  return {
    settings: query.settings,
    ready: query.ready,
    saving,
    error: error || query.error,
    save: async (patch: Partial<ContextSettings>) => {
      if (!store) return;
      setSaving(true);
      setError("");
      try {
        await store.save(patch);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not save context settings.");
      } finally {
        setSaving(false);
      }
    },
  };
}
