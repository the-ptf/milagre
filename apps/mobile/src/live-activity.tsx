import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import type { ActivityContent, ActivityMode } from "@milagre/shared/live-activity";
import { useSession } from "./session";
import { createClient } from "./client";
import { savedHosts } from "./hosts-native";
import { relayRuntime } from "./relay-native";
import { pushStore } from "./push-native";
import { nativeActivity } from "./live-activity-native";
import { activityEnabled, activityMode, saveActivityEnabled, saveActivityMode } from "./live-activity-store";

const Context = createContext({
  enabled: false,
  available: false,
  error: "",
  busy: false,
  mode: "all" as ActivityMode,
  toggle: async () => {},
  changeMode: async (_mode: ActivityMode) => {},
});
export const useActivity = () => useContext(Context);

export function ActivityProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const [ready, setReady] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<ActivityMode>("all");
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const hostIds = session.hosts.map((host) => host.id).join("|");
  useEffect(() => {
    void activityEnabled()
      .then((value) => {
        setEnabled(value);
        setReady(true);
      })
      .catch(() => setError("Could not read Live Activity settings."));
    void activityMode()
      .then(setMode)
      .catch(() => setError("Could not read Live Activity settings."));
    void nativeActivity
      ?.availableAsync()
      .then(setAvailable)
      .catch(() => setAvailable(false));
  }, []);
  useEffect(() => {
    const native = nativeActivity;
    if (!native || !ready) return;
    let stopped = false;
    let working = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (stopped || working || AppState.currentState !== "active") return;
      working = true;
      try {
        const prefs = await pushStore.read();
        const hosts = (await savedHosts.list()).filter((host) => !prefs.pending.some((item) => item.id === host.id && item.forgotten));
        if (stopped) return;
        await native.retainHostsAsync(enabled ? hosts.map((host) => host.id) : []);
        if (!enabled) return;
        await Promise.all(
          hosts.map(async (host) => {
            if (prefs.pending.some((item) => item.id === host.id && item.forgotten)) {
              await nativeActivity?.endAsync(host.id);
              return;
            }
            const content = await createClient(host, fetch, 5000, relayRuntime).call<ActivityContent>("live-activity:state", [
              { deviceId: prefs.deviceId, mode },
            ]);
            const current = (await savedHosts.list()).find((item) => item.id === host.id);
            const latestPrefs = await pushStore.read();
            const stillEnabled = await activityEnabled();
            if (stopped || !stillEnabled || current?.token !== host.token || latestPrefs.pending.some((item) => item.id === host.id && item.forgotten)) return;
            await native.syncAsync(host.id, host.name, "milagre", JSON.stringify(content));
          }),
        );
        if (!stopped) setError("");
      } catch {
        if (!stopped) setError("Could not update agent activity. Check your computer's connection.");
      } finally {
        working = false;
        if (!stopped)
          timer = setTimeout(() => {
            void refresh();
          }, 5000);
      }
    };
    void refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      clearTimeout(timer);
      if (state === "active") void refresh();
    });
    return () => {
      stopped = true;
      clearTimeout(timer);
      subscription.remove();
    };
  }, [ready, enabled, hostIds, mode]);
  const changeMode = useCallback(
    async (next: ActivityMode) => {
      if (busy || next === mode) return;
      setBusy(true);
      setError("");
      try {
        await saveActivityMode(next);
        setMode(next);
      } catch {
        setError("Could not save the Live Activity display setting.");
      } finally {
        setBusy(false);
      }
    },
    [busy, mode],
  );
  const toggle = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const next = !enabled;
      await saveActivityEnabled(next);
      setEnabled(next);
      if (!next && nativeActivity) {
        await nativeActivity.retainHostsAsync([]);
        const prefs = await pushStore.read();
        await Promise.all(
          (await savedHosts.list()).map(async (host) => {
            await nativeActivity?.endAsync(host.id);
            await createClient(host, fetch, 5000, relayRuntime).call("live-activity:forget", [{ deviceId: prefs.deviceId }]);
          }),
        );
      }
    } catch {
      setError("Could not change Live Activity settings. Check your computer's connection.");
    } finally {
      setBusy(false);
    }
  }, [busy, enabled]);
  const value = useMemo(() => ({ enabled, available, busy, error, mode, toggle, changeMode }), [enabled, available, busy, error, mode, toggle, changeMode]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
