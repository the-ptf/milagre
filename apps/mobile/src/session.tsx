import { isChatsHomeProject } from "@milagre/shared/chats-home";
import { reconcileState } from "@milagre/shared/reconcile";
import { keepOrder } from "@milagre/shared/stable-order";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import type { AgentRun } from "@milagre/shared/agent-runs";
import { createClient, type ClientHost, type Client, type OpenProject, type RecentProject, type Runs, type Snapshot, type ProjectPreview } from "./client";
import { relayRuntime } from "./relay-native";
import { learnRoutes, lanRoutes } from "./routes-native";
import { syncProject } from "./live";
import { refreshLinks } from "./use-links";
import { useDesigns } from "./use-designs";
import { readPermission, savedChatDefaults, savedHiddenProjects, savedHosts, savedNavigation, savedProjectOrder, savePermission } from "./hosts-native";
import type { ChatLocation } from "./navigation-store";
import type { SavedHost } from "./hosts-store";
import type { AgentCliStatus, AgentModels, ModelProvider, PermissionMode } from "@milagre/shared/model";
import type { Attachment } from "./attachments";
import { defaultPreferences, type TurnPreferences } from "./turn-options";
import { pendingChatSessionId, type PendingChat } from "@milagre/shared/chats";
import { READ_RETRY_BUDGET, retryKind, retrySend } from "@milagre/shared/send-retry";
import { createLinkOperations } from "./link-operations";
import { noteChatProjectOpening, prefetchChatPage } from "./chat-pages";
import { pullRequestsChanged } from "./pr-status";

