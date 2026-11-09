import { preferenceStorage as localStorage } from "./preference-storage.ts";
import { useState, useEffect, useCallback } from "react";
import type { EffortLevel, PermissionMode } from "../model";
import { readComposerPreferences, saveComposerPreferences, type ComposerPreferences } from "./composer-preferences";
import { getSettings, updateSettings } from "./settings";

export function useComposerPreferences(chatKey: string) {
  const [prefs, setPrefs] = useState<Record<string, ComposerPreferences>>(() => readComposerPreferences(localStorage));

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "milagre.composer-preferences") {
        setPrefs(readComposerPreferences(localStorage));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const updatePrefs = useCallback((patch: Partial<ComposerPreferences>, key: string) => {
    setPrefs((prev) => {
      const current = prev[key] ?? {};
      const next = { ...prev, [key]: { ...current, ...patch } };
      saveComposerPreferences(localStorage, key, patch);
      return next;
    });
  }, []);

  const current = prefs[chatKey] ?? {};
  const isNew = chatKey.endsWith("#new");

  const effort = current.effort ?? (localStorage.getItem("milagre.effort") as EffortLevel | null) ?? "high";
  const ultracode = current.ultracode ?? localStorage.getItem("milagre.ultracode") === "on";
  const fastMode = current.fastMode ?? localStorage.getItem("milagre.fastMode") === "on";
  const permissionMode = current.permissionMode ?? getSettings().defaultPermissionMode;

  const setEffort = useCallback(
    (level: EffortLevel) => {
      if (isNew) localStorage.setItem("milagre.effort", level);
      updatePrefs({ effort: level }, chatKey);
    },
    [chatKey, updatePrefs, isNew],
  );

  const setUltracode = useCallback(
    (on: boolean) => {
      if (isNew) localStorage.setItem("milagre.ultracode", on ? "on" : "off");
      updatePrefs({ ultracode: on }, chatKey);
    },
    [chatKey, updatePrefs, isNew],
  );

  const setFastMode = useCallback(
    (on: boolean) => {
      if (isNew) localStorage.setItem("milagre.fastMode", on ? "on" : "off");
      updatePrefs({ fastMode: on }, chatKey);
    },
    [chatKey, updatePrefs, isNew],
  );

  const setPermissionMode = useCallback(
    (mode: PermissionMode) => {
      if (isNew) updateSettings({ defaultPermissionMode: mode });
      updatePrefs({ permissionMode: mode }, chatKey);
    },
    [chatKey, updatePrefs, isNew],
  );

  return {
    effort,
    setEffort,
    ultracode,
    setUltracode,
    fastMode,
    setFastMode,
    permissionMode,
    /** The mode picked for this Chat, if any; `permissionMode` falls back to the default for new Chats. */
    pickedPermissionMode: current.permissionMode,
    setPermissionMode,
  };
}
