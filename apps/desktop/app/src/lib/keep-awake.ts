import { useEffect, useState } from "react";
import type { KeepAwakeSettings, MilagreBridge } from "../electron.d.ts";

const OFF: KeepAwakeSettings = { enabled: false };
const normalize = (value: Partial<KeepAwakeSettings> | null | undefined): KeepAwakeSettings => ({ enabled: value?.enabled === true });

/**
 * Whether a computer keeps itself awake while Milagre runs (Settings › General › System). Its host keeps it, off until
 * someone turns it on; every view follows a change from any device. An older host without it reads as off.
 */
export function useKeepAwakeSettings(bridge: MilagreBridge = window.milagre) {
  const [settings, setSettings] = useState<KeepAwakeSettings>(OFF);
  useEffect(() => {
    let live = true;
    void bridge
      .readKeepAwakeSettings?.()
      .then((value) => live && setSettings(normalize(value)))
      .catch(() => {});
    const off = bridge.onKeepAwakeSettings?.((value) => setSettings(normalize(value)));
    return () => {
      live = false;
      off?.();
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
