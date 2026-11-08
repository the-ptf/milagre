import { useSyncExternalStore } from "react";
import { parseDevicePins, setPin, type DevicePins } from "@milagre/shared/chat-pins";
import type { AgentSession } from "@milagre/shared/model";
import { preferenceStorage as localStorage } from "./preference-storage.ts";

// This Mac's pins, by scope key (the sidebar's: a Project path, `<computer>|<path>`, a Link's key). They stay here,
// like the Chat order and the filters: another computer's sidebar and the phone keep their own (chat-pins.ts in shared).
const STORAGE_KEY = "milagre.chatPins";

function load(): DevicePins {
  try {
    return parseDevicePins(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"));
  } catch {
    return {};
  }
}

// Read on first use, not on import, so whatever runs before the first list sees storage as it is then.
let current: DevicePins | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getPins() {
  return (current ??= load());
}

/** This Mac's pins; a change re-renders the lists that show them. */
export function useChatPins(): DevicePins {
  return useSyncExternalStore(subscribe, getPins);
}

type Sessions = Iterable<Pick<AgentSession, "id" | "pinned" | "pin_order">>;

/** Pins Chat `id` of `scope` at `order` on this Mac, or unpins it for null. `sessions` are the scope's Chats. */
export function pinChat(scope: string, sessions: Sessions, id: number, order: number | null) {
  current = setPin(getPins(), scope, sessions, id, order);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // The pin still shows for this session when storage is unavailable.
  }
  listeners.forEach((listener) => listener());
}

// The bar, inbox and main window share the saved pins.
window.addEventListener("storage", (event) => {
  if (event.key !== STORAGE_KEY) return;
  current = load();
  listeners.forEach((listener) => listener());
});
