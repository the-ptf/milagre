/** Two introductory sweeps, then a static running title. The deadline belongs to the host's step, not its UI. */
export const SWEEP_MS = 2400;
export const SWEEP_PERIOD_MS = 1200;

/** Missing/invalid times (older hosts) and future times (clock skew) stay static instead of replaying. */
export function sweepRemainingMs(startedAt: number | undefined, now: number): number {
  if (startedAt === undefined || !Number.isFinite(startedAt) || startedAt <= 0 || startedAt > now) return 0;
  return Math.max(0, SWEEP_MS - (now - startedAt));
}

/** A stable external-store snapshot for one attachment. Expiry is terminal, even if the wall clock changes. */
export function createStepSweepWindow(startedAt: number | undefined, enabled: boolean) {
  let remaining = enabled ? sweepRemainingMs(startedAt, Date.now()) : 0;
  return {
    getSnapshot: () => {
      if (remaining && !sweepRemainingMs(startedAt, Date.now())) remaining = 0;
      return remaining;
    },
    subscribe: (notify: () => void) => {
      if (!remaining) return () => {};
      const timer = setTimeout(
        () => {
          remaining = 0;
          notify();
        },
        sweepRemainingMs(startedAt, Date.now()),
      );
      return () => clearTimeout(timer);
    },
  };
}
