import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { LOCAL_COMPUTER, computerOfKey, unqualifyKey } from "@milagre/shared/chat-scopes";
import { CHATS_GROUP_KEY, NO_PROJECT_LABEL, type ChatsHome, type ProjectKind } from "@milagre/shared/chats-home";
import type { NamedProjectLink } from "@milagre/shared/model";
import { copiesToTry, groupByOrigin } from "@milagre/shared/project-origin";
import { bridgeFor } from "./computer-bridge.ts";
import { useComputers, useHiddenComputers } from "./computers.ts";
import { useComputerScopes, type ComputerProject } from "./computer-scopes.ts";
import { RECENT_PROJECTS_CHANGED, type RecentProject } from "./project-list.ts";
import { stateEvents } from "./state-events.ts";

export type ProjectCopy = { key: string; name: string; origin?: string; computerId: string; computer: string; online: boolean; exists?: boolean };
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

export function rememberProjectComputer(copy: Pick<ProjectCopy, "origin" | "computerId">): void {
  if (!copy.origin) return;
  const saved = readLastComputers();
  if (saved[copy.origin] === copy.computerId) return;
  try {
    globalThis.localStorage?.setItem(LAST_COMPUTER_KEY, JSON.stringify({ ...saved, [copy.origin]: copy.computerId }));
  } catch {}
}

export function preferredCopy<T extends { computerId: string }>(origin: string | undefined, copies: [T, ...T[]]): T {
  const last = origin ? readLastComputers()[origin] : undefined;
  return copies.find((copy) => copy.computerId === last) ?? copies.find((copy) => copy.computerId === LOCAL_COMPUTER) ?? copies[0];
}

export function pickedProjectKey(group: ProjectGroup, currentKey: string): string {
  if (group.copies.some((copy) => copy.key === currentKey)) return currentKey;
  const [first, ...rest] = group.copies;
  const copy = preferredCopy(group.origin, first ? [first, ...rest] : [group]);
  rememberProjectComputer(copy);
  return copy.key;
}

export function otherCopyKeys(group: ProjectGroup, key: string): string[] {
  const picked = group.copies.find((copy) => copy.key === key);
  if (!picked) return [];
  return copiesToTry(group.copies, picked, (copy) => copy.computerId === LOCAL_COMPUTER)
    .slice(1)
    .map((copy) => copy.key);
}

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

export function projectPickerRows({ groups, noProject, query }: { groups: ProjectGroup[]; noProject?: ProjectGroup; query: string }): ProjectGroup[] {
  const search = query.trim().toLowerCase();
  const matches = (group: ProjectGroup) =>
    group.name.toLowerCase().includes(search) || group.copies.some((copy) => copy.computer.toLowerCase().includes(search));
  const homes = new Set(noProject?.copies.map((copy) => copy.key));
  const projects = groups.filter((group) => !group.copies.some((copy) => homes.has(copy.key)) && matches(group));
  return noProject && noProject.copies.length > 0 && matches(noProject) ? [noProject, ...projects] : projects;
}

export function withHome(homes: Record<string, ChatsHome>, computerId: string, home: ChatsHome): Record<string, ChatsHome> {
  const known = homes[computerId];
  return known?.path === home.path && known.exists === home.exists ? homes : { ...homes, [computerId]: home };
}

export function missingHomeAt(homes: Record<string, ChatsHome>, path: string): string | undefined {
  return Object.keys(homes).find((id) => homes[id]!.path === path && !homes[id]!.exists);
}

export type ChatsHomes = {
  acquire(reads: string): () => void;
  subscribe(listener: () => void): () => void;
  snapshot(): Record<string, ChatsHome>;
};

