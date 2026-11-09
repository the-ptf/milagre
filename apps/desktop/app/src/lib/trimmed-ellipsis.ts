/**
 * Where CSS would cut `label` to fit `width` with an ellipsis, when that cut lands right after a space ("Keep the Chat
 * timer …"): the same text with the space trimmed and its own ellipsis. Null when it fits, or the cut is mid-word, so
 * CSS truncation stays the base and draws every other case.
 */
export function trimmedEllipsis(label: string, width: number, measure: (text: string) => number): string | null {
  if (width <= 0 || measure(label) <= width) return null;
  const room = width - measure("…");
  let low = 0;
  let high = label.length;
  // The longest prefix that fits beside the ellipsis.
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure(label.slice(0, mid)) <= room) low = mid;
    else high = mid - 1;
  }
  const cut = label.slice(0, low);
  if (!/\s$/.test(cut)) return null;
  const trimmed = cut.trimEnd();
  return trimmed ? `${trimmed}…` : null;
}
