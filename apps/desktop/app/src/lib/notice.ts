import { useSyncExternalStore } from "react";

const NOTICE_MS = 3500;

type Notice = { id: number; text: string };

let current: Notice | null = null;
let counter = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  listeners.forEach((listener) => listener());
}

export function showNotice(text: string) {
  current = { id: ++counter, text };
  clearTimeout(timer);
  timer = setTimeout(() => {
    current = null;
    emit();
  }, NOTICE_MS);
  emit();
}

export function currentNotice() {
  return current;
}

export function useNotice() {
  return useSyncExternalStore(subscribe, currentNotice);
}