export function createChatsHomes({
  read,
  onRecentChanged,
  onProjectState,
}: {
  read: (computerId: string) => Promise<ChatsHome | undefined>;
  onRecentChanged: (listener: () => void) => () => void;
  onProjectState: (listener: (path: string) => void) => () => void;
}): ChatsHomes {
  let homes: Record<string, ChatsHome> = {};
  const listeners = new Set<() => void>();
  const holders = new Map<object, string[]>();
  let held = "";
  let generation = 0;
  let stopListening: (() => void) | undefined;
  const set = (next: Record<string, ChatsHome>) => {
    if (next === homes) return;
    homes = next;
    for (const listener of listeners) listener();
  };
  const readOne = async (id: string, at: number) => {
    const home = await read(id);
    if (at === generation && home?.path) set(withHome(homes, id, home));
  };
  const readAll = () => {
    for (const id of new Set(
      held
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" ")[0]!),
    ))
      readOne(id, generation).catch(() => {});
  };
  const update = () => {
    if (!holders.size) {
      stopListening?.();
      stopListening = undefined;
      held = "";
      generation++;
      return;
    }
    if (!stopListening) {
      const offRecent = onRecentChanged(readAll);
      const offState = onProjectState((path) => {
        const id = missingHomeAt(homes, path);
        if (id) set(withHome(homes, id, { path, exists: true }));
      });
      stopListening = () => {
        offRecent();
        offState();
      };
    }
    const next = [...new Set([...holders.values()].flat())].toSorted().join("\n");
    if (next === held) return;
    held = next;
    generation++;
    readAll();
  };
  return {
    acquire(reads) {
      const holder = {};
      holders.set(holder, reads.split("\n").filter(Boolean));
      update();
      return () => {
        holders.delete(holder);
        update();
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => homes,
  };
}

const chatsHomes = createChatsHomes({
  read: async (id) => bridgeFor(id).chatsHome?.(),
  onRecentChanged: (listener) => {
    window.addEventListener(RECENT_PROJECTS_CHANGED, listener);
    return () => window.removeEventListener(RECENT_PROJECTS_CHANGED, listener);
  },
  onProjectState: (listener) => stateEvents.onProjectState(({ path }) => listener(path)),
});

export function useChatsGroup(enabled: boolean): ProjectGroup | undefined {
  const { thisMac, computers } = useComputers();
  const hiddenComputers = useHiddenComputers();
  const reads = [
    `${LOCAL_COMPUTER} online`,
    ...computers.filter((computer) => computer.state !== "off").map((computer) => `${computer.id} ${computer.state}`),
  ].join("\n");
  useEffect(() => (enabled ? chatsHomes.acquire(reads) : undefined), [enabled, reads]);
  const homes = useSyncExternalStore(chatsHomes.subscribe, chatsHomes.snapshot);
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

export function shortPath(key: string): string {
  return String(unqualifyKey(key)).replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

function useKnownProjects(enabled: boolean, computers: { id: string; state: string }[]): Record<string, RecentProject[]> {
  const [known, setKnown] = useState<Record<string, RecentProject[]>>({});
  const reads = [
    `${LOCAL_COMPUTER} online`,
    ...computers.filter((computer) => computer.state !== "off").map((computer) => `${computer.id} ${computer.state}`),
  ].join("\n");
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const read = () => {
      for (const line of reads.split("\n")) {
        const id = line.slice(0, line.lastIndexOf(" "));
        void Promise.resolve()
          .then(() => bridgeFor(id).listKnownProjects())
          .then(
            (list) => {
              if (live && Array.isArray(list)) setKnown((previous) => ({ ...previous, [id]: list }));
            },
            () => {},
          );
      }
    };
    read();
    window.addEventListener(RECENT_PROJECTS_CHANGED, read);
    return () => {
      live = false;
      window.removeEventListener(RECENT_PROJECTS_CHANGED, read);
    };
  }, [enabled, reads]);
  return known;
}

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
  const known = useKnownProjects(enabled, computers);
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
  const remoteProjects = computers.flatMap((computer): ComputerProject[] =>
    known[computer.id]
      ? known[computer.id]!.map((project) => ({ ...project, computerId: computer.id }))
      : remote.projects.filter((project) => project.computerId === computer.id),
  );
  return projectGroups({
    current: { key: currentKey, name: currentName, kind: currentKind },
    recent: known[LOCAL_COMPUTER] ?? recent,
    remote: remoteProjects,
    hiddenComputers,
    copy,
  });
}

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

export function useNamedLinks(enabled: boolean): NamedProjectLink[] {
  const [links, setLinks] = useState<NamedProjectLink[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void Promise.resolve()
      .then(() => window.milagre?.listNamedLinks?.())
      .then(
        (list) => {
          if (live && Array.isArray(list)) setLinks(pickerLinks(list));
        },
        () => {},
      );
    return () => {
      live = false;
    };
  }, [enabled]);
  return links;
}

export function pickerLinks<T extends { name: string; hidden?: boolean; canvasLinkId?: string }>(links: readonly T[]): T[] {
  return links.filter((link) => !link.hidden && !link.canvasLinkId).toSorted((a, b) => a.name.localeCompare(b.name));
}
