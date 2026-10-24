// Opt-in timing of a Chat switch, from the click to the frame its transcript is on screen. Nothing about the Chat is
// recorded. Turn it on with `localStorage.setItem("milagre.measureNavigation", "1")`, then read
// `performance.getEntriesByName("milagre:chat-switch")`: each entry's duration is the switch, and its detail's
// `commitMs` the part React spent before the first frame.

const NAME = "milagre:chat-switch";
const enabled = () => typeof localStorage !== "undefined" && localStorage.getItem("milagre.measureNavigation") === "1";

let pending: { key: string; start: number } | undefined;
let frame = 0;

/** The user asked for Chat `key`; the next commit of its transcript ends the measure. */
export function beginChatSwitch(key: string) {
  if (!enabled()) return;
  pending = { key, start: performance.now() };
  cancelAnimationFrame(frame);
}

/** Chat `key`'s transcript committed; the measure ends two frames later, an upper bound on when it was presented. */
export function commitChatSwitch(key: string) {
  if (!enabled() || pending?.key !== key) return;
  const sample = pending;
  const commit = performance.now();
  frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => {
      if (pending !== sample) return;
      pending = undefined;
      if (performance.getEntriesByName(NAME).length >= 100) performance.clearMeasures(NAME);
      performance.measure(NAME, { start: sample.start, end: performance.now(), detail: { commitMs: commit - sample.start } });
    });
  });
}
