import { useEffect, useRef, useSyncExternalStore } from "react";
import { nestSubchats, subchatRoot } from "@milagre/shared/subchats";
export { chatFamily } from "@milagre/shared/subchats";
import type { SidebarRecent } from "../components/sidebar/ChatRow";

export type ShownRow = { subchat: boolean; depth: number; family?: { count: number; folded: boolean; asking: boolean; onToggle: () => void } };

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

export function standInRow<T>(
  shown: readonly { item: T }[],
  rows: readonly T[],
  keys: { key: (row: T) => string; parent: (row: T) => string | undefined },
  isActive: (row: T) => boolean,
): string | undefined {
  if (shown.some(({ item }) => isActive(item))) return undefined;
  return activeFamilyRoot(rows, keys, isActive);
}

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

export const rowKeys = (scope: string) => ({
  key: (row: Pick<SidebarRecent, "id">) => `${scope}#${row.id}`,
  parent: (row: Pick<SidebarRecent, "parent">) => (row.parent === undefined ? undefined : `${scope}#${row.parent}`),
});

export function jumpChatRows<T extends Pick<SidebarRecent, "id" | "parent" | "pinned" | "doneAt" | "snoozedUntil">>(
  rows: readonly T[],
  scope: string,
  folded: SubchatFolds,
  collapsed = false,
): T[] {
  const live = rows.filter((row) => !row.doneAt && !row.snoozedUntil);
  const rest = live.filter((row) => !row.pinned);
  return [...live.filter((row) => row.pinned), ...(collapsed ? rest : shownChats(rest, { ...rowKeys(scope), folded }).map(({ item }) => item))];
}

const toggles = new Map<string, () => void>();
const toggleFor = (key: string) => {
  let toggle = toggles.get(key);
  if (!toggle) toggles.set(key, (toggle = () => toggleSubchats(key)));
  return toggle;
};

export type SubchatFolds = { has(key: string): boolean };

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

function toggleSubchats(key: string) {
  setOpened(key, !opened.has(key));
}

function unfoldSubchats(key: string) {
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
  } catch {}
  for (const listener of listeners) listener();
}

export function useSubchatFolds(): SubchatFolds {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => folds,
  );
}
