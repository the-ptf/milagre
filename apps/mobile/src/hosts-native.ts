import * as SecureStore from "expo-secure-store";
import {
  parseChatList,
  parseCompactButtonDisplay,
  parseToolCallDisplay,
  type ChatList,
  type CompactButtonDisplay,
  type ToolCallDisplay,
} from "@milagre/shared/chat-display";
import { dictationLanguage, whisperModelFor, dictationFixModel, type DictationFixModel } from "@milagre/shared/dictation";
import { parseDictationAction, type DictationActionPreference } from "@milagre/shared/voice-dictation";
import { createChatDefaultsStore } from "./chat-defaults-store";
import { createHostsStore } from "./hosts-store";
import { createNavigationStore } from "./navigation-store";
import { createProjectOrderStore } from "./project-order-store";
import { createFoldedProjectsStore } from "./folded-projects-store";
import { createHiddenProjectsStore } from "./hidden-projects-store";
import { createProviderUpdateDismissals } from "./provider-update-dismissals";

export const savedProjectOrder = createProjectOrderStore({
  getItemAsync: SecureStore.getItemAsync,
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
});

/** The Projects and Links hidden from the Projects list on this phone, per paired computer. */
export const savedHiddenProjects = createHiddenProjectsStore({
  getItemAsync: SecureStore.getItemAsync,
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
});

