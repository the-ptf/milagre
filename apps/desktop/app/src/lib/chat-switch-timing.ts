import { preferenceStorage as localStorage } from "./preference-storage.ts";
import { afterPaint } from "@milagre/shared/after-paint";
// Opt-in timing of a Chat switch, from the click to the frame its transcript is on screen. Nothing about the Chat is
// recorded. Turn it on with `localStorage.setItem("milagre.measureNavigation", "1")`, then read
// `performance.getEntriesByName("milagre:chat-switch")`: each entry's duration is the switch, and its detail's
// `commitMs` the part React spent before the first frame.

const NAME = "milagre:chat-switch";
// A switch whose transcript never commits (its Chat failed to load, or another one was picked) is dropped after this.
const EXPIRE_MS = 10_000;
const enabled = () => typeof localStorage !== "undefined" && localStorage.getItem("milagre.measureNavigation") === "1";

let pending: { key: string; start: number } | undefined;
let cancelPaint: (() => void) | undefined;
// The Chat whose transcript committed last: asking for it again is no switch, and no commit would end the measure.
let shown: string | null = null;

// A switch's side panels (Browser, Changes, Designs) that open or close because another Chat came on screen land at once
// (chatSwitching). Their spring changes the chat's width on every frame, and each frame lays out and paints the whole
// transcript again: on a 6K display the window went blank for a few frames after a switch. A switch counts from the ask
// until its transcript commits (at most SWITCH_PENDING_MS), then SWITCH_SETTLE_MS more for panels that mount just after.
const SWITCH_PENDING_MS = 2_000;
const SWITCH_SETTLE_MS = 300;
let switching: { key: string; start: number } | undefined;
let settleUntil = -Infinity;

/** Whether a Chat switch is under way: a panel opening or closing now does it at once instead of springing. */
export function chatSwitching(now = performance.now()) {
  return (switching !== undefined && now - switching.start < SWITCH_PENDING_MS) || now < settleUntil;
}

/** The user asked for Chat `key`; the next commit of its transcript ends the measure. The Chat already on screen starts none. */
export function beginChatSwitch(key: string) {
  if (key === shown) return;
  switching = { key, start: performance.now() };
  if (!enabled()) return;
  pending = { key, start: switching.start };
  cancelPaint?.();
}

/** The transcript on screen changed: a Chat's key, or null while none is (a new Chat, one still loading, none mounted). */
export function transcriptShown(key: string | null) {
  shown = key;
}

/** Chat `key`'s transcript committed; the measure ends two frames later, an upper bound on when it was presented. */
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
