import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { NamedProjectLink } from "@milagre/shared/model";
import { LOCAL_COMPUTER } from "@milagre/shared/chat-scopes";
import type { ComputerView } from "../electron";
import { bridgeFor } from "./computer-bridge.ts";
import { HIDDEN_REMOTE_SCOPES_KEY, readHiddenRemoteScopes, setRemoteScopeHidden } from "./hidden-projects.ts";
import { RECENT_PROJECTS_CHANGED, type RecentProject } from "./project-list.ts";

export type ComputerScope = { key: string; name: string; initial: string; link: NamedProjectLink | null; computerId: string; origin?: string };

export function computerScopes(computerId: string, recent: RecentProject[], links: NamedProjectLink[]): ComputerScope[] {
  return [
    ...recent
      .filter((project) => !project.hidden)
      .map((project) => ({
        key: project.path,
        name: project.name,
        initial: project.name.slice(0, 1).toUpperCase(),
        link: null,
        computerId,
        ...(project.origin ? { origin: project.origin } : {}),
      })),
    ...links.filter((link) => !link.hidden).map((link) => ({ key: `milagre-link:${link.id}`, name: link.name, initial: "", link, computerId })),
  ];
}

export function withLocalVisibility(
  recent: RecentProject[],
  links: NamedProjectLink[],
  hidden: ReadonlySet<string>,
): { recent: RecentProject[]; links: NamedProjectLink[] } {
  return {
    recent: recent.map(({ hidden: _hidden, ...project }) => (hidden.has(project.path) ? { ...project, hidden: true } : project)),
    links: links.map(({ hidden: _hidden, ...link }) => (hidden.has(`milagre-link:${link.id}`) ? { ...link, hidden: true } : link)),
  };
}

export function mergeScopes<T extends { key: string; name: string; link: unknown; computerId: string }>(
  scopes: T[],
  computerOrder: string[],
  manualOrder: readonly string[] = [],
): T[] {
  const rank = (scope: T) => (scope.computerId === LOCAL_COMPUTER ? -1 : computerOrder.indexOf(scope.computerId));
  const manualOrderCompare = (a: T, b: T) => {
    const ai = manualOrder.indexOf(a.key);
    const bi = manualOrder.indexOf(b.key);
    return ai === -1 || bi === -1 ? 0 : ai - bi;
  };
  return [...scopes].sort(
    (a, b) =>
      Number(Boolean(a.link)) - Number(Boolean(b.link)) ||
      manualOrderCompare(a, b) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      rank(a) - rank(b) ||
      a.key.localeCompare(b.key),
  );
}

export function withoutLocal<T extends { key: string }>(remote: T[], local: { key: string }[]): T[] {
  return remote.filter((scope) => !local.some((item) => item.key === scope.key));
}

export type ComputerProject = RecentProject & { computerId: string };

type ComputerLists = Record<string, { recent: RecentProject[]; links: NamedProjectLink[] }>;
let lastComputerLists: ComputerLists = {};
const listListeners = new Set<() => void>();
const computerListsSnapshot = () => lastComputerLists;
const subscribeComputerLists = (listener: () => void) => {
  listListeners.add(listener);
  return () => listListeners.delete(listener);
};
function keepComputerLists(next: ComputerLists) {
  lastComputerLists = next;
  for (const listener of listListeners) listener();
}

export function useComputerScopes(computers: ComputerView[]): {
  scopes: ComputerScope[];
  projects: ComputerProject[];
  setHidden: (key: string, hidden: boolean) => void;
} {
  const byComputer = useSyncExternalStore(subscribeComputerLists, computerListsSnapshot);
  const [hiddenRemote, setHiddenRemote] = useState(readHiddenRemoteScopes);
  const [changed, setChanged] = useState(0);
  const states = computers.map((computer) => `${computer.id}:${computer.state}`).join("\n");
  useEffect(() => {
    const bump = () => {
      setHiddenRemote(readHiddenRemoteScopes());
      setChanged((count) => count + 1);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === HIDDEN_REMOTE_SCOPES_KEY) setHiddenRemote(readHiddenRemoteScopes());
    };
    window.addEventListener(RECENT_PROJECTS_CHANGED, bump);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(RECENT_PROJECTS_CHANGED, bump);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  useEffect(() => {
    let live = true;
    const off = computers.filter((computer) => computer.state === "off").map((computer) => computer.id);
    if (off.some((id) => id in lastComputerLists)) {
      keepComputerLists(Object.fromEntries(Object.entries(lastComputerLists).filter(([id]) => !off.includes(id))));
    }
    const stops: Array<(() => void) | undefined> = [];
    for (const computer of computers) {
      if (computer.state === "off") continue;
      const bridge = bridgeFor(computer.id);
      const reload = () => {
        void Promise.all([bridge.listRecentProjects().catch(() => null), bridge.listNamedLinks().catch(() => null)]).then(([recent, links]) => {
          if (!live || !Array.isArray(recent)) return;
          keepComputerLists({
            ...lastComputerLists,
            [computer.id]: { recent, links: Array.isArray(links) ? links : (lastComputerLists[computer.id]?.links ?? []) },
          });
        });
      };
      reload();
      stops.push(
        bridge.localMcp?.onChanged?.((payload) => {
          if (payload?.projectAdded) reload();
        }),
      );
    }
    return () => {
      live = false;
      for (const stop of stops) stop?.();
    };
  }, [states, changed]);
  const setHidden = useCallback((key: string, hidden: boolean) => {
    setRemoteScopeHidden(key, hidden);
    setHiddenRemote(readHiddenRemoteScopes());
  }, []);
  return useMemo(() => {
    const listed = computers
      .filter((computer) => byComputer[computer.id])
      .map((computer) => [computer.id, withLocalVisibility(byComputer[computer.id]!.recent, byComputer[computer.id]!.links, hiddenRemote)] as const);
    return {
      scopes: listed.flatMap(([id, lists]) => computerScopes(id, lists.recent, lists.links)),
      projects: listed.flatMap(([id, lists]) => [
        ...lists.recent.map((project) => ({ ...project, computerId: id })),
        ...lists.links.map((link) => ({ path: `milagre-link:${link.id}`, name: link.name, openedAt: link.createdAt, hidden: link.hidden, computerId: id })),
      ]),
      setHidden,
    };
  }, [byComputer, computers, hiddenRemote, setHidden]);
}

export function computerAlias(name: string): string {
  return (
    name
      .trim()
      .split(/[\s\-_.]+/)[0]!
      .replace(/['\u2019]s$/i, "") || name
  );
}

export type ComputerSection = { id: string; name: string; local: boolean };

export function computerSections(thisMac: string, computers: { id: string; name: string }[]): ComputerSection[] {
  return [
    { id: LOCAL_COMPUTER, name: thisMac, local: true },
    ...[...computers]
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id))
      .map((computer) => ({ id: computer.id, name: computer.name, local: false })),
  ];
}

export function bySection<T extends { computerId: string }>(rows: T[], sections: ComputerSection[]): (ComputerSection & { rows: T[] })[] {
  return sections.map((section) => ({ ...section, rows: rows.filter((row) => row.computerId === section.id) })).filter((section) => section.rows.length > 0);
}
