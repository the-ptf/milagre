import { PHONE_PAGES, PHONE_TERMINALS, scopeKey, tabScope } from "./workspace-tabs-kinds";
import * as SecureStore from "expo-secure-store";
import { Directory, File, Paths } from "expo-file-system";
import { useEffect, useSyncExternalStore } from "react";
import { EMPTY_TABS, openTab, parseTabSets, pruneTabSets, type StoredTabSets, type TabSet, type WorkspaceTab } from "@milagre/shared/workspace-tabs";

const SETTING_KEY = "milagre.workspace-tabs.v1";
const REMEMBERED_WORKSPACES = 40;
const folder = new Directory(Paths.document, "workspace-tabs");
const file = new File(folder, "sets.json");

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const notify = () => listeners.forEach((listener) => listener());

let enabled = false;
let enabledChanged = false;
void SecureStore.getItemAsync(SETTING_KEY)
  .then((saved) => {
    if (enabledChanged) return;
    enabled = saved === "on";
    notify();
  })
  .catch(() => {});

export const workspaceTabsEnabled = () => enabled;

/** Settings › Experimental › Workspace tabs, kept on this device like the desktop keeps its own. */
export function useWorkspaceTabs(): [boolean, (next: boolean) => void] {
  const current = useSyncExternalStore(subscribe, () => enabled);
  return [
    current,
    (next) => {
      enabledChanged = true;
      enabled = next;
      notify();
      void SecureStore.setItemAsync(SETTING_KEY, next ? "on" : "off").catch(() => {});
    },
  ];
}

let sets: StoredTabSets = {};
let touched = new Set<string>();
void (async () => {
  try {
    if (!file.exists) return;
    const saved = parseTabSets(await file.text());
    sets = { ...saved, ...Object.fromEntries([...touched].map((key) => [key, sets[key]!])) };
    touched = new Set();
    notify();
  } catch {}
})();

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      if (!folder.exists) folder.create({ intermediates: true });
      if (!file.exists) file.create();
      void file.write(JSON.stringify(pruneTabSets(sets, REMEMBERED_WORKSPACES)));
    } catch {}
  }, 300);
}

export function tabSet(workspace: string): TabSet {
  return sets[workspace] ?? EMPTY_TABS;
}

export function updateTabSet(workspace: string, change: (set: TabSet) => TabSet) {
  const current = tabSet(workspace);
  const next = change(current);
  if (next === current) return;
  sets = { ...sets, [workspace]: { tabs: next.tabs, active: next.active, at: Date.now() } };
  touched.add(workspace);
  notify();
  save();
}

export function useTabSet(workspace: string | null): TabSet {
  return useSyncExternalStore(subscribe, () => (workspace ? tabSet(workspace) : EMPTY_TABS));
}

type PhoneSession = {
  client?: { url: string } | null;
  snapshot?: {
    project: {
      path: string;
      link?: unknown;
      state: { sessions: Record<string, { worktree_id: number }>; worktrees: Record<string, { id: number; path: string }> };
    };
  } | null;
};

/** The phone opening a Chat's Browser or Terminal: its tab set gets a tab that opens it again. */
function notePhoneTab(session: PhoneSession, chatKey: string, tab: WorkspaceTab) {
  const snapshot = session.snapshot;
  if (!enabled || !session.client || !snapshot || !chatKey.startsWith(`${snapshot.project.path}#`)) return;
  const scope = tabScope(snapshot.project, Number(chatKey.slice(chatKey.lastIndexOf("#") + 1)), undefined);
  if (scope === undefined) return;
  updateTabSet(`${session.client.url}|${scopeKey(snapshot.project.path, scope)}`, (current) => openTab(current, tab));
}

/** A sheet that shows a Chat's Browser pages or Terminals keeps a tab for them in its Worktree's set while tabs are on. */
export function useNotePhoneTab(session: PhoneSession, hostId: string | undefined, chatKey: string | undefined, kind: "browser" | "terminal") {
  const ready = !!session.snapshot && session.client?.url === hostId;
  useEffect(() => {
    if (!ready || !chatKey) return;
    const chatId = Number(chatKey.slice(chatKey.lastIndexOf("#") + 1));
    notePhoneTab(session, chatKey, kind === "browser" ? { kind, chatId, pageId: PHONE_PAGES } : { kind, chatId, terminalId: PHONE_TERMINALS });
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- notes once per Chat the sheet opens on
  }, [ready, chatKey, kind]);
}
