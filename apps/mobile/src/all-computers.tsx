import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { createAllComputersStore, type HostView, type ViewPolicy } from "./all-computers-store";
import { listArchivedChats } from "./chat-list-archived";
import { warmChatPages } from "./chat-pages";
import { createClient } from "./client";
import { savedChatDefaults, savedFoldedProjects, savedHiddenProjects, savedProjectOrder } from "./hosts-native";
import type { SavedHost } from "./hosts-store";
import { newChatProjects, noProjectChoice, type NewChatProject, type NoProjectChoice } from "./new-chat-project";
import type { Client, RecentProject } from "./client";
import { relayRuntime } from "./relay-native";
import { useSession } from "./session";

/**
 * The one store behind every sidebar: each saved computer's Projects and Chat lists, read while a sidebar is shown. It
 * lives for the app so a sidebar that opens again starts from what it last saw.
 */
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
AppState.addEventListener("change", (state) => allComputers.setForeground(state === "active"));

// Folds change in savedFoldedProjects; this counts them so the folded sets can be handed out as one stable value.
let foldVersion = 0;
savedFoldedProjects.subscribe(() => foldVersion++);
const subscribeFolds = (listener: () => void) => savedFoldedProjects.subscribe(listener);
let heldFolds: { version: number; key: string; sets: ReadonlyMap<string, ReadonlySet<string>> } | null = null;

/** Each of these computers' folded Project groups. A new map only when some fold, or the computers, change. */
export function useFoldedProjects(hostIds: string[]): ReadonlyMap<string, ReadonlySet<string>> {
  const key = hostIds.join("\n");
  return useSyncExternalStore(subscribeFolds, () => {
    if (heldFolds?.version === foldVersion && heldFolds.key === key) return heldFolds.sets;
    heldFolds = { version: foldVersion, key, sets: new Map(hostIds.map((id) => [id, savedFoldedProjects.folded(id)])) };
    return heldFolds.sets;
  });
}

/** Keeps the store in step with the session's saved computers and client, and reads while `visible`. */
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
  // Before paint, so the first frame of a sidebar already lists the session's own computer.
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
      // Until a computer's folds are read, its groups count as folded: nothing is fetched that was folded by hand.
      isFolded: (hostId, path) => !savedFoldedProjects.loaded(hostId) || !!folded.get(hostId)?.has(path),
    }),
    [visible, expandAll, folded],
  );
  // Each mounted consumer registers its own needs and takes them back on unmount; the store reads the union of them.
  const registration = useRef<ReturnType<typeof allComputers.register> | null>(null);
  useEffect(() => {
    const mine = allComputers.register(policy);
    registration.current = mine;
    return () => {
      registration.current = null;
      mine.release();
    };
    // Registered once per mount; `policy` changes go through update below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    registration.current?.update(policy);
  }, [policy]);
}

/** Every shown computer's data, rereading while `visible`. The array changes only when some computer's data does. */
export function useAllComputers({ visible, expandAll }: { visible: boolean; expandAll: boolean }): HostView[] {
  useAllComputersStore({ visible, expandAll });
  const versions = useSyncExternalStore(allComputers.subscribe, allComputers.versions);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- versions changes exactly when a view does.
  return useMemo(() => allComputers.views(), [versions]);
}

/**
 * Every shown computer's Projects as the sidebars last read them, for Choose projects. Reads nothing itself: the
 * sidebar that opened it keeps them read.
 */
export function useComputerViews(): HostView[] {
  const versions = useSyncExternalStore(allComputers.subscribe, allComputers.versions);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- versions changes exactly when a view does.
  return useMemo(() => allComputers.views(), [versions]);
}

/** Saves a Project hidden or shown on this phone for another computer than the session's, and lists it so. */
export async function setOtherComputerProjectHidden(hostId: string, path: string, hidden: boolean) {
  if (process.env.EXPO_PUBLIC_DEMO !== "1") await savedHiddenProjects.setHidden(hostId, path, hidden);
  allComputers.setProjectHidden(hostId, path, hidden);
  // A Project shown again has no Chats read yet; read it now instead of on the next poll.
  if (!hidden) void allComputers.refreshProject(hostId, path).catch(() => {});
}

// Each computer's every known Project (project:known), read while a new Chat is being set up and kept for the app's life,
// so the next new Chat starts with it. A computer that predates the command has none: its recent Projects stand alone.
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
    // Not answered (an older Mac, a dropped connection): asked again on the next new Chat after a while.
    () => {},
  );
}

/**
 * The Projects a new Chat can start in, on every shown computer: what the sidebars last read, and with `read`, every
 * Project each computer that answers knows (read while `read` is on, at most once a minute per computer).
 */
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

/** The new-chat picker's No project row, as the sidebars last read the computers. Reads nothing itself. */
export function useNoProjectChoice(currentHostId: string | undefined): NoProjectChoice | undefined {
  const versions = useSyncExternalStore(allComputers.subscribe, allComputers.versions);
  return useMemo(
    () => noProjectChoice(allComputers.views(), savedChatDefaults.readLastComputer(), currentHostId),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- versions changes exactly when a view does.
    [versions, currentHostId],
  );
}

/**
 * The folder a Chat without a Project opens in on this computer: its Chats home, made first when it doesn't exist yet
 * (chats:ensure, which neither lists it as a Project nor moves the computer's shown one).
 */
export async function chatsHomePath(client: Client, hostId: string, home: { path: string; exists: boolean }): Promise<string> {
  if (home.exists) return home.path;
  const opened = await client.ensureChatsHome();
  allComputers.setHome(hostId, { path: opened.path, exists: true });
  return opened.path;
}

/**
 * The archived Chats of every computer, for Settings › Archived Chats; reads the computers (every Project, folded or not)
 * while it is mounted. `loading` holds until each computer that answers has given at least one Project's Chats.
 */
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

/** How many Chats are archived on the computers read so far, or null before any Project's Chats were read. Reads nothing itself. */
export function useArchivedCount(): number | null {
  const versions = useSyncExternalStore(allComputers.subscribe, allComputers.versions);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- versions changes exactly when a view does.
  return useMemo(() => archivedCount(allComputers.views()), [versions]);
}

const archivedCount = (views: HostView[]) => (views.some((view) => view.copies.size) ? listArchivedChats(views).length : null);
