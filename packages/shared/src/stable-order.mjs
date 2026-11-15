/** Keys already shown keep their place; a key seen for the first time goes on top. */
export function stableOrder(previous, next) {
  const present = new Set(next);
  const kept = previous.filter((key) => present.has(key));
  const known = new Set(kept);
  return [...next.filter((key) => !known.has(key)), ...kept];
}

export function keepOrder(previous, next, keyOf) {
  const byKey = new Map(next.map((item) => [keyOf(item), item]));
  return stableOrder(previous.map(keyOf), [...byKey.keys()]).map((key) => byKey.get(key));
}
