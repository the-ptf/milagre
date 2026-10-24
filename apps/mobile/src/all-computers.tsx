import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { createAllComputersStore, type HostView, type ViewPolicy } from "./all-computers-store";
import { listArchivedChats } from "./chat-list-archived";
import { createClient } from "./client";
import { savedFoldedProjects, savedHiddenProjects, savedProjectOrder } from "./hosts-native";
import type { SavedHost } from "./hosts-store";
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
  const { client, recent, hosts, hostName, reloadProjects, seedPreview } = session;
  const saved = useMemo<SavedHost[]>(
    () =>
      client && !hosts.some((host) => host.id === client.url)
        ? [{ id: client.url, name: hostName || "Computer", address: client.url, token: "", lastUsed: 0 }, ...hosts]
        : hosts,
    [client, hosts, hostName],
  );
  // Before paint, so the first frame of a sidebar already lists the session's own computer.
  useLayoutEffect(() => {
    allComputers.sync(saved, client ? { hostId: client.url, client, projects: recent, reload: reloadProjects, seed: seedPreview } : null);
  }, [saved, client, recent, reloadProjects, seedPreview]);
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
