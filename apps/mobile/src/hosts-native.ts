import * as SecureStore from "expo-secure-store";
import { createChatDefaultsStore } from "./chat-defaults-store";
import { createHostsStore } from "./hosts-store";
import { createNavigationStore } from "./navigation-store";
import { createProjectOrderStore } from "./project-order-store";
import { createFoldedProjectsStore } from "./folded-projects-store";

export const savedProjectOrder = createProjectOrderStore({
  getItemAsync: SecureStore.getItemAsync,
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
});

/** The Project groups folded by hand in the sidebar, per computer; every other group is open. */
export const savedFoldedProjects = createFoldedProjectsStore({
  getItemAsync: SecureStore.getItemAsync,
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
});

export const savedNavigation = createNavigationStore({
  getItemAsync: SecureStore.getItemAsync,
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
});

export const savedHosts = createHostsStore({
  getItemAsync: SecureStore.getItemAsync,
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
  deleteItemAsync: SecureStore.deleteItemAsync,
});

export const savedChatDefaults = createChatDefaultsStore({
  getItem: SecureStore.getItem,
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
});

const permissionKey = "milagre.permission.v1";
const MODES = ["ask", "auto", "full"];
/** The default permission mode for new Chats on this phone. */
export async function readPermission(): Promise<"ask" | "auto" | "full" | null> {
  try {
    const value = await SecureStore.getItemAsync(permissionKey);
    return value && MODES.includes(value) ? (value as "ask" | "auto" | "full") : null;
  } catch {
    return null;
  }
}
const attentionButtonKey = "milagre.attention-button.v1";
/** Whether the Chat shows the button to another Project's waiting Chat; on unless turned off. */
export async function readAttentionButton(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(attentionButtonKey)) !== "off";
  } catch {
    return true;
  }
}
export async function saveAttentionButton(on: boolean) {
  try {
    await SecureStore.setItemAsync(attentionButtonKey, on ? "on" : "off");
  } catch {
    /* best effort */
  }
}
const muriloModeKey = "milagre.murilo-mode.v1";
const floatingInboxKey = "milagre.floating-inbox.v1";
export async function readFloatingInbox(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(floatingInboxKey)) === "on";
  } catch {
    return false;
  }
}
export async function saveFloatingInbox(on: boolean) {
  try {
    await SecureStore.setItemAsync(floatingInboxKey, on ? "on" : "off");
  } catch {
    /* best effort */
  }
}
const floatingInboxActivityKey = "milagre.floating-inbox-activity.v1";
export async function readFloatingInboxActivity(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(floatingInboxActivityKey)) !== "off";
  } catch {
    return true;
  }
}
export async function saveFloatingInboxActivity(on: boolean) {
  try {
    await SecureStore.setItemAsync(floatingInboxActivityKey, on ? "on" : "off");
  } catch {
    /* best effort */
  }
}
/** Experimental: whether a reply's tool calls show in the Chat one row each instead of folding into one line; off unless turned on. */
export async function readMuriloMode(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(muriloModeKey)) === "on";
  } catch {
    return false;
  }
}
export async function saveMuriloMode(on: boolean) {
  try {
    await SecureStore.setItemAsync(muriloModeKey, on ? "on" : "off");
  } catch {
    /* best effort */
  }
}
const ultracodeFatalityKey = "milagre.ultracode-fatality.v1";
/** Experimental: whether turning Ultracode on plays the Fatality overlay; off unless turned on. */
export async function readUltracodeFatality(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(ultracodeFatalityKey)) === "on";
  } catch {
    return false;
  }
}
export async function saveUltracodeFatality(on: boolean) {
  try {
    await SecureStore.setItemAsync(ultracodeFatalityKey, on ? "on" : "off");
  } catch {
    /* best effort */
  }
}
const themeKey = "milagre.theme.v1";
/** The saved color theme settings as raw JSON, or null when nothing is saved yet. */
export async function readThemeSettings(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(themeKey);
  } catch {
    return null;
  }
}
export async function saveThemeSettings(raw: string) {
  try {
    await SecureStore.setItemAsync(themeKey, raw);
  } catch {
    /* best effort */
  }
}
export async function savePermission(mode: string) {
  try {
    await SecureStore.setItemAsync(permissionKey, mode);
  } catch {
    /* best effort */
  }
}
