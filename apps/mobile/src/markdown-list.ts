import { orderedListDigits } from "@milagre/shared/ordered-list";

export function orderedListLabels(start: number, count: number): { labels: string[]; widest: string } {
  return {
    labels: Array.from({ length: count }, (_, index) => `${start + index}.`),
    widest: `${"0".repeat(orderedListDigits(start, count))}.`,
  };
}
