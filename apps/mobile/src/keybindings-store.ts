import { useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { defaultKeybindings, type KeybindingCommandId, type KeybindingRule, type KeybindingsState } from "@milagre/shared/keybindings";
import type { LiveOptions } from "./live";

// The connected Mac's keybindings.json (core keybindings.cjs): the iPad's hardware keyboard runs its rules, and Settings ›
// Keybindings edits it. Read when held, again on each `keybindings` signal and on return to the app. An older Mac
// refuses the read and a confined connection answers nothing: both keep the defaults, and neither gets a socket.

export type KeybindingsClient = {
  call: <T>(method: string, args: unknown[]) => Promise<T>;
  live: (path: string, options: Pick<LiveOptions, "onSignal" | "onStatus">) => { close(): void };
};
/** `state` is null until the Mac answers, and stays null on a Mac or connection without keybindings. */
export type HostKeybindings = { state: KeybindingsState | null; error: string };

const NONE: HostKeybindings = { state: null, error: "" };

function createStore(client: KeybindingsClient) {
  let current = NONE;
  let refs = 0;
  let live: { close(): void } | null = null;
  let unwatch: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const set = (next: HostKeybindings) => {
    current = next;
    for (const listener of listeners) listener();
  };
  function openLive() {
    if (live || refs === 0) return;
    let down = false;
    live = client.live("", {
      onSignal: (signal) => {
        if (signal === "keybindings") void read();
      },
      onStatus: (up) => {
        if (up && down) void read();
        down = !up;
      },
    });
  }
  async function read() {
    try {
      const state = await client.call<KeybindingsState | null>("keybindings:read", []);
      if (!state || !Array.isArray(state.rules)) {
        set(NONE);
        return;
      }
      set({ state, error: "" });
      openLive();
    } catch (failure) {
      if (/not available from mobile/i.test((failure as Error)?.message ?? "")) set(NONE);
      else set({ state: current.state, error: failure instanceof Error ? failure.message : "Could not read keybindings." });
    }
  }
  /** Runs a write and shows the state it answers with; a failure stays in `error`. */
  async function write(method: string, args: unknown[]) {
    try {
      set({ state: await client.call<KeybindingsState>(method, args), error: "" });
    } catch (failure) {
      set({ state: current.state, error: failure instanceof Error ? failure.message : "Could not save keybindings." });
      throw failure;
    }
  }
  return {
    get: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    acquire() {
      refs++;
      if (refs === 1) {
        void read();
        const watch = AppState.addEventListener("change", (status) => {
          if (status === "active") void read();
        });
        unwatch = () => watch.remove();
      }
      return () => {
        refs--;
        if (refs > 0) return;
        live?.close();
        live = null;
        unwatch?.();
        unwatch = null;
      };
    },
    read,
    setCommand: (command: KeybindingCommandId, rules: { key: string; when?: string }[]) => write("keybindings:set-command", [command, rules]),
    resetCommand: (command: KeybindingCommandId) => write("keybindings:reset-command", [command]),
    resetAll: () => write("keybindings:reset", []),
  };
}

type Store = ReturnType<typeof createStore>;
// One store per client: a new connection gets a new client, and a late answer from the Mac the phone left stays on its own.
const stores = new WeakMap<object, Store>();
function storeFor(client: KeybindingsClient): Store {
  let store = stores.get(client);
  if (!store) {
    store = createStore(client);
    stores.set(client, store);
  }
  return store;
}

const subscribeNone = () => () => {};
const none = () => NONE;

/** The connected Mac's keybindings, live, and the writes Settings makes. */
export function useHostKeybindings(client: KeybindingsClient | null) {
  const store = client ? storeFor(client) : null;
  const value = useSyncExternalStore(store?.subscribe ?? subscribeNone, store?.get ?? none);
  useEffect(() => store?.acquire(), [store]);
  return { ...value, store };
}

/** The rules to run: the Mac's, or the defaults until it answers (and on a Mac without keybindings). */
export function rulesOf(value: HostKeybindings): KeybindingRule[] {
  return value.state?.rules ?? DEFAULTS;
}
const DEFAULTS = defaultKeybindings();
