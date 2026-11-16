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
