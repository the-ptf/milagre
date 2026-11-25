import { useSyncExternalStore } from "react";
import type { WorkspaceTab } from "@milagre/shared/workspace-tabs";
import { getSettings, useSettings } from "./settings";

/**
 * The Workspace tab in front when it is not a Chat: the Browser page, design page or Terminal the window shows instead
 * of the Chat (or beside it), and the Chat it belongs to. The panels read it to show themselves; the tab strip writes it.
 */
export type Stage = { chatKey: string | null; tab: WorkspaceTab; beside: boolean } | null;

let stage: Stage = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function setStage(next: Stage) {
  if (JSON.stringify(next) === JSON.stringify(stage)) return;
  stage = next;
  listeners.forEach((listener) => listener());
}

export function currentStage(): Stage {
  return stage;
}

export function useStage(): Stage {
  return useSyncExternalStore(subscribe, () => stage);
}

let hosts = 0;
let hostsVersion = 0;

/** The strip mounting: while one shows, the Browser, Artifact and Terminal panels follow the tabs instead of their toggles. */
export function hostTabs() {
  hosts += 1;
  hostsVersion += 1;
  listeners.forEach((listener) => listener());
  return () => {
    hosts -= 1;
    hostsVersion += 1;
    if (hosts === 0) stage = null;
    listeners.forEach((listener) => listener());
  };
}

/** Whether Workspace tabs replace the side panels now: the setting is on and a strip shows. */
export const workspaceTabsOn = () => getSettings().workspaceTabs && hosts > 0;

export function useWorkspaceTabsOn() {
  const { workspaceTabs } = useSettings();
  useSyncExternalStore(subscribe, () => hostsVersion);
  return workspaceTabs && hosts > 0;
}

export type TabRequest = { chatKey: string; tab: WorkspaceTab; focus: boolean } | { chatKey: string; close: WorkspaceTab };

const requests = new Set<(request: TabRequest) => void>();

/** A panel asking the strip to open a tab for something the user or the agent just opened (focus says which). */
export function requestTab(chatKey: string, tab: WorkspaceTab, focus: boolean) {
  if (!workspaceTabsOn()) return;
  requests.forEach((listener) => listener({ chatKey, tab, focus }));
}

export function requestClose(chatKey: string, tab: WorkspaceTab) {
  if (!workspaceTabsOn()) return;
  requests.forEach((listener) => listener({ chatKey, close: tab }));
}

export function onTabRequest(listener: (request: TabRequest) => void) {
  requests.add(listener);
  return () => {
    requests.delete(listener);
  };
}
