import { useCallback, useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import { createOrchestratorStore, type AppStateLike, type OrchestratorClient, type OrchestratorState, type OrchestratorStore } from "./orchestrator-store";

const nativeAppState: AppStateLike = {
  subscribe(listener) {
    const watch = AppState.addEventListener("change", (status) => {
      if (status === "active") listener(true);
      else if (status === "background") listener(false);
    });
    return () => watch.remove();
  },
};

const stores = new WeakMap<object, OrchestratorStore>();
function orchestratorStore(client: OrchestratorClient): OrchestratorStore {
  let store = stores.get(client);
  if (!store) {
    store = createOrchestratorStore(client, nativeAppState);
    stores.set(client, store);
  }
  return store;
}

const IDLE: OrchestratorState = { snapshot: null, error: "", unavailable: false, loading: false };
const subscribeNone = () => () => {};
const idle = () => IDLE;

/** The connected computer's Orchestrator: its settings, tasks and memory, read again on each "orchestrator" signal. */
export function useOrchestrator(client: OrchestratorClient | null) {
  const store = client ? orchestratorStore(client) : null;
  const state = useSyncExternalStore(store?.subscribe ?? subscribeNone, store?.get ?? idle);
  useEffect(() => store?.acquire(), [store]);
  useFocusEffect(
    useCallback(() => {
      void store?.refresh();
    }, [store]),
  );
  return { ...state, store };
}
