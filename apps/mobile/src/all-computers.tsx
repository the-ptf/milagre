import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { createAllComputersStore, type HostView, type ViewPolicy } from "./all-computers-store";
import { listArchivedChats } from "./chat-list-archived";
import { setChatPagesForeground, warmChatPages } from "./chat-pages";
import { createClient } from "./client";
import { savedChatDefaults, savedFoldedProjects, savedHiddenProjects, savedProjectOrder } from "./hosts-native";
import type { SavedHost } from "./hosts-store";
import { newChatProjects, noProjectChoice, type NewChatProject, type NoProjectChoice } from "./new-chat-project";
import type { Client, RecentProject } from "./client";
import { relayRuntime } from "./relay-native";
import { useSession } from "./session";

export const allComputers = createAllComputersStore({
  createClient: (host) => createClient(host, fetch, 10000, relayRuntime),
  applyProjects: async (hostId, projects) => savedProjectOrder.apply(hostId, await savedHiddenProjects.apply(hostId, projects)),
  now: Date.now,
  random: Math.random,
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  warm: (client, chats, limit) =>
    client.chatMessages ? warmChatPages({ url: client.url, chatMessages: client.chatMessages }, chats, limit) : Promise.resolve(),
});
AppState.addEventListener("change", (state) => {
  allComputers.setForeground(state === "active");
  setChatPagesForeground(state === "active");
});

let foldVersion = 0;
savedFoldedProjects.subscribe(() => foldVersion++);
const subscribeFolds = (listener: () => void) => savedFoldedProjects.subscribe(listener);
const heldFolds = new Map<string, { version: number; sets: ReadonlyMap<string, ReadonlySet<string>> }>();

export function useFoldedProjects(hostIds: string[]): ReadonlyMap<string, ReadonlySet<string>> {
  const key = hostIds.join("\n");
  return useSyncExternalStore(subscribeFolds, () => {
    const held = heldFolds.get(key);
    if (held?.version === foldVersion) return held.sets;
    for (const [other, value] of heldFolds) if (value.version !== foldVersion) heldFolds.delete(other);
    const sets = new Map(hostIds.map((id) => [id, savedFoldedProjects.folded(id)]));
    heldFolds.set(key, { version: foldVersion, sets });
    return sets;
  });
}

