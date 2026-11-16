import { useSyncExternalStore } from "react";

export type GridDropTarget = {
  tile: string | null;
  side: "before" | "after";
  area: { left: number; top: number; width: number; height: number };
  bar: { left: number; top: number; height: number };
};

type GridDropHandle = {
  hit: (x: number, y: number, chatKey: string) => GridDropTarget | null;
  drop: (chatKey: string, target: GridDropTarget) => void;
};

let handle: GridDropHandle | null = null;
let shown: GridDropTarget | null = null;
const listeners = new Set<() => void>();

const same = (a: GridDropTarget | null, b: GridDropTarget | null) =>
  a === b || (a !== null && b !== null && a.tile === b.tile && a.side === b.side && a.area.left === b.area.left && a.area.width === b.area.width);

/**
 * The bridge between the sidebar's Chat drag (SidebarNav) and the Chat view (App), which knows the grid. The sidebar asks
 * it where the pointer is once it leaves the sidebar's lists, shows the target through it and drops through it.
 */
export const gridDrop = {
  register(next: GridDropHandle) {
    handle = next;
    return () => {
      if (handle === next) handle = null;
    };
  },
  hit: (x: number, y: number, chatKey: string) => handle?.hit(x, y, chatKey) ?? null,
  show(target: GridDropTarget | null) {
    if (same(shown, target)) return;
    shown = target;
    for (const listener of listeners) listener();
  },
  drop(chatKey: string, target: GridDropTarget) {
    gridDrop.show(null);
    handle?.drop(chatKey, target);
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  current: () => shown,
};

export function useGridDropTarget() {
  return useSyncExternalStore(gridDrop.subscribe, gridDrop.current);
}

/**
 * Which side of a box a point is on, and the half it would take: a drop on the left half goes before, on the right
 * half after. Pure, so the hit test is testable without a DOM.
 */
export function dropSide(
  box: { left: number; top: number; width: number; height: number },
  x: number,
  gap: number,
): Pick<GridDropTarget, "side" | "area" | "bar"> {
  const before = x < box.left + box.width / 2;
  const half = box.width / 2;
  return {
    side: before ? "before" : "after",
    area: { left: before ? box.left : box.left + half, top: box.top, width: half, height: box.height },
    bar: { left: before ? box.left - gap / 2 - 2 : box.left + box.width + gap / 2 - 2, top: box.top + 16, height: Math.max(0, box.height - 32) },
  };
}

export function placeDropped(tiles: readonly string[], key: string, target: Pick<GridDropTarget, "tile" | "side">, focused: string | null): string[] {
  const anchor = target.tile ?? focused;
  const rest = (tiles.length ? tiles : focused ? [focused] : []).filter((item) => item !== key);
  const at = anchor === null ? -1 : rest.indexOf(anchor);
  if (at < 0) return [...rest, key];
  rest.splice(target.side === "before" ? at : at + 1, 0, key);
  return rest;
}

const PINS_KEY = "milagre.chatGridPins";
const SPLIT_KEY = "milagre.chatSplit2";

function readKeys(storage: Pick<Storage, "getItem">, name: string): string[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(name) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function readGridPins(storage: Pick<Storage, "getItem">) {
  return readKeys(storage, PINS_KEY);
}

export function saveGridPins(storage: Pick<Storage, "setItem">, pins: readonly string[]) {
  storage.setItem(PINS_KEY, JSON.stringify(pins));
}

export function readSplitChats(storage: Pick<Storage, "getItem">) {
  return readKeys(storage, SPLIT_KEY);
}

export function saveSplitChats(storage: Pick<Storage, "setItem">, keys: readonly string[]) {
  storage.setItem(SPLIT_KEY, JSON.stringify(keys.filter((key) => !key.endsWith("#0"))));
}
