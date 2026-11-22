import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";
import type { ChatList, CompactButtonDisplay, ToolCallDisplay } from "@milagre/shared/chat-display";
import { whisperModelFor, type DictationFixModel } from "@milagre/shared/dictation";
import type { DictationActionPreference } from "@milagre/shared/voice-dictation";
import {
  readChatList,
  readShowContextSize,
  readCompactButtonDisplay,
  saveShowContextSize,
  saveCompactButtonDisplay,
  readDictationLanguage,
  readDictationAction,
  readDictationFixUp,
  readDictationFixModel,
  readDictationModel,
  readExpandReasoning,
  readNewChatStats,
  readToolCallDisplay,
  saveChatList,
  saveDictationLanguage,
  saveDictationAction,
  saveDictationFixUp,
  saveDictationFixModel,
  saveDictationModel,
  saveExpandReasoning,
  saveNewChatStats,
  saveToolCallDisplay,
} from "./hosts-native";

function phoneSetting<T>(initial: T, read: () => Promise<T>, save: (value: T) => Promise<void>) {
  let value = initial;
  let changed = false;
  const listeners = new Set<() => void>();
  void read().then((saved) => {
    if (changed) return;
    value = saved;
    listeners.forEach((listener) => listener());
  });
  return function useSetting(): [T, (next: T) => void] {
    const current = useSyncExternalStore(
      (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      () => value,
    );
    return [
      current,
      (next) => {
        changed = true;
        value = next;
        listeners.forEach((listener) => listener());
        void save(next);
      },
    ];
  };
}

export const useToolCallDisplay = phoneSetting<ToolCallDisplay>("compact", readToolCallDisplay, saveToolCallDisplay);

export const useExpandReasoning = phoneSetting(false, readExpandReasoning, saveExpandReasoning);
export const useNewChatStats = phoneSetting(false, readNewChatStats, saveNewChatStats);
export const useShowContextSize = phoneSetting(true, readShowContextSize, saveShowContextSize);
export const useCompactButtonDisplay = phoneSetting<CompactButtonDisplay>("threshold", readCompactButtonDisplay, saveCompactButtonDisplay);

export const useChatList = phoneSetting<ChatList>("list", readChatList, saveChatList);

export const useDictationLanguage = phoneSetting<string>("auto", readDictationLanguage, saveDictationLanguage);

export const useDictationModel = phoneSetting<string>(whisperModelFor("phone", undefined).id, readDictationModel, saveDictationModel);

export const useDictationAction = phoneSetting<DictationActionPreference>("paste", readDictationAction, saveDictationAction);

export const useDictationSymbols = phoneSetting(
  false,
  async () => (await SecureStore.getItemAsync("milagre.dictation-symbols.v1").catch(() => null)) === "on",
  (value) => SecureStore.setItemAsync("milagre.dictation-symbols.v1", value ? "on" : "off").catch(() => {}),
);

export const useDictationFixUp = phoneSetting(true, readDictationFixUp, saveDictationFixUp);

export const useDictationFixModel = phoneSetting<DictationFixModel>("auto", readDictationFixModel, saveDictationFixModel);
