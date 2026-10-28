import { useEffect, useState } from "react";
import { LOCAL_COMPUTER, computerOfKey, unqualifyKey } from "@milagre/shared/chat-scopes";
import { groupByOrigin } from "@milagre/shared/project-origin";
import { useComputers, useHiddenComputers } from "./computers.ts";
import { useComputerScopes } from "./computer-scopes.ts";
import { RECENT_PROJECTS_CHANGED, type RecentProject } from "./project-list.ts";

/** A Project a new Chat can start in, on this Mac or another computer. `computer` is that computer's name. */
export type ProjectCopy = { key: string; name: string; origin?: string; computerId: string; computer: string; online: boolean };
/** One row of the new-chat Project picker: a Project and its copies on every computer that has the same repository. */
export type ProjectGroup = ProjectCopy & { copies: ProjectCopy[] };

const LAST_COMPUTER_KEY = "milagre.projectComputers";

function readLastComputers(): Record<string, string> {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(LAST_COMPUTER_KEY) ?? "{}");
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  } catch {
    return {};
  }
}

/** Remembers which computer a repository's new Chat was last started on, so picking that Project again goes back there. */
export function rememberProjectComputer(copy: Pick<ProjectCopy, "origin" | "computerId">): void {
  if (!copy.origin) return;
  const saved = readLastComputers();
  if (saved[copy.origin] === copy.computerId) return;
  try {
    globalThis.localStorage?.setItem(LAST_COMPUTER_KEY, JSON.stringify({ ...saved, [copy.origin]: copy.computerId }));
  } catch {
    /* ignore storage errors */
  }
}

/** The copy a picked Project opens: the one on the computer last used for it, else This Mac's, else the first listed. */
export function preferredCopy(group: ProjectGroup): ProjectCopy {
  const last = group.origin ? readLastComputers()[group.origin] : undefined;
  return group.copies.find((copy) => copy.computerId === last) ?? group.copies.find((copy) => copy.computerId === LOCAL_COMPUTER) ?? group;
}

/** A path on another computer reads from its home folder: "/Users/ana/Code/app" as "~/Code/app". */
export function shortPath(key: string): string {
  return String(unqualifyKey(key)).replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

/**
 * Every Project a new Chat can start in, one row per repository: the open Project first, then This Mac's recent
 * Projects, then other computers' by name, with the copies of one Git origin on several computers in one row. Sidebar
 * visibility does not limit where a Chat can start; a hidden computer's Projects are left out. Reads nothing while off.
 */
export function useProjectGroups(enabled: boolean, currentKey: string, currentName: string): ProjectGroup[] {
  const [recent, setRecent] = useState<RecentProject[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const read = () =>
      window.milagre?.listRecentProjects?.().then(
        (list) => live && setRecent(Array.isArray(list) ? list : []),
        () => {},
      );
    void read();
    window.addEventListener(RECENT_PROJECTS_CHANGED, read);
    return () => {
      live = false;
      window.removeEventListener(RECENT_PROJECTS_CHANGED, read);
    };
  }, [enabled]);
  const { thisMac, computers } = useComputers();
  const hiddenComputers = useHiddenComputers();
  const remote = useComputerScopes(enabled ? computers : []);
  if (!enabled) return [];
  const copy = (key: string, name: string, origin?: string): ProjectCopy => {
    const computerId = computerOfKey(key);
    const computer = computers.find((item) => item.id === computerId);
    return {
      key,
      name,
      origin,
      computerId,
      computer: computerId === LOCAL_COMPUTER ? thisMac : (computer?.name ?? "Computer"),
      online: computerId === LOCAL_COMPUTER || computer?.state === "online",
    };
  };
  const origins = new Map<string, string | undefined>([
    ...recent.map((project) => [project.path, project.origin] as const),
    ...remote.projects.map((project) => [project.path, project.origin] as const),
  ]);
  const seen = new Set<string>([currentKey]);
  const choices: ProjectCopy[] = [copy(currentKey, currentName, origins.get(currentKey))];
  for (const project of recent) {
    if (seen.has(project.path) || hiddenComputers.has(computerOfKey(project.path))) continue;
    seen.add(project.path);
    choices.push(copy(project.path, project.name, project.origin));
  }
  const others = remote.projects
    .filter((scope) => !scope.path.startsWith("milagre-link:") && !seen.has(scope.path) && !hiddenComputers.has(scope.computerId))
    .toSorted((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  for (const scope of others) {
    seen.add(scope.path);
    choices.push(copy(scope.path, scope.name, scope.origin));
  }
  return groupByOrigin(choices);
}
