const pad = (value: number) => String(value).padStart(2, "0");

/** Remaining time, rounded up so a live request never reads 0:00 before its deadline. */
export function formatCountdown(ms: number): string {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`;
}

/** Whole seconds for live elapsed labels; finished durations keep their own rounding rules. */
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${pad(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m ${pad(seconds % 60)}s`;
}

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
    // A copy: subscribers can change subscriptions during a tick.
    for (const listener of Array.from(listeners)) listener();
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
