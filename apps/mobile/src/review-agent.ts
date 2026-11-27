import { useCallback, useSyncExternalStore } from "react";
import { useFocusEffect } from "expo-router";
import type { Client } from "./client";
type SettingState = { enabled: boolean | null; saving: boolean; error: string };
const UNKNOWN: SettingState = { enabled: null, saving: false, error: "" };

/**
 * The Review agent switch of each computer, kept by that computer's host. `enabled` is null until read, and stays null
 * on a computer whose Milagre predates the review agent.
 */
function createReviewAgentSettings() {
  const states = new WeakMap<Client, SettingState>();
  const reads = new WeakMap<Client, number>();
  const listeners = new Set<() => void>();
  const set = (caller: Client, patch: Partial<SettingState>) => {
    states.set(caller, { ...(states.get(caller) ?? UNKNOWN), ...patch });
    for (const listener of listeners) listener();
  };
  return {
    get: (caller: Client | null) => (caller ? (states.get(caller) ?? UNKNOWN) : UNKNOWN),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async read(caller: Client) {
      const sent = (reads.get(caller) ?? 0) + 1;
      reads.set(caller, sent);
      const value = await caller.call<{ enabled: boolean } | null>("pr-reviews:settings:read", []).catch(() => null);
      if (reads.get(caller) !== sent || states.get(caller)?.saving) return;
      set(caller, { enabled: value ? value.enabled === true : null });
    },
    async save(caller: Client, enabled: boolean) {
      reads.set(caller, (reads.get(caller) ?? 0) + 1);
      set(caller, { saving: true, error: "" });
      try {
        const saved = await caller.call<{ enabled: boolean }>("pr-reviews:settings:save", [{ enabled }]);
        set(caller, { enabled: saved.enabled === true, saving: false });
      } catch (cause) {
        set(caller, { saving: false, error: cause instanceof Error && cause.message ? cause.message : "Could not change this setting." });
      }
    },
  };
}

const settings = createReviewAgentSettings();
export function useReviewAgent(client: Client | null) {
  const state = useSyncExternalStore(settings.subscribe, () => settings.get(client));
  useFocusEffect(
    useCallback(() => {
      if (client) void settings.read(client);
    }, [client]),
  );
  return { ...state, save: (enabled: boolean) => client && settings.save(client, enabled) };
}