const hostOf = (url: string) =>
  // oxlint-disable-next-line unicorn/prefer-string-starts-ends-with -- url comes from a pairing payload that is not validated here (see the String(url || '') fallback), so it may be empty or missing
  /^relay:/.test(url)
    ? "Mac"
    : String(url || "")
        .replace(/^https?:\/\//, "")
        .replace(/[:/].*$/, "") || "Computer";
/** A computer to connect to: a saved one, a scanned pairing, or an address and token typed in. */
export type HostLink = ClientHost & { name?: string };

/**
 * The open Project's streaming turns, kept apart from its snapshot. A streaming turn sends a runs signal up to every
 * 150 ms; putting each read into the snapshot replaced the object every screen reads, re-rendering all of them and
 * re-reading the open Chat's messages. Each update is stamped, and so is each snapshot put on screen (a whole read
 * carries the runs too): whichever is later is what shows, so a turn's end (its saved reply and its run gone, in one
 * snapshot) never shows half-applied.
 */
class RunsStore {
  private key: string | null = null;
  private runs: Runs | null = null;
  private stamp = 0;
  private clock = 0;
  private stamps = new WeakMap<Snapshot, number>();
  private listeners = new Set<() => void>();
  /** Moves on each change of what any snapshot of this store shows as its runs. */
  version = 0;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private changed() {
    this.version++;
    for (const listener of Array.from(this.listeners)) listener();
  }
  /** Whether `snapshot` is one this store's session put on screen (the Chat beside keeps its own runs in its snapshot). */
  owns(snapshot: Snapshot) {
    return this.stamps.has(snapshot);
  }
  /** A snapshot just put on screen, read whole or from the cache: its runs show until a later runs read. */
  confirm(snapshot: Snapshot) {
    this.stamps.set(snapshot, ++this.clock);
    this.changed();
  }
  clear() {
    this.key = null;
    this.runs = null;
    this.changed();
  }
  /** The runs of `snapshot`, of the Project `key` names ("computer|path"): a later runs read's, else its own. */
  runsFor(key: string, snapshot: Snapshot): Runs {
    return key === this.key && this.runs && this.stamp > (this.stamps.get(snapshot) ?? 0) ? this.runs : snapshot.runs;
  }
  /** Runs read on their own while `snapshot` shows; an answer older (by seq) than what shows now is dropped. */
  update(key: string, snapshot: Snapshot, runs: Runs) {
    const current = this.runsFor(key, snapshot);
    if ((runs.seq ?? 0) < (current.seq ?? 0)) return false;
    const next = reconcileState(current, runs);
    if (next === current) return false;
    this.key = key;
    this.runs = next;
    this.stamp = ++this.clock;
    this.changed();
    return true;
  }
}

const NO_SUBSCRIBE = () => () => {};
// The snapshots useSession hands out read their runs live; each one's own snapshot, for the store's checks.
const bases = new WeakMap<Snapshot, Snapshot>();
const baseOf = (snapshot: Snapshot) => bases.get(snapshot) ?? snapshot;
// Each component gets its own copy of a session (it tracks whether that component read the runs); the session it copies.
const sessionBases = new WeakMap<Session, Session>();
/** Whether two sessions from useSession / useMainSession are the same one (each component holds its own copy). */
export function sameSession(a: Session, b: Session) {
  return (sessionBases.get(a) ?? a) === (sessionBases.get(b) ?? b);
}
/** The runs that show now for `session`'s Project. */
function runsOf(session: Session): Runs | undefined {
  if (!session.snapshot) return undefined;
  const base = baseOf(session.snapshot);
  if (!session.client || !session.runsStore.owns(base)) return base.runs;
  return session.runsStore.runsFor(`${session.client.url}|${base.project.path}`, base);
}

/**
 * Hands out `session` with a snapshot whose `runs` reads the live ones. A component re-renders for runs only once it
 * has read them: the screens that never look at the turns (most of them) no longer re-render on every runs read.
 */
class LiveRuns {
  private touched = false;
  private last: { session: Session; version: number; value: Session } | null = null;
  private touch = () => {
    this.touched = true;
  };
  version(store: RunsStore) {
    return this.touched ? store.version : 0;
  }
  wrap(session: Session, version: number): Session {
    if (this.last?.session === session && this.last.version === version) return this.last.value;
    const base = session.snapshot;
    const client = session.client;
    let value = session;
    if (base && client && session.runsStore.owns(base)) {
      const key = `${client.url}|${base.project.path}`;
      const store = session.runsStore;
      const touch = this.touch;
      const snapshot = { ...base };
      Object.defineProperty(snapshot, "runs", {
        enumerable: true,
        configurable: true,
        get: () => {
          touch();
          return store.runsFor(key, base);
        },
      });
      bases.set(snapshot, base);
      value = { ...session, snapshot };
      sessionBases.set(value, session);
    }
    this.last = { session, version, value };
    return value;
  }
}
function useLiveRuns(session: Session | null): Session | null {
  const [reader] = useState(() => new LiveRuns());
  const store = session?.runsStore;
  const version = useSyncExternalStore(store?.subscribe ?? NO_SUBSCRIBE, () => (store ? reader.version(store) : 0));
  return session ? reader.wrap(session, version) : null;
}

function useSessionState() {
  const [client, setClient] = useState<Client | null>(null);
  const [recent, setRecent] = useState<RecentProject[]>([]);
  // The computer whose Projects list `recent` holds, once it has answered: an empty list before that is not "no Projects".
  const listedFor = useRef<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [runsStore] = useState(() => new RunsStore());
  // The snapshot last put on screen, which a runs read lands on and the next whole read reconciles with.
  const latest = useRef<Snapshot | null>(null);
  /** Every snapshot goes on screen here, so its runs and the runs read apart stay ordered. */
  const putSnapshot = useCallback(
    (next: Snapshot | null) => {
      latest.current = next;
      if (next) runsStore.confirm(next);
      else runsStore.clear();
      setSnapshot(next);
    },
    [runsStore],
  );
  const designs = useDesigns(client, snapshot?.project.path, recent[0]?.path);
  const [error, setError] = useState("");
  // How many times the connection came back after an error: the Chat on screen reads its pages again on each.
  const [reconnects, setReconnects] = useState(0);
  const lost = useRef(false);
  useEffect(() => {
    if (error) lost.current = true;
  }, [error]);
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
  // The Project the live snapshot is for: its cached copy is the live one, which a list read must not replace.
  const liveKey = useRef<string | null>(null);
  // Keep streamed status and local refreshes in the copy a remounted drawer will read.
  useEffect(() => {
    if (client && snapshot) {
      const key = `${client.url}|${snapshot.project.path}`;
      seen.current.set(key, snapshot);
      listed.current.set(key, snapshot);
      liveKey.current = key;
    } else liveKey.current = null;
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
      // A busy Mac (429) answers these on a later try; the error shows only once a minute of tries gives up.
      const read = <T,>(command: string) =>
        retrySend(() => client.call<T>(command, args), { retryable: (error) => current() && retryKind(error) !== null, budget: READ_RETRY_BUDGET });
      const [models, status] = await Promise.all([read<AgentModels>("agent:models"), read<AgentCliStatus>("agent:cli-status")]);
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
  const connect = async (host: HostLink, remember = true, target?: { projectPath: string; onOpen: (state: Snapshot) => void }) => {
    const next = createClient(host, undefined, undefined, relayRuntime);
    const name = host.name || "";
    const current = ++generation.current;
    const previous = selection.current;
    try {
      await next.call("daemon:status");
      const projects = await savedProjectOrder.apply(next.url, await savedHiddenProjects.apply(next.url, await next.recentScopes()));
      if (current !== generation.current) return false;
      // A draft changing computers keeps its current page until the destination is ready. Commit its route and
      // Project together, without clearing the snapshot (which would unmount the composer and dismiss the keyboard).
      const state = target ? await next.open(target.projectPath) : null;
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
      if (state && target) target.onOpen(state);
      if (process.env.EXPO_PUBLIC_DEMO !== "1") void learnRoutes(next, { token: host.token.trim(), relay: host.relay }).catch(() => {});
      setModels(null);
      setCliStatus(null);
      setProviderError("");
      autoOpen.current = false;
      selection.current = state ? { client: next, path: state.project.path } : null;
      if (state && target) seen.current.set(`${next.url}|${target.projectPath}`, state).set(`${next.url}|${state.project.path}`, state);
      setOpening(null);
      setClient(next);
      listedFor.current = next.url;
      setRecent(projects);
      putSnapshot(state);
      setError("");
      setHostName(name || hosts.find((saved) => saved.id === next.url)?.name || hostOf(next.url));
      return true;
    } catch (error) {
      if (current === generation.current) selection.current = previous;
      throw error;
    }
  };
  /** Adopt a previously opened Chat before routing, without waiting for its computer. Summaries aren't full snapshots. */
  const openCachedChat = (projectPath: string, sessionId: number, host?: SavedHost): Client | null => {
    const next = host ? createClient(host, undefined, undefined, relayRuntime) : client;
    if (!next) return null;
    const sameProject = next === client && latest.current?.project.path === projectPath;
    const cached = sameProject ? latest.current : seen.current.get(`${next.url}|${projectPath}`);
    if (!cached?.project.state.sessions[sessionId]) return null;
    if (sameProject && selection.current?.client === next && selection.current.path === projectPath) {
      if (cached.project.state.messagesInChats) prefetchChatPage(next, projectPath, sessionId);
      return next;
    }
    autoOpen.current = false;
    generation.current++;
    const selected = { client: next, path: cached.project.path };
    selection.current = selected;
    setOpening(null);
    if (next !== client) {
      setModels(null);
      setCliStatus(null);
      setProviderError("");
      setClient(next);
      listedFor.current = null;
      setRecent([]);
      setHostName(host!.name);
    }
    putSnapshot(cached);
    setError("");
    const opened = next.open(projectPath);
    noteChatProjectOpening(next, projectPath, opened);
    if (cached.project.state.messagesInChats) prefetchChatPage(next, projectPath, sessionId);
    // The route handoff cancels pending navigation; this selection is already committed. Guard background reads by
    // selection instead, and don't replace a newer live snapshot with the answer to this earlier open.
    void opened
      .then((state) => {
        if (selection.current !== selected || latest.current !== cached) return;
        seen.current.set(`${next.url}|${projectPath}`, state).set(`${next.url}|${state.project.path}`, state);
        putSnapshot(reconcileState(cached, state));
        setError(state.project.state.sessions[sessionId] ? "" : "This Chat is no longer available on your computer.");
        return undefined;
      })
      .catch((cause) => {
        if (selection.current === selected && latest.current === cached) setError(cause instanceof Error ? cause.message : String(cause));
      });
    if (host) {
      void next
        .recentScopes()
        .then(async (projects) => savedProjectOrder.apply(next.url, await savedHiddenProjects.apply(next.url, projects)))
        .then((projects) => {
          if (selection.current !== selected) return;
          listedFor.current = next.url;
          setRecent(projects);
          return undefined;
        })
        .catch(() => {});
    }
    return next;
  };
  const openNotificationTarget = async (host: SavedHost, projectPath: string, sessionId: number) => {
    autoOpen.current = false;
    const current = ++generation.current;
    const next = createClient(host, undefined, undefined, relayRuntime);
    try {
      await next.call("daemon:status");
      if (current !== generation.current) return false;
      if (process.env.EXPO_PUBLIC_DEMO !== "1") void learnRoutes(next, { token: host.token, relay: host.relay }).catch(() => {});
      const projects = await savedProjectOrder.apply(next.url, await savedHiddenProjects.apply(next.url, await next.recentScopes()));
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
      putSnapshot(state);
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
  const open = async (projectPath: string, options: { background?: boolean; chatId?: number; onOpen?: (state: Snapshot) => void } = {}) => {
    if (!client) throw new Error("Connect to your computer first.");
    const current = ++generation.current;
    const previous = selection.current;
    if (!options.background) selection.current = null;
    const cached = seen.current.get(`${client.url}|${projectPath}`);
    if (!options.background) {
      setOpening({ path: projectPath, cached: !!cached });
      if (cached) putSnapshot(cached);
    }
    try {
      const state = await client.open(projectPath);
      const project = state.project;
      if (current === generation.current) {
        if (options.chatId !== undefined && !state.project.state.sessions[options.chatId])
          throw new Error("This Chat is no longer available. Choose another Chat.");
        options.onOpen?.(state);
        selection.current = { client, path: project.path };
        seen.current.set(`${client.url}|${projectPath}`, state).set(`${client.url}|${project.path}`, state);
        putSnapshot(reconcileState(latest.current ?? undefined, state));
        setError("");
        // The Chats home is opened like a Project but never listed as one (the drawer's Chats group holds its Chats).
        setRecent((previous) =>
          previous.some((item) => item.path === project.path) || isChatsHomeProject(project)
            ? previous
            : [
                ...previous,
                {
                  path: project.path,
                  name: project.name,
                  ...(savedHiddenProjects.hidden(client.url).has(project.path) ? { hidden: true } : {}),
                  ...(project.link ? { link: project.link.link, projects: project.link.projects } : {}),
                },
              ],
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
  // The sidebar's own reads of this computer's Projects warm opening them, as previewProject does, without a second request.
  const seedPreview = useCallback(
    (source: Pick<Client, "url">, path: string, copy: Snapshot | ProjectPreview) => {
      if (!client || source !== client) return;
      const key = `${client.url}|${path}`;
      const canonicalKey = `${client.url}|${copy.project.path}`;
      if (key === liveKey.current || canonicalKey === liveKey.current) return;
      listed.current.set(key, copy).set(canonicalKey, copy);
      if (!copy.previewOnly) seen.current.set(key, copy).set(canonicalKey, copy);
    },
    [client],
  );
  const reloadProjects = useCallback(async () => {
    if (!client) return;
    const current = generation.current;
    const projects = await savedHiddenProjects.apply(client.url, await client.recentScopes());
    // Opening a Chat opens its Project, which moves it to the top of the host's recent list; rows keep their place.
    if (current === generation.current) {
      listedFor.current = client.url;
      setRecent((previous) => keepOrder(previous, projects, (item) => item.path));
    }
  }, [client]);
  const forgetProject = async (path: string) => {
    if (!client) throw new Error("Connect to your computer first.");
    const removingGeneration = generation.current;
    await client.call("project:forget", [path]);
    const sameNavigation = generation.current === removingGeneration;
    // Invalidate an in-flight open before it can put the removed Project back on screen.
    if (sameNavigation && (selection.current?.path === path || snapshot?.project.path === path || opening?.path === path)) {
      generation.current++;
      selection.current = null;
      setSnapshot(null);
      setOpening(null);
    }
    const completionGeneration = generation.current;
    setLastLocation((current) => (current?.hostId === client.url && current.projectPath === path ? null : current));
    await savedNavigation.forgetProject(client.url, path);
    seen.current.delete(`${client.url}|${path}`);
    listed.current.delete(`${client.url}|${path}`);
    // A removed Project's saved location/cache belongs to its computer; the visible list and navigation belong to
    // the current selection. Neither an RPC nor a keychain write may replace a newer computer or Chat.
    if (!sameNavigation || generation.current !== completionGeneration) return false;
    setRecent((previous) => previous.filter((item) => item.path !== path));
    void reloadProjects().catch(() => {});
    return true;
  };
  const setProjectHidden = useCallback(
    async (path: string, hidden: boolean) => {
      setRecent((previous) =>
        previous.map((item) => {
          if (item.path !== path) return item;
          const { hidden: _hidden, ...rest } = item;
          return hidden ? { ...rest, hidden: true } : rest;
        }),
      );
      if (client && process.env.EXPO_PUBLIC_DEMO !== "1") await savedHiddenProjects.setHidden(client.url, path, hidden);
    },
    [client],
  );
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
        putSnapshot(reconcileState(latest.current ?? undefined, state));
        setError("");
        if (lost.current) {
          lost.current = false;
          setReconnects((count) => count + 1);
        }
      }
    } catch (error) {
      if (current === selection.current) throw error;
    }
  }, [client, projectPath, putSnapshot]);
  /** Fetches only the Project's streaming turns: they go to the runs store, and the snapshot on screen stays as it is. */
  const refreshRuns = useCallback(async () => {
    const current = selection.current;
    if (!client || !projectPath || current?.client !== client || current.path !== projectPath) return;
    try {
      const runs = await client.runs(projectPath);
      const shown = latest.current;
      // A snapshot that landed meanwhile may already hold later runs (the store compares their seq).
      if (current === selection.current && shown?.project.path === projectPath) {
        const key = `${client.url}|${projectPath}`;
        if (runsStore.update(key, shown, runs)) {
          // Reopening the Project, or a list's read of it, starts from these runs, as it did when they were in the snapshot.
          const copy = { ...shown, runs: runsStore.runsFor(key, shown) };
          seen.current.set(key, copy);
          if (liveKey.current === key) listed.current.set(key, copy);
        }
        setError("");
      }
    } catch (error) {
      if (current === selection.current) throw error;
    }
  }, [client, projectPath, runsStore]);
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
      pulls: () => pullRequestsChanged(client),
      liveStatus: designsConnectionChanged,
      onError: (error) => setError(error.message),
      active: () => AppState.currentState === "active",
      watchActive: (listener) => {
        const subscription = AppState.addEventListener("change", (state) => listener(state === "active"));
        return () => subscription.remove();
      },
      // Live turns refresh every second; an idle Project only needs a slower check for changes made elsewhere.
      pollDelay: () => {
        const shown = latest.current;
        const running = !!shown && Object.keys(runsStore.runsFor(`${client.url}|${shown.project.path}`, shown).runs).length > 0;
        return running || Date.now() < busyUntil.current ? 1000 : 4000;
      },
    });
  }, [client, projectPath, refresh, refreshRuns, refreshProviders, refreshDesigns, designsConnectionChanged, runsStore]);
  const selected = selection.current;
  const isSelected = () => selected !== null && selection.current === selected;
  const disconnect = () => {
    autoOpen.current = false;
    generation.current++;
    selection.current = null;
    setClient(null);
    putSnapshot(null);
    setError("");
  };
  return {
    booted,
    lastLocation,
    rememberChat,
    cachedProject,
    previewProject,
    seedPreview,
    reloadProjects,
    forgetProject,
    setProjectHidden,
    claimAutoOpen,
    opening,
    hosts,
    loadHosts,
    hostName,
    expectActivity,
    client,
    designs,
    recent,
    recentLoaded: !!client && listedFor.current === client.url,
    /** The Project state the computer last sent whole; its streaming turns live in `runsStore` (useRun). */
    snapshot,
    runsStore,
    error,
    reconnects,
    setError,
    models,
    cliStatus,
    providerError,
    refreshProviders,
    providerRevision,
    connect,
    open,
    openCachedChat,
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
  /** The New Chat screen's draft id (pending-chats.ts), so the drawer reopens that screen. */
  draft?: string;
  originSessionId: number | null;
  worktreeId: number;
  newWorktree: boolean;
  accepted: boolean;
  promoted?: boolean;
  /** The provider the send went to, which the agent starting is named after. */
  provider?: ModelProvider;
};
type PendingChats = {
  pendingChats: Record<string, MobilePendingChat>;
  setPendingChats: React.Dispatch<React.SetStateAction<Record<string, MobilePendingChat>>>;
};
const PendingChatsContext = createContext<PendingChats | null>(null);
/** The previews of sends the computer took that `snapshot`, of `hostId`, now holds itself: they can go. */
function caughtUp(pendingChats: Record<string, MobilePendingChat>, snapshot: Snapshot | null, hostId?: string) {
  return snapshot
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
}
const without = (keys: string[]) => (current: Record<string, MobilePendingChat>) =>
  Object.fromEntries(Object.entries(current).filter(([key]) => !keys.includes(key)));
function PendingChatsProvider({ children, snapshot, hostId }: { children: React.ReactNode; snapshot: Snapshot | null; hostId?: string }) {
  const [pendingChats, setPendingChats] = useState<Record<string, MobilePendingChat>>({});
  // Retire acknowledged previews as the live snapshot catches up, before children render the new state.
  const accepted = caughtUp(pendingChats, snapshot, hostId);
  if (accepted.length) setPendingChats(without(accepted));
  const value = useMemo(() => ({ pendingChats, setPendingChats }), [pendingChats]);
  return <PendingChatsContext.Provider value={value}>{children}</PendingChatsContext.Provider>;
}
/** Retires previews as another Project's snapshot catches up, as the provider does for the open one (the Chat beside it). */
export function useRetireCaughtUp(snapshot: Snapshot | null, hostId?: string) {
  const { pendingChats, setPendingChats } = usePendingChats();
  const accepted = caughtUp(pendingChats, snapshot, hostId);
  const key = accepted.join("\n");
  useEffect(() => {
    if (key) setPendingChats(without(key.split("\n")));
  }, [key, setPendingChats]);
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
export type Session = ReturnType<typeof useSessionState>;
const SessionContext = createContext<Session | null>(null);
/** A Chat of another Project or computer than the open one (the Chat beside it) reads its own Project's session here. */
const ScopedSessionContext = createContext<Session | null>(null);
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
/** The connection and Project this screen works with: the open one, or the one a SessionScope above it names. */
export function useSession() {
  const scoped = useContext(ScopedSessionContext);
  const session = useLiveRuns(useContext(SessionContext));
  const own = useLiveRuns(scoped);
  if (!session) throw new Error("SessionProvider is required");
  return own ?? session;
}
/** The open computer and Project, whatever SessionScope is above. */
export function useMainSession() {
  const session = useLiveRuns(useContext(SessionContext));
  if (!session) throw new Error("SessionProvider is required");
  return session;
}
/** The session useSession reads, without subscribing to its runs. */
function useSessionContext() {
  const scoped = useContext(ScopedSessionContext);
  const session = useContext(SessionContext);
  if (!session) throw new Error("SessionProvider is required");
  return scoped ?? session;
}
/** The streaming turn of one Chat ("path#id"), if any; re-renders only as that turn changes. */
export function useRun(chatKey: string | null | undefined): AgentRun | undefined {
  const session = useSessionContext();
  return useSyncExternalStore(session.runsStore.subscribe, () => (chatKey ? runsOf(session)?.runs[chatKey] : undefined));
}
/** What a Chat list reads of a turn: that it runs, and whether it waits on an approval or a question. */
const listShape = (runs: Runs) =>
  Object.entries(runs.runs)
    .map(([key, run]) => `${key}:${run.approvals.length}:${run.questions.length}`)
    .join("\n");
class ListRuns {
  private last: { shape: string; runs: Runs } | null = null;
  pick(runs: Runs | undefined) {
    if (!runs) return undefined;
    const shape = listShape(runs);
    if (this.last?.shape !== shape) this.last = { shape, runs };
    return this.last.runs;
  }
}
/**
 * This screen's Project with its runs as a Chat list reads them: they change as a turn starts, asks or ends, not with
 * every step it streams, so a list re-renders only for what its rows show.
 */
export function useListSnapshot(): Snapshot | null {
  const session = useSessionContext();
  const [reader] = useState(() => new ListRuns());
  const runs = useSyncExternalStore(session.runsStore.subscribe, () => reader.pick(runsOf(session)));
  const base = session.snapshot;
  return useMemo(() => (base && runs && runs !== base.runs ? { ...base, runs } : base), [base, runs]);
}
/** Everything under it reads `session` from useSession instead of the open one; null leaves the open one. */
export function SessionScope({ session, children }: { session: Session | null; children: React.ReactNode }) {
  return <ScopedSessionContext.Provider value={session}>{children}</ScopedSessionContext.Provider>;
}
