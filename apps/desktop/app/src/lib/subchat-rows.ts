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
  { key, parent, folded }: { key: (row: T) => string; parent: (row: T) => string | undefined; folded: SubchatFolds },
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

/** The current scope's numbered shortcuts: pins first, Done omitted, nesting only in expanded lists. */
export function jumpChatRows<T extends Pick<SidebarRecent, "id" | "parent" | "pinned" | "doneAt">>(
  rows: readonly T[],
  scope: string,
  folded: SubchatFolds,
  collapsed = false,
): T[] {
  const live = rows.filter((row) => !row.doneAt);
  const rest = live.filter((row) => !row.pinned);
  return [...live.filter((row) => row.pinned), ...(collapsed ? rest : shownChats(rest, { ...rowKeys(scope), folded }).map(({ item }) => item))];
}

// One toggle per family, so a parent row's memo holds across renders.
const toggles = new Map<string, () => void>();
const toggleFor = (key: string) => {
  let toggle = toggles.get(key);
  if (!toggle) toggles.set(key, (toggle = () => toggleSubchats(key)));
  return toggle;
};

/** Which families show their parent alone, by the parent's chat key. */
export type SubchatFolds = { has(key: string): boolean };

// Opened families, by the parent's chat key (`<scope>#<id>`), kept across launches on this Mac: a family starts folded,
// its parent alone, until its count is clicked. (Before, the folded ones were kept, under milagre.subchatsFolded.)
const OPEN_KEY = "milagre.subchatsOpen";
let opened: ReadonlySet<string> = readOpened();
let folds: SubchatFolds = foldsOf(opened);
const listeners = new Set<() => void>();

function foldsOf(open: ReadonlySet<string>): SubchatFolds {
  return { has: (key) => !open.has(key) };
}

function readOpened(): ReadonlySet<string> {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(OPEN_KEY) ?? "[]");
    return new Set(Array.isArray(saved) ? saved.filter((key) => typeof key === "string") : []);
  } catch {
    return new Set();
  }
}

/** Folds or unfolds the family under the Chat `key`. */
function toggleSubchats(key: string) {
  const next = new Set(opened);
  if (!next.delete(key)) next.add(key);
  opened = next;
  folds = foldsOf(next);
  try {
    globalThis.localStorage?.setItem(OPEN_KEY, JSON.stringify([...next]));
  } catch {
    // A full storage keeps the fold for this run only.
  }
  for (const listener of listeners) listener();
}

/** The folded families (all but the ones opened); re-renders when one folds or unfolds. */
export function useSubchatFolds(): SubchatFolds {
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
