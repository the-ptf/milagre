type LocalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type PreferenceBridge = {
  get(key: string): { value?: string | null; error?: string };
  set(key: string, value: string | null): { error?: string };
  onChanged?(listener: (change: { key: string; value: string | null }) => void): void;
};

/** The native copy survives an update that moves the app to a different file URL. */
export function createPreferenceStorage(local: () => LocalStorage, native: () => PreferenceBridge | undefined): LocalStorage {
  return {
    getItem(key) {
      const bridge = native();
      if (!bridge) return local()?.getItem(key) ?? null;
      const result = bridge.get(key);
      if (result.error) throw new Error(result.error);
      if (result.value !== undefined) return result.value;
      // Migrate existing preferences without overwriting a newer native value or a deletion.
      const legacy = local().getItem(key);
      if (legacy !== null) {
        const saved = bridge.set(key, legacy);
        if (saved.error) throw new Error(saved.error);
      }
      return legacy;
    },
    setItem(key, value) {
      const bridge = native();
      if (bridge) {
        const saved = bridge.set(key, value);
        if (saved.error) throw new Error(saved.error);
      }
      try {
        local().setItem(key, value);
      } catch (error) {
        if (!bridge) throw error;
      }
    },
    removeItem(key) {
      const bridge = native();
      if (bridge) {
        const saved = bridge.set(key, null);
        if (saved.error) throw new Error(saved.error);
      }
      try {
        local().removeItem(key);
      } catch (error) {
        if (!bridge) throw error;
      }
    },
  };
}

export const preferenceStorage = createPreferenceStorage(
  () => globalThis.localStorage,
  () => (typeof window === "undefined" ? undefined : window.milagrePreferences),
);

// Copy even preferences belonging to screens that are not opened during this launch.
if (typeof window !== "undefined" && window.milagrePreferences) {
  try {
    const legacy = window.localStorage;
    for (let index = 0; index < legacy.length; index++) {
      const key = legacy.key(index);
      if (key && /^milagre[.:-]/.test(key)) preferenceStorage.getItem(key);
    }
  } catch (error) {
    console.warn("Could not migrate saved preferences", error);
  }
}

// Native changes also reach windows whose Chromium storage is empty or unavailable.
if (typeof window !== "undefined") {
  window.milagrePreferences?.onChanged?.(({ key, value }) => {
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: value }));
  });
}
