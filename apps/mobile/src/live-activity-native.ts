import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";
import type { ActivityContent } from "@milagre/shared/live-activity";
import { createClient } from "./client";
import { savedHosts } from "./hosts-native";
import { pushStore } from "./push-native";
import { activityEnabled, activityMode } from "./live-activity-store";
import { relayRuntime } from "./relay-native";

type Action = { id: string; hostId: string; target: string; position: number; option: number };
type NativeActivity = {
  addListener(event: "answerRequest", listener: (action: Action) => void): EventSubscription;
  pendingActionsAsync(): Promise<Action[]>;
  availableAsync(): Promise<boolean>;
  syncAsync(hostId: string, hostName: string, scheme: string, content: string): Promise<void>;
  completeAsync(id: string, hostId: string, status: string, content: string | null): Promise<void>;
  retainHostsAsync(hostIds: string[]): Promise<void>;
  endAsync(hostId: string): Promise<void>;
};
export const nativeActivity = requireOptionalNativeModule<NativeActivity>("MilagreLiveActivity");
const handling = new Set<string>();
let installed = false;
export function installActivityAnswers() {
  if (!nativeActivity || installed) return;
  installed = true;
  const handle = async (action: Action) => {
    if (handling.has(action.id)) return;
    handling.add(action.id);
    try {
      if (!(await activityEnabled())) throw new Error("Tracking disabled");
      const prefs = await pushStore.read();
      const host = (await savedHosts.list()).find((item) => item.id === action.hostId);
      if (!host || prefs.pending.some((item) => item.id === host.id && item.forgotten)) throw new Error("Pairing removed");
      const result = await createClient(host, fetch, 15000, relayRuntime).call<{ status: string; content: ActivityContent }>("live-activity:answer", [
        { deviceId: prefs.deviceId, target: action.target, position: action.position, option: action.option, mode: await activityMode() },
      ]);
      const latest = (await savedHosts.list()).find((item) => item.id === host.id);
      const currentPrefs = await pushStore.read();
      if (!(await activityEnabled()) || latest?.token !== host.token || currentPrefs.pending.some((item) => item.id === host.id && item.forgotten)) {
        await nativeActivity.endAsync(host.id);
        throw new Error("Pairing or tracking removed");
      }
      await nativeActivity.completeAsync(action.id, action.hostId, result.status, JSON.stringify(result.content));
    } catch {
      await nativeActivity.completeAsync(action.id, action.hostId, "unknown", null).catch(() => {});
    } finally {
      handling.delete(action.id);
    }
  };
  nativeActivity.addListener("answerRequest", (action) => {
    void handle(action);
  });
  void nativeActivity
    .pendingActionsAsync()
    .then((actions) =>
      actions.forEach((action) => {
        void handle(action);
      }),
    )
    .catch(() => {});
}
