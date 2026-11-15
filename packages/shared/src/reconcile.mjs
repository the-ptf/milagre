export function reconcileState(previous, incoming) {
  if (previous === incoming || !previous || !incoming || typeof previous !== "object" || typeof incoming !== "object") return incoming;
  if (Array.isArray(incoming)) {
    if (!Array.isArray(previous)) return incoming;
    const byId = new Map(previous.filter((value) => value && typeof value === "object" && value.id !== undefined).map((value) => [value.id, value]));
    const next = incoming.map((value, index) => reconcileState(value?.id !== undefined ? byId.get(value.id) : previous[index], value));
    return next.length === previous.length && next.every((value, index) => value === previous[index]) ? previous : next;
  }
  if (Array.isArray(previous)) return incoming;
  const keys = Object.keys(incoming);
  const entries = keys.map((key) => [key, reconcileState(previous[key], incoming[key])]);
  return keys.length === Object.keys(previous).length && entries.every(([key, value]) => Object.hasOwn(previous, key) && previous[key] === value)
    ? previous
    : Object.fromEntries(entries);
}
