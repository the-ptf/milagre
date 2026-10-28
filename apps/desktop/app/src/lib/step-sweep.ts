/** Running titles sweep until the step finishes or waits for approval; reduced motion keeps the static tint (styles.css). */
export function useStepTitleSweep(running: boolean) {
  return { className: running ? "step-running step-sweep" : undefined };
}
