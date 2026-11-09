import { useSyncExternalStore } from "react";

// One small notice at a time, shown for a few seconds: "File not found" after a link that goes nowhere.
const NOTICE_MS = 3500;
/** A confirmation of something done ("Chat archived"): brief, and gone once the user goes elsewhere. */
export const BRIEF_NOTICE_MS = 3000;

type Notice = { id: number; text: string; leaveOnNavigate: boolean };
type NoticeOptions = {
  /** How long it stays; 3.5 s by default. */
  ms?: number;
  /** Navigating to another Chat or a New chat clears it. */
  leaveOnNavigate?: boolean;
};

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

export function showNotice(text: string, { ms = NOTICE_MS, leaveOnNavigate = false }: NoticeOptions = {}) {
  current = { id: ++counter, text, leaveOnNavigate };
  clearTimeout(timer);
  timer = setTimeout(() => {
    current = null;
    emit();
  }, ms);
  emit();
}

/** The user went to another Chat or started a New chat: a notice that said so is dropped, any other one runs its time. */
export function clearNoticeOnNavigate() {
  if (!current?.leaveOnNavigate) return;
  clearTimeout(timer);
  current = null;
  emit();
}

/** The notice on show now, if any. */
export function currentNotice() {
  return current;
}

export function useNotice() {
  return useSyncExternalStore(subscribe, currentNotice);
}
