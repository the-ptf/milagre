import { useEffect, useMemo, useState } from "react";
import { LOCAL_COMPUTER, computerOfKey, unqualifyKey } from "@milagre/shared/chat-scopes";
import { CHATS_GROUP_KEY, NO_PROJECT_LABEL, type ChatsHome, type ProjectKind } from "@milagre/shared/chats-home";
import { groupByOrigin } from "@milagre/shared/project-origin";
import { bridgeFor } from "./computer-bridge.ts";
import { useComputers, useHiddenComputers } from "./computers.ts";
import { useComputerScopes, type ComputerProject } from "./computer-scopes.ts";
import { RECENT_PROJECTS_CHANGED, type RecentProject } from "./project-list.ts";
import { stateEvents } from "./state-events.ts";

/**
 * A Project a new Chat can start in, on this Mac or another computer. `computer` is that computer's name. `exists` is set
 * on a Chats home's copy only: false until that computer has made its home.
 */
export type ProjectCopy = { key: string; name: string; origin?: string; computerId: string; computer: string; online: boolean; exists?: boolean };
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

/** The key a picked row moves the new Chat to: where it already is when that is one of the row's copies, else its preferred copy. */
export function pickedProjectKey(group: ProjectGroup, currentKey: string): string {
  if (group.copies.some((copy) => copy.key === currentKey)) return currentKey;
  const copy = preferredCopy(group);
  rememberProjectComputer(copy);
  return copy.key;
}

/**
 * The picker's No project row: one copy per computer, its Chats home there (made on pick when it doesn't exist yet), This
 * Mac's first so picking the row starts here.
 */
export function chatsGroup(homes: { computerId: string; computer: string; online?: boolean; home: ChatsHome }[]): ProjectGroup {
  const copies = homes
    .map(({ computerId, computer, online, home }) => ({
      key: home.path,
      name: NO_PROJECT_LABEL,
      computerId,
      computer,
      online: online ?? true,
      exists: home.exists,
    }))
    .toSorted((a, b) => Number(b.computerId === LOCAL_COMPUTER) - Number(a.computerId === LOCAL_COMPUTER));
  const first = copies[0] ?? { key: CHATS_GROUP_KEY, name: NO_PROJECT_LABEL, computerId: LOCAL_COMPUTER, computer: "", online: true };
  return { ...first, key: CHATS_GROUP_KEY, name: NO_PROJECT_LABEL, copies };
}

/** The picker's rows for a search: No project first, then the Projects; the Chats home itself is never a Project row. */
export function projectPickerRows({ groups, noProject, query }: { groups: ProjectGroup[]; noProject?: ProjectGroup; query: string }): ProjectGroup[] {
  const search = query.trim().toLowerCase();
  const matches = (group: ProjectGroup) =>
    group.name.toLowerCase().includes(search) || group.copies.some((copy) => copy.computer.toLowerCase().includes(search));
  const homes = new Set(noProject?.copies.map((copy) => copy.key));
  const projects = groups.filter((group) => !group.copies.some((copy) => homes.has(copy.key)) && matches(group));
  return noProject && noProject.copies.length > 0 && matches(noProject) ? [noProject, ...projects] : projects;
}

/** The homes read so far with one computer's latest in place; the same object when neither its path nor `exists` changed. */
export function withHome(homes: Record<string, ChatsHome>, computerId: string, home: ChatsHome): Record<string, ChatsHome> {
  const known = homes[computerId];
  return known?.path === home.path && known.exists === home.exists ? homes : { ...homes, [computerId]: home };
}

/** The computer whose home is held as missing at this path, if any. */
export function missingHomeAt(homes: Record<string, ChatsHome>, path: string): string | undefined {
  return Object.keys(homes).find((id) => homes[id]!.path === path && !homes[id]!.exists);
}

/**
 * The No project row for the new-chat picker: each computer's Chats home, This Mac's and every paired computer that
 * isn't off or hidden. A computer whose home can't be read is left out. Undefined until This Mac's is read.
 */
