/**
 * A running title's muted tint (styles.css .step-running), and whether its SweepText draws the moving band. The band
 * shows until the step finishes or waits for approval; reduced motion hides it and keeps the tint.
 */
export function useStepTitleSweep(running: boolean) {
  return { className: running ? "step-running" : undefined, running };
}
