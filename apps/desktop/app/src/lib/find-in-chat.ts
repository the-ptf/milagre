/** Start offsets of every case-insensitive, non-overlapping occurrence of `query` in `text`. */
export function matchOffsets(text: string, query: string): number[] {
  if (!query) return [];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  // Lowercasing can change the length (e.g. "İ"); offsets would no longer line up with the original.
  if (haystack.length !== text.length) return [];
  const offsets: number[] = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) offsets.push(at);
  return offsets;
}

/** The next or previous match index, wrapping at both ends. */
export function stepMatch(current: number, total: number, direction: 1 | -1): number {
  if (total <= 0) return 0;
  return (current + direction + total) % total;
}

/** Keep the active match in range after the match list changed under it (e.g. a streaming reply). */
export function clampMatch(current: number, total: number): number {
  return total <= 0 ? 0 : Math.min(Math.max(current, 0), total - 1);
}

export function findLabel(query: string, current: number, total: number): string {
  if (!query) return "";
  return total ? `${current + 1} of ${total}` : "No results";
}

/** Which text node an offset into the joined text of `lengths` falls in, and where in it. A range start prefers the later node at a boundary, an end the earlier one. */
export function locateOffset(lengths: number[], offset: number, edge: "start" | "end"): { index: number; offset: number } {
  let before = 0;
  for (let index = 0; index < lengths.length; index++) {
    const length = lengths[index];
    if (length === undefined) continue;
    const end = before + length;
    if (edge === "start" ? offset < end : offset <= end) return { index, offset: offset - before };
    before = end;
  }
  return { index: Math.max(lengths.length - 1, 0), offset: lengths.at(-1) ?? 0 };
}
