import { useSyncExternalStore } from "react";
import { EMPTY_TABS, parseTabSets, pruneTabSets, type StoredTabSets, type TabSet } from "@milagre/shared/workspace-tabs";
import { preferenceStorage as localStorage } from "./preference-storage.ts";

const STORAGE_KEY = "milagre.workspaceTabs";
const REMEMBERED_WORKSPACES = 40;

let sets: StoredTabSets = parseTabSets(localStorage.getItem(STORAGE_KEY));
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pruneTabSets(sets, REMEMBERED_WORKSPACES)));
    } catch {}
  }, 300);
}

export function tabSet(workspace: string): TabSet {
  return sets[workspace] ?? EMPTY_TABS;
}

/** Applies `change` to a workspace's tab set; a change that returns the same set stores and notifies nothing. */
export function updateTabSet(workspace: string, change: (set: TabSet) => TabSet) {
  const current = tabSet(workspace);
  const next = change(current);
  if (next === current) return;
  sets = { ...sets, [workspace]: { tabs: next.tabs, active: next.active, at: Date.now() } };
  listeners.forEach((listener) => listener());
  save();
}

export function useTabSet(workspace: string | null): TabSet {
  return useSyncExternalStore(subscribe, () => (workspace ? tabSet(workspace) : EMPTY_TABS));
}
