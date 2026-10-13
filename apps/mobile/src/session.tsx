import { reconcileState } from "@milagre/shared/reconcile";
import { keepOrder } from "@milagre/shared/stable-order";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { createClient, type ClientHost, type Client, type OpenProject, type RecentProject, type Snapshot, type ProjectPreview } from "./client";
import { relayRuntime } from "./relay-native";
import { learnRoutes, lanRoutes } from "./routes-native";
import { syncProject } from "./live";
import { refreshLinks } from "./use-links";
import { useDesigns } from "./use-designs";
import { readPermission, savedChatDefaults, savedHosts, savedNavigation, savedProjectOrder, savePermission } from "./hosts-native";
import type { ChatLocation } from "./navigation-store";
import type { SavedHost } from "./hosts-store";
import type { AgentCliStatus, AgentModels, PermissionMode } from "@milagre/shared/model";
import type { Attachment } from "./attachments";
import { defaultPreferences, type TurnPreferences } from "./turn-options";
import { pendingChatSessionId, type PendingChat } from "@milagre/shared/chats";
import { createLinkOperations } from "./link-operations";

const hostOf = (url: string) =>
  // oxlint-disable-next-line unicorn/prefer-string-starts-ends-with -- url comes from a pairing payload that is not validated here (see the String(url || '') fallback), so it may be empty or missing
  /^relay:/.test(url)
    ? "Mac"
    : String(url || "")
        .replace(/^https?:\/\//, "")
        .replace(/[:/].*$/, "") || "Computer";
/** A computer to connect to: a saved one, a scanned pairing, or an address and token typed in. */
export type HostLink = ClientHost & { name?: string };

function useSessionState() {
  const [client, setClient] = useState<Client | null>(null);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  // The computer whose Projects list `recent` holds, once it has answered: an empty list before that is not "no Projects".
  const listedFor = useRef<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const designs = useDesigns(client, snapshot?.project.path, recent[0]?.path);
  const [error, setError] = useState("");
  const [models, setModels] = useState<AgentModels | null>(null);
  const [cliStatus, setCliStatus] = useState<AgentCliStatus | null>(null);
  const [providerError, setProviderError] = useState("");
  const [hosts, setHosts] = useState<SavedHost[]>([]);
  const [hostName, setHostName] = useState("");
  const [booted, setBooted] = useState(false);
  const [lastLocation, setLastLocation] = useState<ChatLocation | null>(null);
  const busyUntil = useRef(0);
  const generation = useRef(0);
  const selection = useRef<{ client: Client; path: string } | null>(null);
  // The last snapshot of each Project this session saw, so reopening one shows its Chats at once while it refreshes.
  const seen = useRef(new Map<string, Snapshot>());
  const listed = useRef(new Map<string, Snapshot | ProjectPreview>());
  const previews = useRef(new Map<Client, Map<string, Promise<Snapshot | ProjectPreview>>>());
  // Keep streamed status and local refreshes in the copy a remounted drawer will read.
  useEffect(() => {
    if (client && snapshot) {
      const key = `${client.url}|${snapshot.project.path}`;
      seen.current.set(key, snapshot);
      listed.current.set(key, snapshot);
    }
  }, [client, snapshot]);
  const cachedProject = useCallback(
    (path: string) => (client ? (listed.current.get(`${client.url}|${path}`) ?? seen.current.get(`${client.url}|${path}`)) : undefined),
    [client],
  );
  /** The Project being opened, and whether its last copy is already on screen. */
  const [opening, setOpening] = useState<{ path: string; cached: boolean } | null>(null);
  // Launch may open the only saved computer once; after any connect or a Disconnect it never does again.
  const autoOpen = useRef(true);
  const claimAutoOpen = () => {
    const first = autoOpen.current;
    autoOpen.current = false;
    return first;
  };
  const scopeKey = snapshot?.project.path;
  const providerRequest = useRef(0);
  // Each Project's last model lists and CLI status, per computer, shown at once on a switch while they reload.
  const providerCache = useRef(new Map<string, { models: AgentModels; status: AgentCliStatus }>());
  const providerContext = useRef({ client, scopeKey });
  useEffect(() => {
    providerContext.current = { client, scopeKey };
  }, [client, scopeKey]);
  const [providerRevision, setProviderRevision] = useState(0);
  const refreshProviders = useCallback(async () => {
    if (!client || process.env.EXPO_PUBLIC_DEMO === "1") return;
    const version = ++providerRequest.current;
    const current = () => version === providerRequest.current && providerContext.current.client === client && providerContext.current.scopeKey === scopeKey;
    setProviderRevision((value) => value + 1);
    const key = `${client.url}|${scopeKey ?? ""}`;
    const hit = providerCache.current.get(key);
    setModels(hit?.models ?? null);
    setCliStatus(hit?.status ?? null);
    setProviderError("");
    try {
      const args = scopeKey ? [scopeKey] : [];
      const [models, status] = await Promise.all([client.call<AgentModels>("agent:models", args), client.call<AgentCliStatus>("agent:cli-status", args)]);
      if (!current()) return;
      providerCache.current.set(key, { models, status });
      setModels(models);
      setCliStatus(status);
    } catch {
      if (current()) setProviderError("Could not check the installed agents. Reconnect to check again.");
    }
  }, [client, scopeKey]);
  const invalidateProviders = useCallback(() => {
    providerRequest.current++;
  }, []);
  useEffect(() => {
    // Invalidate previously displayed discovery when the selected Project changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshProviders();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshProviders();
    });
    return () => {
      invalidateProviders();
      subscription.remove();
    };
  }, [refreshProviders, invalidateProviders]);
  const loadHosts = useCallback(async () => {
    const list = await savedHosts.list();
    setHosts(list);
    for (const saved of list) lanRoutes.set(saved.id, saved.token, saved.routes?.lan);
    return list;
  }, []);
  // Saved computers are read once at launch; the startup splash waits for them.
  useEffect(() => {
    void Promise.all([
      savedHosts
        .list()
        .then((list) => {
          setHosts(list);
          for (const saved of list) lanRoutes.set(saved.id, saved.token, saved.routes?.lan);
          return list;
        })
        .catch(() => {}),
      savedNavigation.read().then(setLastLocation),
    ]).finally(() => setBooted(true));
  }, []);
  const rememberChat = useCallback(
    (chatId: number) => {
      if (!client || !snapshot || !Number.isSafeInteger(chatId) || chatId <= 0) return;
      const location = { hostId: client.url, projectPath: snapshot.project.path, chatId };
      setLastLocation(location);
      void savedNavigation.save(location);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, snapshot?.project.path],
  );
  const connect = async (host: HostLink, remember = true) => {
    const next = createClient(host, undefined, undefined, relayRuntime);
    const name = host.name || "";
    const current = ++generation.current;
    const previous = selection.current;
    try {
      await next.call("daemon:status");
      const projects = await savedProjectOrder.apply(next.url, await next.recentScopes());
      if (current !== generation.current) return false;
      if (process.env.EXPO_PUBLIC_DEMO !== "1") {
        if (remember) {
          try {
            await savedHosts.save({
              name: name || hosts.find((saved) => saved.id === next.url)?.name || hostOf(next.url),
              address: next.url,
              token: host.token.trim(),
              ...(host.access ? { access: host.access } : {}),
              ...(host.relay ? { relay: host.relay } : {}),
            });
          } catch {
            throw new Error("Could not save this computer on your device. Try pairing again.");
          }
          void loadHosts().catch(() => {});
        }
      }
      if (current !== generation.current) return false;
      if (process.env.EXPO_PUBLIC_DEMO !== "1") void learnRoutes(next, { token: host.token.trim(), relay: host.relay }).catch(() => {});
      setModels(null);
      setCliStatus(null);
      setProviderError("");
      autoOpen.current = false;
      selection.current = null;
      setClient(next);
      listedFor.current = next.url;
      setRecent(projects);
      setSnapshot(null);
      setError("");
      setHostName(name || hosts.find((saved) => saved.id === next.url)?.name || hostOf(next.url));
      return true;
    } catch (error) {
      if (current === generation.current) selection.current = previous;
      throw error;
    }
  };
  const openNotificationTarget = async (host: SavedHost, projectPath: string, sessionId: number) => {
    autoOpen.current = false;
    const current = ++generation.current;
    const next = createClient(host, undefined, undefined, relayRuntime);
    try {
      await next.call("daemon:status");
      if (current !== generation.current) return false;
      if (process.env.EXPO_PUBLIC_DEMO !== "1") void learnRoutes(next, { token: host.token, relay: host.relay }).catch(() => {});
      const projects = await savedProjectOrder.apply(next.url, await next.recentScopes());
      const state = await next.open(projectPath);
      const project = state.project;
      if (current !== generation.current) return false;
      if (!state.project.state.sessions[sessionId]) throw new Error("This Chat is no longer available on your computer.");
      selection.current = { client: next, path: project.path };
      seen.current.set(`${next.url}|${projectPath}`, state).set(`${next.url}|${project.path}`, state);
      setOpening(null);
      setModels(null);
      setCliStatus(null);
      setProviderError("");
      setClient(next);
      listedFor.current = next.url;
      setRecent(projects);
      setSnapshot(state);
      setError("");
      setHostName(host.name);
      return true;
    } catch (error) {
      if (current !== generation.current) return false;
      throw error;
    }
  };
  const navigationVersion = useCallback(() => generation.current, []);
  const cancelNavigation = useCallback(() => {
    generation.current++;
  }, []);
  const open = async (projectPath: string, options: { background?: boolean; chatId?: number } = {}) => {
    if (!client) throw new Error("Connect to your computer first.");
    const current = ++generation.current;
    const previous = selection.current;
    if (!options.background) selection.current = null;
    const cached = seen.current.get(`${client.url}|${projectPath}`);
    if (!options.background) {
      setOpening({ path: projectPath, cached: !!cached });
      if (cached) setSnapshot(cached);
    }
    try {
      const state = await client.open(projectPath);
      const project = state.project;
      if (current === generation.current) {
        if (options.chatId !== undefined && !state.project.state.sessions[options.chatId])
          throw new Error("This Chat is no longer available. Choose another Chat.");
        selection.current = { client, path: project.path };
        seen.current.set(`${client.url}|${projectPath}`, state).set(`${client.url}|${project.path}`, state);
        setSnapshot((previous) => reconcileState(previous ?? undefined, state));
        setError("");
        setRecent((previous) =>
          previous.some((item) => item.path === project.path)
            ? previous
            : [...previous, { path: project.path, name: project.name, ...(project.link ? { link: project.link.link, projects: project.link.projects } : {}) }],
        );
        return state;
      }
    } catch (error) {
      if (current === generation.current) selection.current = previous;
      throw error;
    } finally {
      if (current === generation.current) setOpening(null);
    }
  };
  // Reading a drawer group does not select it or disturb the Chat behind the drawer.
  const previewProject = useCallback(
    (path: string): Promise<Snapshot | ProjectPreview> => {
      if (!client) return Promise.reject(new Error("Connect to your computer first."));
      let pending = previews.current.get(client);
      if (!pending) {
        pending = new Map();
        previews.current.set(client, pending);
      }
      const existing = pending.get(path);
      if (existing) return existing;
      const key = `${client.url}|${path}`;
      const previous = listed.current.get(key) ?? seen.current.get(key);
      const work = (async () => {
        const linked = path.startsWith("milagre-link:");
        const project = linked ? { path } : await client.call<OpenProject>("project:open", [path]);
        const canonicalKey = `${client.url}|${project.path}`;
        const canonicalPrevious = listed.current.get(canonicalKey) ?? seen.current.get(canonicalKey);
        const copy = linked ? await client.open(path) : await client.preview(project.path);
        // A live update or foreground open that landed meanwhile is newer than this preview.
        const latest = listed.current.get(canonicalKey) ?? seen.current.get(canonicalKey);
        const requested = listed.current.get(key) ?? seen.current.get(key);
        const next = latest && latest !== canonicalPrevious ? latest : requested && requested !== previous ? requested : copy;
        listed.current.set(key, next).set(canonicalKey, next);
        // Only full snapshots can warm navigation. A summary must never erase already-read messages.
        if (!next.previewOnly) seen.current.set(key, next).set(canonicalKey, next);
        return next;
      })().finally(() => {
        pending.delete(path);
        if (!pending.size) previews.current.delete(client);
      });
      pending.set(path, work);
      return work;
    },
    [client],
  );
  const reloadProjects = useCallback(async () => {
    if (!client) return;
    const current = generation.current;
    const projects = await client.recentScopes();
    // Opening a Chat opens its Project, which moves it to the top of the host's recent list; rows keep their place.
    if (current === generation.current) {
      listedFor.current = client.url;
      setRecent((previous) => keepOrder(previous, projects, (item) => item.path));
    }
  }, [client]);
  // The order shown is this computer's saved order, so the next launch starts from it. An empty list is saved too once
  // the computer has answered, so Projects removed and added back don't return to their old places.
  useEffect(() => {
    if (!client || listedFor.current !== client.url || process.env.EXPO_PUBLIC_DEMO === "1") return;
    void savedProjectOrder.save(
      client.url,
      recent.map((item) => item.path),
    );
  }, [client, recent]);
  const projectPath = snapshot?.project.path;
  const refresh = useCallback(async () => {
    const current = selection.current;
    if (!client || !projectPath || current?.client !== client || current.path !== projectPath) return;
    try {
      const state = await client.snapshot(projectPath);
      if (current === selection.current) {
        seen.current.set(`${client.url}|${projectPath}`, state);
        setSnapshot((previous) => reconcileState(previous ?? undefined, state));
        setError("");
      }
    } catch (error) {
      if (current === selection.current) throw error;
    }
  }, [client, projectPath]);
  /** Fetches only the Project's streaming turns and puts them into the snapshot on screen. */
  const refreshRuns = useCallback(async () => {
    const current = selection.current;
    if (!client || !projectPath || current?.client !== client || current.path !== projectPath) return;
    try {
      const runs = await client.runs(projectPath);
      // A snapshot that landed meanwhile may already hold later runs.
      if (current === selection.current) {
        setSnapshot((previous) =>
          previous?.project.path === projectPath && (runs.seq ?? 0) >= (previous.runs.seq ?? 0) ? reconcileState(previous, { ...previous, runs }) : previous,
        );
        setError("");
      }
    } catch (error) {
      if (current === selection.current) throw error;
    }
  }, [client, projectPath]);
  const running = useRef(false);
  const anyRunning = !!snapshot && Object.keys(snapshot.runs.runs).length > 0;
  useEffect(() => {
    running.current = anyRunning;
  }, [anyRunning]);
  /** Poll quickly for a while after the user acts, so a new turn shows up before its first event arrives. */
  const expectActivity = () => {
    busyUntil.current = Date.now() + 15000;
  };
  const { refresh: refreshDesigns, connectionChanged: designsConnectionChanged } = designs;
  // The bridge's live socket says when to fetch; polling is the fallback while it is down or the bridge predates it.
  useEffect(() => {
    if (!client || !projectPath) return;
    return syncProject({
      connect: (options) => client.live(projectPath, options),
      snapshot: refresh,
      runs: refreshRuns,
      accounts: () => {
        providerCache.current.clear();
        void refreshProviders();
      },
      links: () => void refreshLinks(client),
      designs: () => void refreshDesigns(),
      liveStatus: designsConnectionChanged,
      onError: (error) => setError(error.message),
      active: () => AppState.currentState === "active",
      watchActive: (listener) => {
        const subscription = AppState.addEventListener("change", (state) => listener(state === "active"));
        return () => subscription.remove();
      },
      // Live turns refresh every second; an idle Project only needs a slower check for changes made elsewhere.
      pollDelay: () => (running.current || Date.now() < busyUntil.current ? 1000 : 4000),
    });
  }, [client, projectPath, refresh, refreshRuns, refreshProviders, refreshDesigns, designsConnectionChanged]);
  const selected = selection.current;
  const isSelected = () => selected !== null && selection.current === selected;
  const disconnect = () => {
    autoOpen.current = false;
    generation.current++;
    selection.current = null;
    setClient(null);
    setSnapshot(null);
    setError("");
  };
  return {
    booted,
    lastLocation,
    rememberChat,
    cachedProject,
    previewProject,
    reloadProjects,
    claimAutoOpen,
    opening,
    hosts,
    loadHosts,
    hostName,
    expectActivity,
    client,
    designs,
    recent,
    snapshot,
    error,
    setError,
    models,
    cliStatus,
    providerError,
    refreshProviders,
    providerRevision,
    connect,
    open,
    openNotificationTarget,
    navigationVersion,
    cancelNavigation,
    refresh,
    isSelected,
    disconnect,
  };
}
/**
 * Drafts, attachments and turn settings change on every keystroke, so they live in their own context: typing re-renders
 * only the composer's screens, not every screen that reads the connection and snapshot.
 */
