import { useSyncExternalStore } from "react";

const NOTICE_MS = 3500;
export const BRIEF_NOTICE_MS = 3000;

type Notice = { id: number; text: string; leaveOnNavigate: boolean };
type NoticeOptions = {
  ms?: number;
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

export function clearNoticeOnNavigate() {
  if (!current?.leaveOnNavigate) return;
  clearTimeout(timer);
  current = null;
  emit();
}

export function currentNotice() {
  return current;
}

export function useNotice() {
  return useSyncExternalStore(subscribe, currentNotice);
}
