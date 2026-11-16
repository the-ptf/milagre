export const CURRENT_EVERY = 4000;
export const OTHER_EVERY = 10000;
export const OFFLINE_EVERY = 30000;
export const FAILURE_CAP = 120000;
export const PROJECTS_EVERY = 60000;
export const REQUESTS_AT_ONCE = 3;

export function jitter(base: number, random: () => number): number {
  return Math.round(base * (0.8 + 0.4 * random()));
}

export function nextDelay({ current, failures, random }: { current: boolean; failures: number; random: () => number }): number {
  const base = current ? CURRENT_EVERY : OTHER_EVERY;
  if (failures <= 0) return jitter(base, random);
  const wait = failures === 1 ? base * 2 : OFFLINE_EVERY * 2 ** (failures - 2);
  return jitter(Math.min(FAILURE_CAP, wait), random);
}

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
