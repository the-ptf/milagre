import { placeDropped, type GridDropTarget } from "./grid-drop.ts";

/**
 * A split's Chats in order, and the ones stacked under the Chat before them. Columns hold one or two Chats: a stacked
 * Chat joins the column of the Chat before it when that column has room, and starts its own otherwise.
 */
export type SplitLayout = { keys: readonly string[]; stacked: readonly string[] };

export function splitColumns(keys: readonly string[], stacked: readonly string[]): string[][] {
  const below = new Set(stacked);
  const columns: string[][] = [];
  for (const key of keys) {
    const last = columns.at(-1);
    if (last && last.length === 1 && below.has(key)) last.push(key);
    else columns.push([key]);
  }
  return columns;
}

/** Whether a Chat can take another above or below it: its column holds only it. */
export function canStack(layout: SplitLayout, tile: string | null, focused: string | null): boolean {
  const anchor = tile ?? focused;
  if (anchor === null) return false;
  if (!layout.keys.length) return true;
  return splitColumns(layout.keys, layout.stacked).some((column) => column.length === 1 && column[0] === anchor);
}

/** Takes a Chat out of the split; a Chat stacked under it moves up to the top of its column. */
export function removeFromSplit(layout: SplitLayout, key: string): SplitLayout {
  if (!layout.keys.includes(key)) return layout;
  const column = splitColumns(layout.keys, layout.stacked).find((items) => items.includes(key));
  const promoted = column && column.length === 2 && column[0] === key ? column[1] : null;
  return { keys: layout.keys.filter((item) => item !== key), stacked: layout.stacked.filter((item) => item !== key && item !== promoted) };
}

/** Puts a dropped Chat beside a column, or above or below the Chat it was dropped on when that column has room. */
export function placeInSplit(layout: SplitLayout, key: string, target: Pick<GridDropTarget, "tile" | "axis" | "side">, focused: string | null): SplitLayout {
  const rest = removeFromSplit(layout, key);
  const keys = rest.keys.length ? rest.keys : focused && focused !== key ? [focused] : [];
  const anchor = target.tile ?? focused;
  const base = { keys, stacked: rest.stacked };
  if (target.axis === "y" && anchor !== null && keys.includes(anchor) && canStack(base, anchor, focused)) {
    const at = keys.indexOf(anchor);
    const next = [...keys];
    next.splice(target.side === "before" ? at : at + 1, 0, key);
    return { keys: next, stacked: [...rest.stacked, target.side === "before" ? anchor : key] };
  }
  const column = anchor === null ? undefined : splitColumns(keys, rest.stacked).find((items) => items.includes(anchor));
  const edge = (column && (target.side === "before" ? column[0] : column.at(-1))) ?? null;
  return { keys: placeDropped(keys, key, { tile: edge, side: target.side }, focused), stacked: rest.stacked };
}

/** A tile swapped for another Chat keeps its place, stacked or not. */
export function swapStacked(stacked: readonly string[], tile: string, next: string): readonly string[] {
  return stacked.includes(tile) ? stacked.map((key) => (key === tile ? next : key)) : stacked;
}
