import { useEffect, useState } from "react";
import { DONE_DEFAULTS, normalizeDoneSettings, type DoneSettings } from "@milagre/shared/done";
import type { MilagreBridge } from "../electron.d.ts";

/**
 * How long a Chat stays in the sidebar's Done list before this Mac archives it (Settings › Chats). The daemon keeps it;
 * every view follows a change from any device. An older daemon without it reads as the default.
 */
export function useDoneSettings(bridge: MilagreBridge = window.milagre) {
  const [settings, setSettings] = useState<DoneSettings>(DONE_DEFAULTS);
  useEffect(() => {
    let live = true;
    void bridge
      .readDoneSettings?.()
      .then((value) => live && setSettings(normalizeDoneSettings(value)))
      .catch(() => {});
    const off = bridge.onDoneSettings?.((value) => setSettings(normalizeDoneSettings(value)));
    return () => {
      live = false;
      off?.();
    };
  }, [bridge]);
  const save = async (patch: Partial<DoneSettings>) => {
    const previous = settings;
    setSettings(normalizeDoneSettings({ ...settings, ...patch }));
    try {
      setSettings(normalizeDoneSettings(await bridge.saveDoneSettings(patch)));
    } catch (error) {
      setSettings(previous);
      throw error;
    }
  };
  return { settings, save };
}
