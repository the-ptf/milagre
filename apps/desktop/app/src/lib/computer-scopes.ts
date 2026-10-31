import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { NamedProjectLink } from "@milagre/shared/model";
import { LOCAL_COMPUTER } from "@milagre/shared/chat-scopes";
import type { ComputerView } from "../electron";
import { bridgeFor } from "./computer-bridge.ts";
import { HIDDEN_REMOTE_SCOPES_KEY, readHiddenRemoteScopes, setRemoteScopeHidden } from "./hidden-projects.ts";
import { RECENT_PROJECTS_CHANGED, type RecentProject } from "./project-list.ts";

/** One Project or Link of a computer, keyed as the window keeps it (`${id}|path`, `milagre-link:${id}|uuid`). */
/** `origin`: a Project's Git remote ("host/owner/repo"), which puts its copies on several computers under one heading. */
export type ComputerScope = { key: string; name: string; initial: string; link: NamedProjectLink | null; computerId: string; origin?: string };

/** A computer's Projects (those not hidden) then its Links, from its own lists; main has already qualified their keys. */
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

/** Another computer's Projects and Links with this Mac's own `hidden` choices in place of that computer's. */
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

/**
 * Every computer's scopes in one list (spec "sidebar-scopes.ts … merged by Project name order"): Projects by name, then
 * Links by name; on a tie This Mac's first, then the computers in the popover's order.
 */
export function mergeScopes<T extends { key: string; name: string; link: unknown; computerId: string }>(scopes: T[], computerOrder: string[]): T[] {
  const rank = (scope: T) => (scope.computerId === LOCAL_COMPUTER ? -1 : computerOrder.indexOf(scope.computerId));
  return [...scopes].sort(
    (a, b) =>
      Number(Boolean(a.link)) - Number(Boolean(b.link)) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      rank(a) - rank(b) ||
      a.key.localeCompare(b.key),
  );
}

/** Remote scopes minus those the window already holds as its own (the open Project of another computer is among the local ones). */
export function withoutLocal<T extends { key: string }>(remote: T[], local: { key: string }[]): T[] {
  return remote.filter((scope) => !local.some((item) => item.key === scope.key));
}

/** Another computer's Project as the project chooser lists it, hidden ones included. */
export type ComputerProject = RecentProject & { computerId: string };

// Both workspaces keep a sidebar. A newly shown one takes the lists the other read, before paint.
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

/**
 * Each paired computer's Projects and Links, read from it (from its cache in main while it is away), again when its
 * state changes, and with this Mac's own visibility choices applied. A failed read keeps the last list. `scopes` are what
 * the sidebar lists; `projects` every Project, hidden too, for the chooser.
 */
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
    // A computer turned off keeps no scopes.
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

/**
 * A computer's short name on the sidebar's Project headers: its first word, without a possessive. Hostnames split at
 * - _ and . too ("Victor’s MacBook Pro" → "Victor", "victor-mbp" → "victor").
 */
export function computerAlias(name: string): string {
  return (
    name
      .trim()
      .split(/[\s\-_.]+/)[0]!
      .replace(/['’]s$/i, "") || name
  );
}

/** A computer as the project chooser heads its section: This Mac (`local`), or a paired one. */
export type ComputerSection = { id: string; name: string; local: boolean };

/** The project chooser's sections: This Mac first, then the paired computers by name. */
export function computerSections(thisMac: string, computers: { id: string; name: string }[]): ComputerSection[] {
  return [
    { id: LOCAL_COMPUTER, name: thisMac, local: true },
    ...[...computers]
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id))
      .map((computer) => ({ id: computer.id, name: computer.name, local: false })),
  ];
}

/** Rows under their computer's section, in the order given; a section with no rows is left out. */
export function bySection<T extends { computerId: string }>(rows: T[], sections: ComputerSection[]): (ComputerSection & { rows: T[] })[] {
  return sections.map((section) => ({ ...section, rows: rows.filter((row) => row.computerId === section.id) })).filter((section) => section.rows.length > 0);
}
