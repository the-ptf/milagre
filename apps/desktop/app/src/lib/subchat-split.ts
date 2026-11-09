// The split's few moves for a family of Chats (subchats.ts): what "Open beside parent", "Show all N side by side" and a
// tile's menu put on screen. A Chat on screen is focused; anything else ends the split, so these are the only ways in.

/** The two Chats "Open beside parent" shows: the parent first, then the open one. */
export const besideParent = (parent: string, open: string): string[] => [parent, open];

/** "Show all N side by side": the family's Chats in order, always including the focused one, Done or not. */
export function familySplit(family: { root: string; children: readonly string[] }, focused: string | null): string[] {
  const keys = [family.root, ...family.children];
  return focused !== null && !keys.includes(focused) ? [...keys, focused] : keys;
}

/** The split after a tile's menu swaps `tile` for `next`; unchanged when `next` is on screen already or `tile` isn't. */
export function swapTile(split: readonly string[], tile: string, next: string): readonly string[] {
  if (split.includes(next) || !split.includes(tile)) return split;
  return split.map((key) => (key === tile ? next : key));
}
