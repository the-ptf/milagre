type LocalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type PreferenceBridge = {
  get(key: string): { value?: string | null; error?: string };
  set(key: string, value: string | null): { error?: string };
  onChanged?(listener: (change: { key: string; value: string | null }) => void): void;
};

/**
 * The native copy survives an update that moves the app to a different file URL. Each read of it is a synchronous call
 * to the main process, and the window reads some preferences on every render (the composer's, the hidden computers),
 * so a key read once is kept here: this window's own writes update it, and a storage event (another window's change,
 * which the main process reports) makes it read the key again.
 */
export function createPreferenceStorage(
  local: () => LocalStorage,
  native: () => PreferenceBridge | undefined,
): LocalStorage & { forget(key: string | null): void } {
  const cache = new Map<string, string | null>();
  return {
    getItem(key) {
      const bridge = native();
      if (!bridge) return local()?.getItem(key) ?? null;
      if (cache.has(key)) return cache.get(key) ?? null;
      const result = bridge.get(key);
      if (result.error) throw new Error(result.error);
      if (result.value !== undefined) {
        cache.set(key, result.value);
        return result.value;
      }
      // Migrate existing preferences without overwriting a newer native value or a deletion.
      const legacy = local().getItem(key);
      if (legacy !== null) {
        const saved = bridge.set(key, legacy);
        if (saved.error) throw new Error(saved.error);
      }
      cache.set(key, legacy);
      return legacy;
    },
    /** Reads `key` (every key for null) from the main process again next time. */
    forget(key) {
      if (key === null) cache.clear();
      else cache.delete(key);
    },
    setItem(key, value) {
      const bridge = native();
      if (bridge) {
        cache.delete(key);
        const saved = bridge.set(key, value);
        if (saved.error) throw new Error(saved.error);
        cache.set(key, value);
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
        cache.delete(key);
        const saved = bridge.set(key, null);
        if (saved.error) throw new Error(saved.error);
        cache.set(key, null);
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
  // Any storage event means the key may have changed behind this window's back: it is read again on its next use.
  // Registered first, so the listeners that read it again on the event already see the new value.
  window.addEventListener("storage", (event) => preferenceStorage.forget(event.key));
  window.milagrePreferences?.onChanged?.(({ key, value }) => {
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: value }));
  });
}