function ComposerProvider({ children }: { children: React.ReactNode }) {
  const [linkOperations] = useState(createLinkOperations);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [attachments, setAttachments] = useState<Record<string, Attachment[]>>({});
  const [preferences, setPreferences] = useState<Record<string, TurnPreferences>>({});
  // Compact now, pressed on the context sheet: the chat screen sends `/compact` when its counter moves (see chat.tsx).
  const [compactRequests, setCompactRequests] = useState<Record<string, number>>({});
  const requestCompact = useCallback((chatId: string) => setCompactRequests((current) => ({ ...current, [chatId]: (current[chatId] ?? 0) + 1 })), []);
  // Like desktop's default permission mode: the last one picked starts every Chat, and survives a relaunch.
  const [permission, setPermission] = useState<PermissionMode>("ask");
  useEffect(() => {
    void readPermission().then((saved) => {
      if (saved) setPermission(saved);
    });
  }, []);
  const [modelDefaults, setModelDefaults] = useState(() => savedChatDefaults.readModel());
  const defaults = useMemo(() => ({ ...defaultPreferences, ...modelDefaults, permissionMode: permission }), [modelDefaults, permission]);
  const setDefaultModel = useCallback((choice: TurnPreferences) => {
    const { provider, model, effort, fastMode, ultracode } = choice;
    setModelDefaults({ provider, model, effort, fastMode, ultracode });
    void savedChatDefaults.saveModel(choice);
  }, []);
  const setDefaultPermission = useCallback((mode: PermissionMode) => {
    setPermission(mode);
    void savePermission(mode);
  }, []);
  const value = useMemo(
    () => ({
      drafts,
      setDrafts,
      attachments,
      setAttachments,
      preferences,
      setPreferences,
      defaults,
      setDefaultPermission,
      setDefaultModel,
      linkOperations,
      compactRequests,
      requestCompact,
    }),
    [drafts, attachments, preferences, defaults, setDefaultPermission, setDefaultModel, linkOperations, compactRequests, requestCompact],
  );
  return <ComposerContext.Provider value={value}>{children}</ComposerContext.Provider>;
}
type Composer = {
  linkOperations: ReturnType<typeof createLinkOperations>;
  defaults: TurnPreferences;
  setDefaultModel: (choice: TurnPreferences) => void;
  setDefaultPermission: (mode: PermissionMode) => void;
  drafts: Record<string, string>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  attachments: Record<string, Attachment[]>;
  setAttachments: React.Dispatch<React.SetStateAction<Record<string, Attachment[]>>>;
  preferences: Record<string, TurnPreferences>;
  setPreferences: React.Dispatch<React.SetStateAction<Record<string, TurnPreferences>>>;
  /** How many times Compact now was pressed per chat key; the chat screen acts on each change. */
  compactRequests: Record<string, number>;
  requestCompact: (chatId: string) => void;
};
const ComposerContext = createContext<Composer | null>(null);
export type MobilePendingChat = {
  preview: PendingChat;
  hostId: string;
  projectPath: string;
  originChatId: string;
  originSessionId: number | null;
  worktreeId: number;
  newWorktree: boolean;
  accepted: boolean;
  promoted?: boolean;
};
type PendingChats = {
  pendingChats: Record<string, MobilePendingChat>;
  setPendingChats: React.Dispatch<React.SetStateAction<Record<string, MobilePendingChat>>>;
};
const PendingChatsContext = createContext<PendingChats | null>(null);
function PendingChatsProvider({ children, snapshot, hostId }: { children: React.ReactNode; snapshot: Snapshot | null; hostId?: string }) {
  const [pendingChats, setPendingChats] = useState<Record<string, MobilePendingChat>>({});
  // Retire acknowledged previews as the live snapshot catches up, before children render the new state.
  const accepted = snapshot
    ? Object.entries(pendingChats)
        .filter(
          ([, pending]) =>
            pending.accepted &&
            pending.promoted &&
            pending.hostId === hostId &&
            pending.projectPath === snapshot.project.path &&
            pendingChatSessionId(snapshot.project.state, pending.preview) !== null,
        )
        .map(([key]) => key)
    : [];
  if (accepted.length) setPendingChats((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !accepted.includes(key))));
  const value = useMemo(() => ({ pendingChats, setPendingChats }), [pendingChats]);
  return <PendingChatsContext.Provider value={value}>{children}</PendingChatsContext.Provider>;
}
export function usePendingChats() {
  const pending = useContext(PendingChatsContext);
  if (!pending) throw new Error("SessionProvider is required");
  return pending;
}
export function useComposer() {
  const composer = useContext(ComposerContext);
  if (!composer) throw new Error("SessionProvider is required");
  return composer;
}
const SessionContext = createContext<ReturnType<typeof useSessionState> | null>(null);
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const session = useSessionState();
  return (
    <SessionContext.Provider value={session}>
      <PendingChatsProvider snapshot={session.snapshot} hostId={session.client?.url}>
        <ComposerProvider>{children}</ComposerProvider>
      </PendingChatsProvider>
    </SessionContext.Provider>
  );
}
export function useSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error("SessionProvider is required");
  return session;
}