/** Provider update cards dismissed on this phone, per paired computer. */
export const savedProviderUpdateDismissals = createProviderUpdateDismissals({
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
const MODES = new Set(["ask", "auto", "full"]);
/** The default permission mode for new Chats on this phone. */
export async function readPermission(): Promise<"ask" | "auto" | "full" | null> {
  try {
    const value = await SecureStore.getItemAsync(permissionKey);
    return value && MODES.has(value) ? (value as "ask" | "auto" | "full") : null;
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
const toolCallDisplayKey = "milagre.tool-call-display.v1";
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
/** Settings › Chat › Tool call display; a phone that had Murilo mode on (the Experimental switch it replaces) reads as Full detail. */
export async function readToolCallDisplay(): Promise<ToolCallDisplay> {
  try {
    const saved = await SecureStore.getItemAsync(toolCallDisplayKey);
    return parseToolCallDisplay(saved, (await SecureStore.getItemAsync(muriloModeKey)) === "on");
  } catch {
    return "compact";
  }
}
export async function saveToolCallDisplay(display: ToolCallDisplay) {
  try {
    await SecureStore.setItemAsync(toolCallDisplayKey, display);
  } catch {
    /* best effort */
  }
}
const chatListKey = "milagre.chat-list.v1";
/** Settings › Chat › Chat list: how the sidebar lists Chats on this phone; One list unless chosen otherwise. */
export async function readChatList(): Promise<ChatList> {
  try {
    return parseChatList(await SecureStore.getItemAsync(chatListKey));
  } catch {
    return "list";
  }
}
export async function saveChatList(mode: ChatList) {
  try {
    await SecureStore.setItemAsync(chatListKey, mode);
  } catch {
    /* best effort */
  }
}
const expandReasoningKey = "milagre.expand-reasoning.v1";
const showContextSizeKey = "milagre.show-context-size.v1";
const compactButtonDisplayKey = "milagre.compact-button-display.v1";
export async function readShowContextSize(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(showContextSizeKey)) !== "off";
  } catch {
    return true;
  }
}
export async function saveShowContextSize(on: boolean) {
  try {
    await SecureStore.setItemAsync(showContextSizeKey, on ? "on" : "off");
  } catch {
    /* best effort */
  }
}
export async function readCompactButtonDisplay(): Promise<CompactButtonDisplay> {
  try {
    return parseCompactButtonDisplay(await SecureStore.getItemAsync(compactButtonDisplayKey));
  } catch {
    return "threshold";
  }
}
export async function saveCompactButtonDisplay(value: CompactButtonDisplay) {
  try {
    await SecureStore.setItemAsync(compactButtonDisplayKey, value);
  } catch {
    /* best effort */
  }
}
/** Settings › Chat › Always expand reasoning; off unless turned on. */
export async function readExpandReasoning(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(expandReasoningKey)) === "on";
  } catch {
    return false;
  }
}
export async function saveExpandReasoning(on: boolean) {
  try {
    await SecureStore.setItemAsync(expandReasoningKey, on ? "on" : "off");
  } catch {
    /* best effort */
  }
}
const panelWidthKey = "milagre.ipad-panel-width.v1";
/** The width the iPad's docked right panel was dragged to; null until it has been. */
export async function readPanelWidth(): Promise<number | null> {
  try {
    const saved = Number(await SecureStore.getItemAsync(panelWidthKey));
    return Number.isFinite(saved) && saved > 0 ? saved : null;
  } catch {
    return null;
  }
}
export async function savePanelWidth(width: number) {
  try {
    await SecureStore.setItemAsync(panelWidthKey, String(Math.round(width)));
  } catch {
    /* best effort */
  }
}
const dictationFixUpKey = "milagre.dictation-fix-up.v1";
const dictationFixModelKey = "milagre.dictation-fix-model.v1";
/** Settings › Chat › Dictation: whether the Mac's fix-up corrects a finished take's names, on unless turned off. */
export async function readDictationFixUp(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(dictationFixUpKey)) !== "off";
  } catch {
    return true;
  }
}
export async function saveDictationFixUp(on: boolean) {
  try {
    await SecureStore.setItemAsync(dictationFixUpKey, on ? "on" : "off");
  } catch {
    /* best effort */
  }
}
/** Settings › Chat › Dictation: the fix-up's model, "auto" for the Chat's own agent's smallest one. */
export async function readDictationFixModel(): Promise<DictationFixModel> {
  try {
    return dictationFixModel(await SecureStore.getItemAsync(dictationFixModelKey));
  } catch {
    return "auto";
  }
}
export async function saveDictationFixModel(model: DictationFixModel) {
  try {
    await SecureStore.setItemAsync(dictationFixModelKey, model);
  } catch {
    /* best effort */
  }
}
const dictationLanguageKey = "milagre.dictation-language.v1";
const dictationActionKey = "milagre.dictation-action.v1";
export async function readDictationAction(): Promise<DictationActionPreference> {
  try {
    return parseDictationAction(await SecureStore.getItemAsync(dictationActionKey));
  } catch {
    return "paste";
  }
}
export async function saveDictationAction(action: DictationActionPreference) {
  try {
    await SecureStore.setItemAsync(dictationActionKey, action);
  } catch {
    /* best effort */
  }
}
/** Settings › Chat › Dictation: a language code, or "auto" for experimental local language detection. */
export async function readDictationLanguage(): Promise<string> {
  try {
    return dictationLanguage(await SecureStore.getItemAsync(dictationLanguageKey));
  } catch {
    return "auto";
  }
}
export async function saveDictationLanguage(language: string) {
  try {
    await SecureStore.setItemAsync(dictationLanguageKey, language);
  } catch {
    /* best effort */
  }
}
const dictationModelKey = "milagre.dictation-model.v1";
export async function readDictationModel(): Promise<string> {
  try {
    return whisperModelFor("phone", await SecureStore.getItemAsync(dictationModelKey)).id;
  } catch {
    return whisperModelFor("phone", undefined).id;
  }
}
export async function saveDictationModel(id: string) {
  try {
    await SecureStore.setItemAsync(dictationModelKey, id);
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

const internalBrowserKey = "milagre.internal-browser.v1";
/** Device-local link preference, matching desktop's default. */
export async function readInternalBrowser(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(internalBrowserKey)) !== "off";
  } catch {
    return true;
  }
}
export async function saveInternalBrowser(on: boolean) {
  await SecureStore.setItemAsync(internalBrowserKey, on ? "on" : "off", {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}
