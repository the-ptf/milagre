/** How long the sidebar waits before reading a computer again, and how many of its requests may run at once. */

/** The open computer is read this often; every other computer, and the Projects' own lists, less often. */
export const CURRENT_EVERY = 4000;
export const OTHER_EVERY = 10000;
/** A computer that stopped answering is asked again no sooner than this, and the wait doubles to the cap. */
export const OFFLINE_EVERY = 30000;
export const FAILURE_CAP = 120000;
/** A computer's Project list (three requests on the Mac) is reread this often. */
export const PROJECTS_EVERY = 60000;
export const REQUESTS_AT_ONCE = 3;

/** `base` plus or minus 20%, so computers read at the same moment drift apart instead of asking together. */
export function jitter(base: number, random: () => number): number {
  return Math.round(base * (0.8 + 0.4 * random()));
}

/** The wait before a computer's next read: its usual cadence, then twice that after a failure, 30 s once it failed twice, doubling to two minutes. */
export function nextDelay({ current, failures, random }: { current: boolean; failures: number; random: () => number }): number {
  const base = current ? CURRENT_EVERY : OTHER_EVERY;
  if (failures <= 0) return jitter(base, random);
  const wait = failures === 1 ? base * 2 : OFFLINE_EVERY * 2 ** (failures - 2);
  return jitter(Math.min(FAILURE_CAP, wait), random);
}

/**
 * A first-in-first-out limit on the requests one computer has in flight. `weight` is how many requests a job makes at
 * once (the Project list is three), so the cap counts what the Mac counts. The oldest waiting job is never passed by a
 * lighter one, so a heavy job can't starve.
 */
export function createLimiter(capacity: number) {
  let used = 0;
  const waiting: { weight: number; start: () => void }[] = [];
  const drain = () => {
    while (waiting.length && used + waiting[0]!.weight <= capacity) {
      const next = waiting.shift()!;
      used += next.weight;
      next.start();
    }
  };
  return {
    get inFlight() {
      return used;
    },
    get queued() {
      return waiting.length;
    },
    run<T>(weight: number, work: () => Promise<T>): Promise<T> {
      const cost = Math.min(Math.max(1, weight), capacity);
      return new Promise<T>((resolve, reject) => {
        waiting.push({
          weight: cost,
          start: () => {
            let running: Promise<T>;
            try {
              running = work();
            } catch (error) {
              running = Promise.reject(error);
            }
            running.then(resolve, reject).finally(() => {
              used -= cost;
              drain();
            });
          },
        });
        drain();
      });
    },
  };
}
