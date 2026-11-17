import { useState } from "react";

/**
 * A split's sizes: each column's weight, kept under the Chat at its top, and the share of its column the top Chat takes,
 * kept under the Chat stacked below it. A column or row with nothing kept splits evenly.
 */
export type SplitSizes = { columns: Readonly<Record<string, number>>; rows: Readonly<Record<string, number>> };

const SIZES_KEY = "milagre.chatSplitSizes";
const EMPTY: SplitSizes = { columns: {}, rows: {} };

const numbers = (value: unknown): Record<string, number> =>
  value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0))
    : {};

export function readSplitSizes(storage: Pick<Storage, "getItem">): SplitSizes {
  try {
    const value = JSON.parse(storage.getItem(SIZES_KEY) ?? "{}") as { columns?: unknown; rows?: unknown };
    return { columns: numbers(value.columns), rows: numbers(value.rows) };
  } catch {
    return EMPTY;
  }
}

export function saveSplitSizes(storage: Pick<Storage, "setItem">, sizes: SplitSizes) {
  storage.setItem(SIZES_KEY, JSON.stringify(sizes));
}

/** Two neighbouring columns share their weights again after a drag leaves the first with `share` of the pair. */
export function shareColumns(sizes: SplitSizes, left: string, right: string, share: number): SplitSizes {
  const total = (sizes.columns[left] ?? 1) + (sizes.columns[right] ?? 1);
  return { ...sizes, columns: { ...sizes.columns, [left]: total * share, [right]: total * (1 - share) } };
}

export function shareRows(sizes: SplitSizes, below: string, share: number): SplitSizes {
  return { ...sizes, rows: { ...sizes.rows, [below]: share } };
}

/** Each column's weight and where it sits, in percent of the split's width, with the share its top Chat takes. */
export function placeColumns(columns: readonly (readonly string[])[], sizes: SplitSizes) {
  const weights = columns.map((column) => sizes.columns[column[0] ?? ""] ?? 1);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const starts = weights.map((_, index) => (weights.slice(0, index).reduce((sum, weight) => sum + weight, 0) / total) * 100);
  const placed = columns.map((column, index) => ({
    left: starts[index] ?? 0,
    width: ((weights[index] ?? 1) / total) * 100,
    share: column[1] ? (sizes.rows[column[1]] ?? 0.5) : 1,
  }));
  return { weights, total, placed };
}

export function useSplitSizes() {
  const [sizes, setSizes] = useState(() => readSplitSizes(localStorage));
  const change = (next: SplitSizes, commit: boolean) => {
    setSizes(next);
    if (commit) saveSplitSizes(localStorage, next);
  };
  return { sizes, change };
}