function useAllComputersStore({ visible, expandAll }: { visible: boolean; expandAll: boolean }) {
  const session = useSession();
  const { client, recent, recentLoaded, hosts, hostName, reloadProjects, seedPreview } = session;
  const saved = useMemo<SavedHost[]>(
    () =>
      client && !hosts.some((host) => host.id === client.url)
        ? [{ id: client.url, name: hostName || "Computer", address: client.url, token: "", lastUsed: 0 }, ...hosts]
        : hosts,
    [client, hosts, hostName],
  );
  useLayoutEffect(() => {
    allComputers.sync(
      saved,
      client ? { hostId: client.url, client, projects: recentLoaded ? recent : undefined, reload: reloadProjects, seed: seedPreview } : null,
    );
  }, [saved, client, recent, recentLoaded, reloadProjects, seedPreview]);
  const folded = useFoldedProjects(useMemo(() => saved.map((host) => host.id), [saved]));
  useEffect(() => {
    for (const host of saved) void savedFoldedProjects.load(host.id);
  }, [saved]);
  const policy = useMemo<ViewPolicy>(
    () => ({
      visible,
      expandAll,
      isFolded: (hostId, path) => !savedFoldedProjects.loaded(hostId) || !!folded.get(hostId)?.has(path),
    }),
    [visible, expandAll, folded],
  );
  const registration = useRef<ReturnType<typeof allComputers.register> | null>(null);
  useEffect(() => {
    const mine = allComputers.register(policy);
    registration.current = mine;
    return () => {
      registration.current = null;
      mine.release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    registration.current?.update(policy);
  }, [policy]);
}

export function useAllComputers({ visible, expandAll }: { visible: boolean; expandAll: boolean }): HostView[] {
  useAllComputersStore({ visible, expandAll });
  const versions = useSyncExternalStore(allComputers.subscribe, allComputers.versions);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- versions changes exactly when a view does.
  return useMemo(() => allComputers.views(), [versions]);
}

export function useComputerViews(): HostView[] {
  const versions = useSyncExternalStore(allComputers.subscribe, allComputers.versions);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- versions changes exactly when a view does.
  return useMemo(() => allComputers.views(), [versions]);
}

export async function setOtherComputerProjectHidden(hostId: string, path: string, hidden: boolean) {
  if (process.env.EXPO_PUBLIC_DEMO !== "1") await savedHiddenProjects.setHidden(hostId, path, hidden);
  allComputers.setProjectHidden(hostId, path, hidden);
  if (!hidden) void allComputers.refreshProject(hostId, path).catch(() => {});
}

const knownProjects = new Map<string, RecentProject[]>();
const knownReadAt = new Map<string, number>();
const knownListeners = new Set<() => void>();
let knownVersion = 0;
const KNOWN_EVERY = 60 * 1000;
const subscribeKnown = (listener: () => void) => {
  knownListeners.add(listener);
  return () => knownListeners.delete(listener);
};
function readKnown(hostId: string) {
  const at = knownReadAt.get(hostId);
  if (at !== undefined && Date.now() - at < KNOWN_EVERY) return;
  const client = allComputers.clientFor(hostId);
  if (!client) return;
  knownReadAt.set(hostId, Date.now());
  client.call<RecentProject[]>("project:known", []).then(
    (list) => {
      if (!Array.isArray(list)) return;
      knownProjects.set(hostId, list);
      knownVersion++;
      for (const listener of knownListeners) listener();
    },
    () => {},
  );
}

export function useNewChatProjects(read = false): NewChatProject[] {
  const versions = useSyncExternalStore(allComputers.subscribe, allComputers.versions);
  const known = useSyncExternalStore(subscribeKnown, () => knownVersion);
  const reachable = allComputers
    .views()
    .filter((view) => view.state !== "offline")
    .map((view) => view.hostId)
    .join("\n");
  useEffect(() => {
    if (!read || !reachable) return;
    for (const hostId of reachable.split("\n")) readKnown(hostId);
  }, [read, reachable]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- versions and known change exactly when a view or a known list does.
  return useMemo(() => newChatProjects(allComputers.views(), read ? knownProjects : undefined), [versions, known, read]);
}

export function useNoProjectChoice(currentHostId: string | undefined): NoProjectChoice | undefined {
  const versions = useSyncExternalStore(allComputers.subscribe, allComputers.versions);
  return useMemo(
    () => noProjectChoice(allComputers.views(), savedChatDefaults.readLastComputer(), currentHostId),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- versions changes exactly when a view does.
    [versions, currentHostId],
  );
}

export async function chatsHomePath(client: Client, hostId: string, home: { path: string; exists: boolean }): Promise<string> {
  if (home.exists) return home.path;
  const opened = await client.ensureChatsHome();
  allComputers.setHome(hostId, { path: opened.path, exists: true });
  return opened.path;
}

export function useArchivedChats() {
  const views = useAllComputers({ visible: true, expandAll: true });
  return useMemo(
    () => ({
      chats: listArchivedChats(views),
      loading: views.some((view) => view.state !== "offline" && !view.copies.size && (!view.loaded || view.projects.length > 0)),
    }),
    [views],
  );
}

export function useArchivedCount(): number | null {
  const versions = useSyncExternalStore(allComputers.subscribe, allComputers.versions);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- versions changes exactly when a view does.
  return useMemo(() => archivedCount(allComputers.views()), [versions]);
}

const archivedCount = (views: HostView[]) => (views.some((view) => view.copies.size) ? listArchivedChats(views).length : null);
