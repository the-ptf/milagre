import { useEffect, useState } from "react";
import type { KeepAwakeSettings, MilagreBridge } from "../electron.d.ts";

const OFF: KeepAwakeSettings = { enabled: false };
const normalize = (value: Partial<KeepAwakeSettings> | null | undefined): KeepAwakeSettings => ({ enabled: value?.enabled === true });

/**
 * Whether a computer keeps itself awake while Milagre runs (Settings › General › System). Its host keeps it, off until
 * someone turns it on; every view follows a change from any device. An older host without it reads as off. A change
 * made while the host connection was down sends no event this window hears, so it is read again on each reconnect.
 */
export function useKeepAwakeSettings(bridge: MilagreBridge = window.milagre) {
  const [settings, setSettings] = useState<KeepAwakeSettings>(OFF);
  useEffect(() => {
    let live = true;
    const read = () =>
      void bridge
        .readKeepAwakeSettings?.()
        .then((value) => live && setSettings(normalize(value)))
        .catch(() => {});
    read();
    const off = bridge.onKeepAwakeSettings?.((value) => setSettings(normalize(value)));
    const offConnection = bridge.onRuntimeConnection?.((state) => {
      if (state.connected) read();
    });
    return () => {
      live = false;
      off?.();
      offConnection?.();
    };
  }, [bridge]);
  const save = async (patch: Partial<KeepAwakeSettings>) => {
    const previous = settings;
    setSettings(normalize({ ...settings, ...patch }));
    try {
      setSettings(normalize(await bridge.saveKeepAwakeSettings(patch)));
    } catch (error) {
      setSettings(previous);
      throw error;
    }
  };
  return { settings, save };
}
