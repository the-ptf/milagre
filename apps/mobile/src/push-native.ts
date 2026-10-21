import Constants, { ExecutionEnvironment } from "expo-constants";
import * as Device from "expo-device";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { createPushStore } from "./push-store";
import { shouldPresentNotification, type PushView } from "./push-controller";
import type { NotificationPermissionsStatus } from "expo-notifications";
import { NOTIFICATION_CHIMES, notificationChimeChannel, notificationChimeSound } from "@milagre/shared/notification-chimes";

import { notificationAllowed } from "@milagre/shared/notification-schedule";

export const pushStore = createPushStore(SecureStore, Crypto.randomUUID);
const isExpoGo = () => Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
const allowed = (permissions: NotificationPermissionsStatus) => permissions.granted || [2, 3, 4].includes(permissions.ios?.status ?? -1);
const notifications = () => import("expo-notifications");
const prepareChannel = async () => {
  if (Platform.OS === "android") {
    const api = await notifications();
    await api.setNotificationChannelAsync("chats", { name: "Chat activity", importance: api.AndroidImportance.HIGH, sound: "default" });
    // A channel's sound is fixed once created, so each chime has a channel of its own; a push names the
    // phone's chime's channel.
    for (const chime of NOTIFICATION_CHIMES) {
      if (chime.id === "system") continue;
      await api.setNotificationChannelAsync(notificationChimeChannel(chime.id), {
        name: `Chat activity (${chime.label})`,
        importance: api.AndroidImportance.HIGH,
        sound: notificationChimeSound(chime.id),
      });
    }
  }
};
export const pushNative = {
  available() {
    if (isExpoGo()) return "Install a Milagre build on your phone to enable notifications.";
    if (!Device.isDevice) return "Notifications can be enabled on your phone. This simulator cannot receive remote push alerts.";
    return "";
  },
  async permission() {
    return allowed(await (await notifications()).getPermissionsAsync());
  },
  async requestPermission() {
    await prepareChannel();
    const api = await notifications();
    const current = await api.getPermissionsAsync();
    return allowed(current) || allowed(await api.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: true, allowSound: true } }));
  },
  async token() {
    await prepareChannel();
    const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    if (!projectId) throw new Error("This Milagre build is missing its notification configuration. Install the latest build.");
    try {
      return (await (await notifications()).getExpoPushTokenAsync({ projectId })).data;
    } catch {
      throw new Error("Could not set up notifications. Check your connection and try again.");
    }
  },
  async listen(view: () => PushView, tapped: (data: unknown) => void, rotated: () => void) {
    if (isExpoGo()) return () => {};
    const api = await notifications();
    api.setNotificationHandler({
      handleNotification: async (notice) => {
        const show = shouldPresentNotification(notice.request.content.data, view()) && notificationAllowed((await pushStore.read()).schedule);
        return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
      },
    });
    const receive = (response: ReturnType<typeof api.getLastNotificationResponse>) => {
      if (!response || response.actionIdentifier !== api.DEFAULT_ACTION_IDENTIFIER) return;
      api.clearLastNotificationResponse();
      tapped(response.notification.request.content.data);
    };
    const taps = api.addNotificationResponseReceivedListener(receive);
    const tokens = api.addPushTokenListener(rotated);
    receive(api.getLastNotificationResponse());
    return () => {
      taps.remove();
      tokens.remove();
      api.setNotificationHandler(null);
    };
  },
};
