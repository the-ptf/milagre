/**
 * Where a roving-focus key goes among `count` items from `index` (-1 when none has focus yet): the arrows on `axis`
 * step by one (Up/Down by a row of `columns` in a grid), Home and End go to the ends. A list wraps round; a grid
 * stops at its edges. -1 when the key doesn't move.
 */
export function rovingIndex(
  key: string,
  index: number,
  count: number,
  { axis = "both", columns = 0 }: { axis?: "horizontal" | "vertical" | "both"; columns?: number } = {},
): number {
  if (!count) return -1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  const steps: Record<string, number> = {
    ...(axis !== "vertical" ? { ArrowLeft: -1, ArrowRight: 1 } : {}),
    ...(axis !== "horizontal" ? { ArrowUp: -(columns || 1), ArrowDown: columns || 1 } : {}),
  };
  const step = steps[key];
  if (step === undefined) return -1;
  if (index < 0) return step > 0 ? 0 : count - 1;
  const next = index + step;
  if (columns) return next >= 0 && next < count ? next : -1;
  return (next + count) % count;
}
