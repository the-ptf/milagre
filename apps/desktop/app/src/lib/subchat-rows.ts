import { useEffect, useRef, useSyncExternalStore } from "react";
import { nestSubchats, subchatRoot } from "@milagre/shared/subchats";
export { chatFamily } from "@milagre/shared/subchats";
import type { SidebarRecent } from "../components/sidebar/ChatRow";

/**
 * How a sidebar row shows: a subchat sits under its parent (subchats.ts), whose row counts them and folds them away.
 * `depth` is 0 for a top-level Chat, then 1 or 2 for how far in a subchat sits (nestSubchats' depths, capped there).
 */
export type ShownRow = { subchat: boolean; depth: number; family?: { count: number; folded: boolean; asking: boolean; onToggle: () => void } };

/**
 * `rows` (unpinned, not Done Chats, in the list's order) with each subchat under its topmost listed ancestor; a folded
 * family shows its parent alone. `key` names a row (`<scope>#<id>`), `parent` its parent's key.
 */
export function shownChats<T>(
  rows: readonly T[],
  {
    key,
    parent,
    folded,
    asking = () => false,
  }: { key: (row: T) => string; parent: (row: T) => string | undefined; folded: SubchatFolds; asking?: (row: T) => boolean },
): (ShownRow & { item: T })[] {
  if (!rows.some((row) => parent(row) !== undefined)) return rows.map((item) => ({ item, subchat: false, depth: 0 }));
  const byKey = new Map(rows.map((row) => [key(row), row]));
  const shown: (ShownRow & { item: T })[] = [];
  for (const { row, children, depths } of nestSubchats(rows, key, (at) => {
    const row = byKey.get(at);
    return row === undefined ? undefined : parent(row);
  })) {
    if (!children.length) {
      shown.push({ item: row, subchat: false, depth: 0 });
      continue;
    }
    const rowKey = key(row);
    const isFolded = folded.has(rowKey);
    shown.push({
      item: row,
      subchat: false,
      depth: 0,
      family: { count: children.length, folded: isFolded, asking: children.some(asking), onToggle: toggleFor(rowKey) },
    });
    if (!isFolded) children.forEach((child, index) => shown.push({ item: child, subchat: true, depth: depths[index] ?? 1 }));
  }
  return shown;
}

/**
 * The family root above the active row, when it is a subchat: the Chat whose family must be unfolded for that row to show.
 * Every route that opens a Chat ends with its row active, so the sidebar unfolds from here instead of each route doing it.
 */
export function activeFamilyRoot<T>(
  rows: readonly T[],
  { key, parent }: { key: (row: T) => string; parent: (row: T) => string | undefined },
  isActive: (row: T) => boolean,
): string | undefined {
  const active = rows.find(isActive);
  if (!active) return undefined;
  const byKey = new Map(rows.map((row) => [key(row), row]));
  return subchatRoot(
    key(active),
    (at) => {
      const row = byKey.get(at);
      return row === undefined ? undefined : parent(row);
    },
    (at) => byKey.has(at),
  );
}

/**
 * Unfolds `root`'s family once each time the active Chat becomes one of its subchats, so folding it by hand afterwards sticks
 * until another subchat opens. `root` is activeFamilyRoot's answer, `active` the open Chat's key.
 */
export function useUnfoldActiveFamily(root: string | undefined, active: string | undefined) {
  const done = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!root || !active) {
      done.current = undefined;
      return;
    }
    if (done.current === active) return;
    done.current = active;
    unfoldSubchats(root);
  }, [root, active]);
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
  setOpened(key, !opened.has(key));
}

/** Unfolds the family under the Chat `key` when a route opens one of its Chats, so the row it selects is in view. */
export function unfoldSubchats(key: string) {
  if (!opened.has(key)) setOpened(key, true);
}

function setOpened(key: string, open: boolean) {
  const next = new Set(opened);
  if (open) next.add(key);
  else next.delete(key);
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
