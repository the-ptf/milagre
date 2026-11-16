import { useSyncExternalStore } from "react";
import { parseDevicePins, setPin, type DevicePins } from "@milagre/shared/chat-pins";
import type { AgentSession } from "@milagre/shared/model";
import { preferenceStorage as localStorage } from "./preference-storage.ts";

const STORAGE_KEY = "milagre.chatPins";

function load(): DevicePins {
  try {
    return parseDevicePins(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}"));
  } catch {
    return {};
  }
}

let current: DevicePins | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getPins() {
  return (current ??= load());
}

export function useChatPins(): DevicePins {
  return useSyncExternalStore(subscribe, getPins);
}

type Sessions = Iterable<Pick<AgentSession, "id" | "pinned" | "pin_order">>;

export function pinChat(scope: string, sessions: Sessions, id: number, order: number | null) {
  current = setPin(getPins(), scope, sessions, id, order);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {}
  listeners.forEach((listener) => listener());
}

window.addEventListener("storage", (event) => {
  if (event.key !== STORAGE_KEY) return;
  current = load();
  listeners.forEach((listener) => listener());
});
