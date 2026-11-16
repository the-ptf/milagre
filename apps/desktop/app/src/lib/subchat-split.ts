export const besideParent = (parent: string, open: string): string[] => [parent, open];

export function familySplit(family: { root: string; children: readonly string[] }, focused: string | null): string[] {
  const keys = [family.root, ...family.children];
  return focused !== null && !keys.includes(focused) ? [...keys, focused] : keys;
}

export function swapTile(split: readonly string[], tile: string, next: string): readonly string[] {
  if (split.includes(next) || !split.includes(tile)) return split;
  return split.map((key) => (key === tile ? next : key));
}
