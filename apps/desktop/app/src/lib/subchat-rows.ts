import { createContext, useSyncExternalStore } from "react";
import { nestSubchats } from "@milagre/shared/subchats";
export { chatFamily } from "@milagre/shared/subchats";
import type { SidebarRecent } from "../components/sidebar/ChatRow";

/** How a sidebar row shows: a subchat sits under its parent (subchats.ts), whose row counts them and folds them away. */
export type ShownRow = { subchat: boolean; family?: { count: number; folded: boolean; onToggle: () => void } };

/**
 * `rows` (unpinned, not Done Chats, in the list's order) with each subchat under its topmost listed ancestor; a folded
 * family shows its parent alone. `key` names a row (`<scope>#<id>`), `parent` its parent's key.
 */
export function shownChats<T>(
  rows: readonly T[],
  { key, parent, folded }: { key: (row: T) => string; parent: (row: T) => string | undefined; folded: ReadonlySet<string> },
): (ShownRow & { item: T })[] {
  if (!rows.some((row) => parent(row) !== undefined)) return rows.map((item) => ({ item, subchat: false }));
  const byKey = new Map(rows.map((row) => [key(row), row]));
  const shown: (ShownRow & { item: T })[] = [];
  for (const { row, children } of nestSubchats(rows, key, (at) => {
    const row = byKey.get(at);
    return row === undefined ? undefined : parent(row);
  })) {
    if (!children.length) {
      shown.push({ item: row, subchat: false });
      continue;
    }
    const rowKey = key(row);
    const isFolded = folded.has(rowKey);
    shown.push({ item: row, subchat: false, family: { count: children.length, folded: isFolded, onToggle: toggleFor(rowKey) } });
    if (!isFolded) for (const child of children) shown.push({ item: child, subchat: true });
  }
  return shown;
}

/** A Chat's key in `scope` and its parent's: the sidebar rows' `id` and `parent`. */
export const rowKeys = (scope: string) => ({
  key: (row: Pick<SidebarRecent, "id">) => `${scope}#${row.id}`,
  parent: (row: Pick<SidebarRecent, "parent">) => (row.parent === undefined ? undefined : `${scope}#${row.parent}`),
});

// One toggle per family, so a parent row's memo holds across renders.
const toggles = new Map<string, () => void>();
const toggleFor = (key: string) => {
  let toggle = toggles.get(key);
  if (!toggle) toggles.set(key, (toggle = () => toggleSubchats(key)));
  return toggle;
};

// Folded families, by the parent's chat key (`<scope>#<id>`), kept across launches on this Mac.
const FOLDS_KEY = "milagre.subchatsFolded";
let folds: ReadonlySet<string> = readFolds();
const listeners = new Set<() => void>();

function readFolds(): ReadonlySet<string> {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(FOLDS_KEY) ?? "[]");
    return new Set(Array.isArray(saved) ? saved.filter((key) => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}

/** Folds or unfolds the family under the Chat `key`. */
export function toggleSubchats(key: string) {
  const next = new Set(folds);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  folds = next;
  try {
    globalThis.localStorage?.setItem(FOLDS_KEY, JSON.stringify([...next]));
  } catch {
    // A full storage keeps the fold for this run only.
  }
  for (const listener of listeners) listener();
}

/** The folded families; re-renders when one folds or unfolds. */
export function useSubchatFolds(): ReadonlySet<string> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => folds,
  );
}

/** Opens a subchat beside its parent (App's openBesideParent); false when the Chat has no parent there. */
export const OpenSubchatContext = createContext<((key: string) => boolean) | null>(null);
