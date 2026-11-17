import { useSyncExternalStore } from "react";
import * as SecureStore from "expo-secure-store";
import { normalizeSnoozeMinutes, normalizeSnoozePresets, SNOOZE_DEFAULTS, type SnoozePreset } from "@milagre/shared/snooze";

function deviceSetting<T>(key: string, initial: T, parse: (saved: string) => T, serialize: (value: T) => string) {
  let value = initial;
  let changed = false;
  const listeners = new Set<() => void>();
  void (async () => {
    const saved = await SecureStore.getItemAsync(key).catch(() => null);
    if (changed || saved === null) return;
    value = parse(saved);
    listeners.forEach((listener) => listener());
  })();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const set = (next: T) => {
    changed = true;
    value = next;
    listeners.forEach((listener) => listener());
    void SecureStore.setItemAsync(key, serialize(value), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }).catch(() => {});
  };
  return (): [T, (next: T) => void] => [useSyncExternalStore(subscribe, () => value), set];
}

const parsePresets = (saved: string) => {
  try {
    return normalizeSnoozePresets(JSON.parse(saved));
  } catch {
    return normalizeSnoozePresets(undefined);
  }
};

const minutesSetting = deviceSetting("milagre.snooze-minutes.v1", SNOOZE_DEFAULTS.minutes, (saved) => normalizeSnoozeMinutes(Number(saved)), String);
const presetsSetting = deviceSetting<SnoozePreset[]>("milagre.snooze-presets.v1", normalizeSnoozePresets(undefined), parsePresets, JSON.stringify);

export function useSnoozeMinutes(): [number, (next: number) => void] {
  const [minutes, set] = minutesSetting();
  return [minutes, (next) => set(normalizeSnoozeMinutes(next))];
}

/** The choices in every Chat's Snooze until menu. Kept per device, like Snooze for. */
export function useSnoozePresets(): [SnoozePreset[], (next: SnoozePreset[]) => void] {
  const [presets, set] = presetsSetting();
  return [presets, (next) => set(normalizeSnoozePresets(next))];
}