export function useChatsGroup(enabled: boolean): ProjectGroup | undefined {
  const { thisMac, computers } = useComputers();
  const hiddenComputers = useHiddenComputers();
  const [homes, setHomes] = useState<Record<string, ChatsHome>>({});
  // Each computer to read, with its state so one that comes back online is read again.
  const reads = [
    `${LOCAL_COMPUTER} online`,
    ...computers.filter((computer) => computer.state !== "off").map((computer) => `${computer.id} ${computer.state}`),
  ].join("\n");
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const readAll = () => {
      for (const read of reads.split("\n")) {
        const id = read.split(" ")[0]!;
        const readHome = async () => {
          const home = await bridgeFor(id).chatsHome?.();
          if (live && home?.path) setHomes((previous) => withHome(previous, id, home));
        };
        readHome().catch(() => {});
      }
    };
    readAll();
    // Read again when the recent Projects change, as the other scope lists do.
    window.addEventListener(RECENT_PROJECTS_CHANGED, readAll);
    return () => {
      live = false;
      window.removeEventListener(RECENT_PROJECTS_CHANGED, readAll);
    };
  }, [enabled, reads]);
  useEffect(() => {
    if (!enabled) return;
    // A home made elsewhere (the phone, MCP, another window, on any computer) announces itself with its first state: the
    // daemon broadcasts every Project's changes to every window, a missing home's included, so no read is needed.
    const offState = stateEvents.onProjectState(({ path }) =>
      setHomes((previous) => {
        const id = missingHomeAt(previous, path);
        return id ? withHome(previous, id, { path, exists: true }) : previous;
      }),
    );
    return offState;
  }, [enabled]);
  return useMemo(() => {
    if (!enabled || !homes[LOCAL_COMPUTER]) return undefined;
    const list: Parameters<typeof chatsGroup>[0] = [{ computerId: LOCAL_COMPUTER, computer: thisMac, online: true, home: homes[LOCAL_COMPUTER] }];
    for (const computer of computers) {
      const home = homes[computer.id];
      if (!home || computer.state === "off" || hiddenComputers.has(computer.id)) continue;
      list.push({ computerId: computer.id, computer: computer.name, online: computer.state === "online", home });
    }
    return chatsGroup(list);
  }, [enabled, homes, thisMac, computers, hiddenComputers]);
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
export function useProjectGroups(enabled: boolean, currentKey: string, currentName: string, currentKind?: ProjectKind): ProjectGroup[] {
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
  return projectGroups({ current: { key: currentKey, name: currentName, kind: currentKind }, recent, remote: remote.projects, hiddenComputers, copy });
}

/**
 * The picker's Project rows from the lists read: the open Project first, then This Mac's recent ones, then other
 * computers' by name, grouped by Git origin. The open Project is left out when it is the Chats home, which is No
 * project's row and never a Project's, however soon the picker opens.
 */
export function projectGroups({
  current,
  recent,
  remote,
  hiddenComputers,
  copy,
}: {
  current: { key: string; name: string; kind?: ProjectKind };
  recent: RecentProject[];
  remote: ComputerProject[];
  hiddenComputers: ReadonlySet<string>;
  copy: (key: string, name: string, origin?: string) => ProjectCopy;
}): ProjectGroup[] {
  const origins = new Map<string, string | undefined>([
    ...recent.map((project) => [project.path, project.origin] as const),
    ...remote.map((project) => [project.path, project.origin] as const),
  ]);
  const seen = new Set<string>([current.key]);
  const choices: ProjectCopy[] = current.kind === "chats" ? [] : [copy(current.key, current.name, origins.get(current.key))];
  for (const project of recent) {
    if (seen.has(project.path) || hiddenComputers.has(computerOfKey(project.path))) continue;
    seen.add(project.path);
    choices.push(copy(project.path, project.name, project.origin));
  }
  const others = remote
    .filter((scope) => !scope.path.startsWith("milagre-link:") && !seen.has(scope.path) && !hiddenComputers.has(scope.computerId))
    .toSorted((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  for (const scope of others) {
    seen.add(scope.path);
    choices.push(copy(scope.path, scope.name, scope.origin));
  }
  return groupByOrigin(choices);
}
