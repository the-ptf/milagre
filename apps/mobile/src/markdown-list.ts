import { orderedListDigits } from "@milagre/shared/ordered-list";

/**
 * An ordered list's labels ("9.", "10.") and the widest one its numbers can make. The marker column takes the widest
 * label's width in tabular digits and each label sits at its right edge, as on desktop, so every item's text starts at
 * the same edge whether its number has one digit or two.
 */
export function orderedListLabels(start: number, count: number): { labels: string[]; widest: string } {
  return {
    labels: Array.from({ length: count }, (_, index) => `${start + index}.`),
    widest: `${"0".repeat(orderedListDigits(start, count))}.`,
  };
}
