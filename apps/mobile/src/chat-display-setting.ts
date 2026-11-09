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
  readToolCallDisplay,
  saveChatList,
  saveDictationLanguage,
  saveDictationAction,
  saveDictationFixUp,
  saveDictationFixModel,
  saveDictationModel,
  saveExpandReasoning,
  saveToolCallDisplay,
} from "./hosts-native";

// Settings › Chat on this phone, read once and shared by Settings and every Chat.

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

/** Desktop's Tool call display: Compact folds a reply's tool calls into one row, Full detail shows each one. */
export const useToolCallDisplay = phoneSetting<ToolCallDisplay>("compact", readToolCallDisplay, saveToolCallDisplay);

/** Desktop's Always expand reasoning: thinking rows start open in the Activity sheet. */
export const useExpandReasoning = phoneSetting(false, readExpandReasoning, saveExpandReasoning);
export const useShowContextSize = phoneSetting(true, readShowContextSize, saveShowContextSize);
export const useCompactButtonDisplay = phoneSetting<CompactButtonDisplay>("threshold", readCompactButtonDisplay, saveCompactButtonDisplay);

/** Settings › Chat › Chat list: the sidebar's One list, or a group per Project that folds. */
export const useChatList = phoneSetting<ChatList>("list", readChatList, saveChatList);

/** Desktop's Dictation language: what the mic listens for, a language code or "auto". */
export const useDictationLanguage = phoneSetting<string>("auto", readDictationLanguage, saveDictationLanguage);

/** Settings › Chat › Dictation › Speech model: the Whisper model this phone runs, an id from WHISPER_MODELS.phone. */
export const useDictationModel = phoneSetting<string>(whisperModelFor("phone", undefined).id, readDictationModel, saveDictationModel);

export const useDictationAction = phoneSetting<DictationActionPreference>("paste", readDictationAction, saveDictationAction);

/** Settings › Chat › Dictation: the Mac corrects a finished take's misheard names, in place. */
export const useDictationFixUp = phoneSetting(true, readDictationFixUp, saveDictationFixUp);

/** Settings › Chat › Dictation › Model: the fix-up's model, "auto" for the Chat's own agent's smallest one. */
export const useDictationFixModel = phoneSetting<DictationFixModel>("auto", readDictationFixModel, saveDictationFixModel);
