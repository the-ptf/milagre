import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import type { Client } from "./client";
import type { Live } from "./live";
import { createDesignsSetting, DESIGNS_DISCONNECTED } from "./designs-setting";
import { clearDesignMessages } from "./design-outbox";

const subscribeNone = () => () => {};
const disconnected = () => DESIGNS_DISCONNECTED;
const noChange = async () => {};
const noStatus = (_open: boolean) => {};

/** Reuse the open Project's live socket. Before it opens, listen on an allowed recent scope or the host. */
export function useDesigns(client: Client | null, projectPath?: string, availableScope?: string) {
  const idleScope = projectPath ? undefined : availableScope;
  const setting = useMemo(() => (client ? createDesignsSetting(client) : null), [client]);
  const state = useSyncExternalStore(setting?.subscribe ?? subscribeNone, setting?.getSnapshot ?? disconnected);
  const connection = useMemo(() => {
    if (!setting) return null;
    let connected = false;
    return {
      connected: () => connected,
      reset() {
        connected = false;
      },
      change(open: boolean) {
        if (connected === open) return;
        connected = open;
        if (open) void setting.refresh();
        else setting.unavailable("Reconnect to your Mac to check whether Designs is on.");
      },
    };
  }, [setting]);
  useEffect(() => {
    if (!setting) return;
    setting.resume();
    return () => setting.dispose();
  }, [setting]);
  useEffect(() => {
    if (!setting || !client || !connection) return;
    let live: Live | null = null;
    const start = () => {
      live?.close();
      connection.reset();
      void setting.refresh();
      if (!projectPath)
        live = client.live(idleScope ?? "", {
          onSignal: (signal) => {
            if (signal === "designs") void setting.refresh();
          },
          onStatus: connection.change,
        });
    };
    if (AppState.currentState === "active") start();
    const watch = AppState.addEventListener("change", (status) => {
      if (status === "active") start();
      else {
        live?.close();
        live = null;
        connection.reset();
      }
    });
    const poll = setInterval(() => {
      if (!connection.connected() && AppState.currentState === "active") void setting.refresh();
    }, 30_000);
    return () => {
      watch.remove();
      clearInterval(poll);
      live?.close();
    };
  }, [client, setting, connection, projectPath, idleScope]);
  useEffect(() => {
    if (client && state.enabled === false) clearDesignMessages(client.url);
  }, [client, state.enabled]);
  return useMemo(() => ({ ...state, refresh: setting?.refresh ?? noChange, connectionChanged: connection?.change ?? noStatus }), [state, setting, connection]);
}
