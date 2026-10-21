/** A wall clock for display labels only. It never controls agent work, connections, polling or notifications. */
export function createDisplayClock<Timer = ReturnType<typeof setInterval>>({
  intervalMs,
  isVisible,
  onVisibility,
  now = Date.now,
  setInterval: schedule = globalThis.setInterval as unknown as (fn: () => void, ms: number) => Timer,
  clearInterval: cancel = globalThis.clearInterval as unknown as (timer: Timer) => void,
}: {
  intervalMs: number;
  isVisible: () => boolean;
  onVisibility: (listener: () => void) => () => void;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => Timer;
  clearInterval?: (timer: Timer) => void;
}) {
  let value = now();
  let timer: Timer | undefined;
  let off: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const tick = () => {
    const next = now();
    if (next === value) return;
    value = next;
    for (const listener of [...listeners]) listener();
  };
  const stop = () => {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
  };
  const visibility = () => {
    stop();
    if (!isVisible()) return;
    tick();
    timer = schedule(tick, intervalMs);
  };
  return {
    snapshot: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        value = now();
        off = onVisibility(visibility);
        visibility();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          stop();
          off?.();
          off = undefined;
        }
      };
    },
  };
}
