import { preferenceStorage as localStorage } from "./preference-storage.ts";
import { afterPaint } from "@milagre/shared/after-paint";

const NAME = "milagre:chat-switch";
const EXPIRE_MS = 10_000;
const enabled = () => typeof localStorage !== "undefined" && localStorage.getItem("milagre.measureNavigation") === "1";

let pending: { key: string; start: number } | undefined;
let cancelPaint: (() => void) | undefined;
let shown: string | null = null;

const SWITCH_PENDING_MS = 2_000;
const SWITCH_SETTLE_MS = 300;
let switching: { key: string; start: number } | undefined;
let settleUntil = -Infinity;

export function chatSwitching(now = performance.now()) {
  return (switching !== undefined && now - switching.start < SWITCH_PENDING_MS) || now < settleUntil;
}

export function beginChatSwitch(key: string) {
  if (key === shown) return;
  switching = { key, start: performance.now() };
  if (!enabled()) return;
  pending = { key, start: switching.start };
  cancelPaint?.();
}

export function markChatSwitch(key: string) {
  const now = performance.now();
  if (key === shown || (switching?.key === key && now - switching.start < SWITCH_PENDING_MS)) return;
  switching = { key, start: now };
}

export function transcriptShown(key: string | null) {
  shown = key;
}

export function commitChatSwitch(key: string) {
  shown = key;
  if (switching?.key === key) {
    switching = undefined;
    settleUntil = performance.now() + SWITCH_SETTLE_MS;
  }
  if (!enabled() || pending?.key !== key) return;
  const sample = pending;
  const commit = performance.now();
  if (commit - sample.start > EXPIRE_MS) {
    pending = undefined;
    return;
  }
  cancelPaint?.();
  cancelPaint = afterPaint(() => {
    if (pending !== sample) return;
    pending = undefined;
    if (performance.getEntriesByName(NAME).length >= 100) performance.clearMeasures(NAME);
    performance.measure(NAME, { start: sample.start, end: performance.now(), detail: { commitMs: commit - sample.start } });
  });
}
