/**
 * How many characters the widest number of an ordered list takes: "9." needs one, "10." two. Desktop and the phone
 * size the marker column from it, so item 10 shows whole and every item's text starts at the same edge.
 * A reversed list (HTML `reversed`) counts down from `start`, or from its length when it has none.
 */
export function orderedListDigits(start: number | undefined, count: number, reversed = false): number {
  const items = Math.max(1, count);
  const first = Number.isFinite(start) ? Math.trunc(start as number) : reversed ? items : 1;
  const last = reversed ? first - (items - 1) : first + (items - 1);
  return Math.max(String(first).length, String(last).length);
}
