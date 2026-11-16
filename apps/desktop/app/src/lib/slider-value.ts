const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** Nearest legal value on [min, max] for the step. `max` counts as a stop when the step does not
 * divide the range, so a pointer near the end does not snap back onto the last whole step. */
export function snapSliderValue(next: number, min: number, max: number, step: number): number {
  if (!(max > min)) return min;
  if (!(step > 0)) return clamp(next, min, max);
  const whole = Math.floor(Number(((max - min) / step).toFixed(6)));
  const lastWhole = Number((min + whole * step).toFixed(6));
  const onGrid = clamp(Math.round((next - min) / step) * step + min, min, lastWhole);
  const snapped = lastWhole < max && Math.abs(next - max) <= Math.abs(next - onGrid) ? max : onGrid;
  return Number(snapped.toFixed(6));
}
