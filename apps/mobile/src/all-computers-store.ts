import type { ChatsHome } from "@milagre/shared/chats-home";
import type { Client, OpenProject, ProjectPreview, RecentProject, Snapshot } from "./client";
import type { SavedHost } from "./hosts-store";
import { PROJECTS_EVERY, REQUESTS_AT_ONCE, createLimiter, nextDelay } from "./all-computers-schedule.ts";

export type Reach = "online" | "checking" | "offline";
export type ProjectCopy = Snapshot | ProjectPreview;
export type StoreClient = Pick<Client, "url" | "call" | "recentScopes" | "preview" | "open" | "chatLists"> &
  Partial<Pick<Client, "retire" | "chatsHome" | "chatMessages">>;
export type RecentChat = { projectPath: string; chatId: number; lastAt: number; lastId: number };

export type HostView = {
  hostId: string;
  name: string;
  state: Reach;
  lastSuccess: number;
  loaded: boolean;
  projects: RecentProject[];
  copies: ReadonlyMap<string, ProjectCopy>;
  errors: ReadonlyMap<string, string>;
  home?: ChatsHome | null;
};

export type CurrentHost = {
  hostId: string;
  client: StoreClient;
  projects: RecentProject[] | undefined;
  reload: () => Promise<void>;
  seed?: (client: StoreClient, path: string, copy: ProjectCopy) => void;
};

export type ViewPolicy = { visible: boolean; expandAll: boolean; isFolded: (hostId: string, path: string) => boolean };

export type StoreDeps = {
  createClient: (host: SavedHost) => StoreClient;
  applyProjects: (hostId: string, projects: RecentProject[]) => Promise<RecentProject[]>;
  now: () => number;
  random: () => number;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  warm?: (client: StoreClient, chats: RecentChat[], limit: <T>(work: () => Promise<T>) => Promise<T>) => Promise<void>;
};

export function recentChats(copies: ReadonlyMap<string, ProjectCopy>): RecentChat[] {
  const chats: RecentChat[] = [];
  for (const copy of copies.values())
    for (const session of Object.values(copy.project.state.sessions ?? {})) {
      const { lastAt, lastId } = session.summary ?? {};
      if (!session.archived && session.id > 0 && lastAt && lastId) chats.push({ projectPath: copy.project.path, chatId: session.id, lastAt, lastId });
    }
  return chats;
}

const BATCH = 20;
const OPEN_FIRST = /open the project before reading/i;
const LINK_ERROR = /chats of a link are not listed/i;
const STUCK_FOR = 5 * 60 * 1000;
const STALE = new Error("This computer was replaced.");
const SKIPPED = new Error("This computer is not answering.");
const isLink = (path: string) => path.startsWith("milagre-link:");
const credentials = (host: SavedHost) =>
  JSON.stringify([host.token, host.address, host.relay?.hostId, host.relay?.key, host.relay?.url, host.relay?.direct, host.access?.id, host.access?.secret]);
const deterministic = (error: unknown) => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;
};

type Entry = {
  id: string;
  host: SavedHost;
  credentials: string;
  client: StoreClient;
  shared: boolean;
  reload?: () => Promise<void>;
  seed?: CurrentHost["seed"];
  limiter: ReturnType<typeof createLimiter>;
  name: string;
  state: Reach;
  lastSuccess: number;
  loaded: boolean;
  projects: RecentProject[];
  copies: Map<string, ProjectCopy>;
  errors: Map<string, string>;
  home: ChatsHome | null | undefined;
  askingHome: boolean;
  canonical: Map<string, string>;
  stuck: Map<string, number>;
  noBatch: boolean;
  projectsAt: number;
  failures: number;
  running: Promise<void> | null;
  again: boolean;
  timer: unknown;
  version: number;
  view: HostView;
};

export function createAllComputersStore(deps: StoreDeps) {
  const entries = new Map<string, Entry>();
  const limiters = new Map<string, ReturnType<typeof createLimiter>>();
  let order: string[] = [];
  const consumers = new Set<{ policy: ViewPolicy }>();
  let foreground = true;
  // Counts the app's trips out of the foreground: iOS closes its sockets there, so a read on its way when the app left
  let departures = 0;
  let expandAll = false;
  let isFolded: (hostId: string, path: string) => boolean = () => false;
  const listeners = new Set<() => void>();
  let key = "";
  let views: HostView[] = [];

  const active = () => foreground && [...consumers].some((consumer) => consumer.policy.visible);
  function effective() {
    const all = [...consumers].map((consumer) => consumer.policy);
    const shown = all.filter((policy) => policy.visible);
    const used = shown.length ? shown : all;
    expandAll = used.some((policy) => policy.expandAll);
    isFolded = used.length ? (hostId, path) => used.every((policy) => policy.isFolded(hostId, path)) : () => false;
  }
  const alive = (entry: Entry, client: StoreClient) => entries.get(entry.id) === entry && entry.client === client;
  const buildView = (entry: Entry): HostView => ({
    hostId: entry.id,
    name: entry.name,
    state: entry.state,
    get lastSuccess() {
      return entry.lastSuccess;
    },
    loaded: entry.loaded,
    projects: entry.projects,
    copies: entry.copies,
    errors: entry.errors,
    ...(entry.home !== undefined ? { home: entry.home } : {}),
  });
  function publish(entry?: Entry) {
    if (entry) {
      const previous = entry.view;
      if (entry.copies !== previous.copies) {
        const copies = new Map(entry.copies);
        for (const [path, copy] of copies) {
          const held = previous.copies.get(path);
          if (held && (held === copy || JSON.stringify(held) === JSON.stringify(copy))) copies.set(path, held);
        }
        entry.copies =
          copies.size === previous.copies.size && [...copies].every(([path, copy]) => previous.copies.get(path) === copy)
            ? (previous.copies as Map<string, ProjectCopy>)
            : copies;
      }
      if (entry.projects !== previous.projects && JSON.stringify(entry.projects) === JSON.stringify(previous.projects)) entry.projects = previous.projects;
      const sameErrors = entry.errors.size === previous.errors.size && [...entry.errors].every(([path, error]) => previous.errors.get(path) === error);
      if (sameErrors) entry.errors = previous.errors as Map<string, string>;
      if (
        entry.name === previous.name &&
        entry.state === previous.state &&
        entry.loaded === previous.loaded &&
        entry.projects === previous.projects &&
        entry.copies === previous.copies &&
        sameErrors &&
        JSON.stringify(entry.home) === JSON.stringify(previous.home)
      )
        return;
      entry.version++;
      entry.view = buildView(entry);
    }
    const present = order.flatMap((id) => entries.get(id) ?? []);
    const nextKey = present.map((item) => `${item.id}:${item.version}`).join(",");
    if (nextKey === key && present.every((item, index) => item.view === views[index])) return;
    key = nextKey;
    views = present.map((item) => item.view);
    listeners.forEach((listener) => listener());
  }
  function dispose(entry: Entry) {
    if (entry.timer !== null) deps.clearTimer(entry.timer);
    entry.timer = null;
  }
  function limiterFor(id: string) {
    let limiter = limiters.get(id);
    if (!limiter) {
      limiter = createLimiter(REQUESTS_AT_ONCE);
      limiters.set(id, limiter);
    }
    return limiter;
  }
  function retire(entry: Entry) {
    dispose(entry);
    if (!entry.shared) entry.client.retire?.();
  }
  function seedSession(entry: Entry, client: StoreClient, path: string, copy: ProjectCopy) {
    if (entry.shared && alive(entry, client)) entry.seed?.(client, path, copy);
  }
  function prune(entry: Entry) {
    if (!entry.loaded) return;
    const known = new Set(entry.projects.map((item) => item.path));
    if (entry.home?.exists) known.add(entry.home.path);
    let changed = false;
    const copies = new Map(entry.copies);
    const errors = new Map(entry.errors);
    for (const path of entry.copies.keys()) if (!known.has(path)) if (copies.delete(path)) changed = true;
    for (const path of entry.errors.keys()) if (!known.has(path)) if (errors.delete(path)) changed = true;
    for (const path of entry.canonical.keys()) if (!known.has(path)) entry.canonical.delete(path);
    for (const path of entry.stuck.keys()) if (!known.has(path)) entry.stuck.delete(path);
    if (changed) {
      entry.copies = copies;
      entry.errors = errors;
    }
  }

  function guarded<T>(entry: Entry, client: StoreClient, weight: number, work: () => Promise<T>, skip?: () => boolean): Promise<T> {
    return entry.limiter
      .run(weight, async () => {
        if (!alive(entry, client)) throw STALE;
        if (skip?.()) throw SKIPPED;
        return work();
      })
      .then((value) => {
        if (!alive(entry, client)) throw STALE;
        return value;
      });
  }

  function wanted(entry: Entry): string[] {
    const paths = entry.projects
      .filter((item) => !item.hidden && item.path && (entry.stuck.get(item.path) ?? 0) <= deps.now() && (expandAll || !isFolded(entry.id, item.path)))
      .map((item) => item.path);
    const home = entry.home?.exists ? entry.home.path : "";
    return home && !paths.includes(home) && (entry.stuck.get(home) ?? 0) <= deps.now() ? [...paths, home] : paths;
  }
  const openFor = (entry: Entry, client: StoreClient, path: string) =>
    path === entry.home?.path ? client.call<OpenProject>("chats:ensure", []) : client.call<OpenProject>("project:open", [path]);
  async function askHome(entry: Entry, client: StoreClient, idle: () => boolean) {
    const chatsHome = client.chatsHome;
    if (!chatsHome) {
      if (entry.home === undefined && keepHome(entry, null)) publish(entry);
      return;
    }
    if (entry.askingHome) return;
    entry.askingHome = true;
    let found: ChatsHome | null;
    try {
      found = await guarded(entry, client, 1, () => chatsHome(), idle);
    } catch {
      return;
    } finally {
      entry.askingHome = false;
    }
    if (!keepHome(entry, found)) return;
    publish(entry);
    if (found?.exists && active()) void cycle(entry);
  }
  function keepHome(entry: Entry, home: ChatsHome | null) {
    if (entry.home === home || (entry.home && home && entry.home.path === home.path && entry.home.exists === home.exists)) return false;
    entry.home = home;
    prune(entry);
    return true;
  }

  async function previewOne(
    entry: Entry,
    client: StoreClient,
    path: string,
    run: <T>(weight: number, work: () => Promise<T>) => Promise<T>,
  ): Promise<ProjectCopy> {
    if (isLink(path)) return run(1, () => client.open(path));
    let canonical = entry.canonical.get(path);
    if (!canonical) {
      const opened = await run(1, () => openFor(entry, client, path));
      canonical = opened.path;
      entry.canonical.set(path, canonical);
    }
    return run(1, () => client.preview(canonical!));
  }

  function cycle(entry: Entry, force = false): Promise<void> {
    if (force) entry.projectsAt = 0;
    if (entry.running) {
      entry.again = true;
      return entry.running;
    }
    dispose(entry);
    const client = entry.client;
    const idle = () => !force && !active();
    const run = (async () => {
      let succeeded = 0;
      let failed = 0;
      const departed = departures;
      const dead = () => succeeded === 0 && failed >= 2;
      const skipped = () => dead() || idle();
      const tracked = async <T>(weight: number, work: () => Promise<T>): Promise<T> => {
        try {
          const value = await guarded(entry, client, weight, work, skipped);
          succeeded++;
          return value;
        } catch (error) {
          if (error === STALE || error === SKIPPED) throw error;
          if (departed !== departures) throw SKIPPED;
          failed++;
          throw error;
        }
      };
      try {
        const listDue = force || !entry.projectsAt || deps.now() - entry.projectsAt >= PROJECTS_EVERY;
        if (listDue) {
          try {
            if (entry.shared) {
              if (entry.reload) await tracked(3, entry.reload);
            } else {
              const list = await tracked(3, () => client.recentScopes());
              const applied = await deps.applyProjects(entry.id, list);
              if (!alive(entry, client)) throw STALE;
              entry.projects = applied;
              entry.loaded = true;
              prune(entry);
              publish(entry);
            }
            entry.projectsAt = deps.now();
          } catch (error) {
            if (error === STALE) return;
          }
        }
        if (listDue || entry.home === undefined) void askHome(entry, client, idle);
        const paths = wanted(entry);
        const updates = new Map<string, ProjectCopy>();
        const cleared = new Set<string>();
        const failedPaths = new Map<string, string>();
        const flush = () => {
          if (!alive(entry, client) || (!updates.size && !cleared.size && !failedPaths.size)) return;
          if (updates.size) entry.copies = new Map([...entry.copies, ...updates]);
          const errors = new Map(entry.errors);
          for (const path of cleared) errors.delete(path);
          for (const [path, message] of failedPaths) errors.set(path, message);
          if (errors.size !== entry.errors.size || [...errors].some(([path, message]) => entry.errors.get(path) !== message)) entry.errors = errors;
          updates.clear();
          cleared.clear();
          failedPaths.clear();
          publish(entry);
        };
        const cool = (path: string) => entry.stuck.set(path, deps.now() + STUCK_FOR);
        const accept = (path: string, copy: ProjectCopy) => {
          cleared.add(path);
          if (entry.copies.get(path) !== copy) updates.set(path, copy);
          seedSession(entry, client, path, copy);
        };
        const single = paths.filter((path) => isLink(path) || entry.noBatch || !client.chatLists);
        const batched = paths.filter((path) => !single.includes(path));
        const readBatch = async (chunk: string[], mayOpen: boolean): Promise<void> => {
          const answer = await tracked(1, () => client.chatLists(chunk));
          const unopened: string[] = [];
          for (const path of chunk) {
            const found = answer[path];
            if (found && !("error" in found)) accept(path, found);
            else if (!found || LINK_ERROR.test(found.error)) single.push(path);
            else if (OPEN_FIRST.test(found.error) && mayOpen && !entry.canonical.has(path)) unopened.push(path);
            else {
              cool(path);
              failedPaths.set(path, found.error);
            }
          }
          if (!unopened.length) return;
          await Promise.all(
            unopened.map(async (path) => {
              try {
                const opened = await tracked(1, () => openFor(entry, client, path));
                entry.canonical.set(path, opened.path);
              } catch (error) {
                if (error !== STALE && error !== SKIPPED) {
                  if (deterministic(error)) cool(path);
                  failedPaths.set(path, (error as Error).message);
                }
              }
            }),
          );
          const again = unopened.filter((path) => entry.canonical.has(path));
          if (again.length) await readBatch(again, false);
        };
        for (let start = 0; start < batched.length && !idle(); start += BATCH) {
          const chunk = batched.slice(start, start + BATCH);
          try {
            await readBatch(chunk, true);
          } catch (error) {
            if (error === STALE) return;
            if ((error as { code?: string })?.code === "unsupported") {
              entry.noBatch = true;
              single.push(...chunk);
            } else if (error !== SKIPPED) for (const path of chunk) failedPaths.set(path, (error as Error).message);
          }
        }
        flush();
        await Promise.all(
          single.map(async (path) => {
            try {
              accept(path, await previewOne(entry, client, path, tracked));
            } catch (error) {
              if (error !== STALE && error !== SKIPPED) {
                if (deterministic(error)) cool(path);
                failedPaths.set(path, (error as Error).message);
              }
            }
            flush();
          }),
        );
        if (!alive(entry, client)) return;
        flush();
        const cutOff = departed !== departures && succeeded === 0;
        if (!cutOff && failed > 0 && succeeded === 0) {
          entry.failures++;
          entry.state = entry.failures >= (entry.lastSuccess ? 2 : 1) ? "offline" : entry.state === "online" ? "online" : "checking";
        } else if (!cutOff && (succeeded > 0 || entry.shared || entry.state === "checking")) {
          entry.failures = 0;
          entry.state = "online";
          entry.lastSuccess = deps.now();
        }
        publish(entry);
        if (deps.warm && entry.state === "online" && !idle())
          void deps.warm(client, recentChats(entry.copies), (work) => guarded(entry, client, 1, work, skipped)).catch(() => {});
      } finally {
        entry.running = null;
        if (alive(entry, client)) {
          if (entry.again && active()) {
            entry.again = false;
            void cycle(entry);
          } else schedule(entry);
        }
      }
    })();
    entry.running = run;
    return run;
  }

  function schedule(entry: Entry) {
    dispose(entry);
    if (!active() || entries.get(entry.id) !== entry || entry.running) return;
    entry.timer = deps.setTimer(
      () => {
        entry.timer = null;
        void cycle(entry);
      },
      nextDelay({ current: entry.shared, failures: entry.failures, random: deps.random }),
    );
  }

  function reconcile() {
    for (const entry of entries.values()) {
      if (active()) {
        if (!entry.running && entry.timer === null) void cycle(entry);
      } else dispose(entry);
    }
  }

  function register(policy: ViewPolicy) {
    const consumer = { policy };
    consumers.add(consumer);
    const before = expandAll;
    effective();
    reconcile();
    if (expandAll && !before && active()) for (const entry of entries.values()) void cycle(entry);
    let released = false;
    return {
      update(next: ViewPolicy) {
        if (released || next === consumer.policy) return;
        const wasExpanded = expandAll;
        consumer.policy = next;
        effective();
        if (!active()) return reconcile();
        const grew = expandAll && !wasExpanded;
        for (const entry of entries.values()) if (grew || !entry.running) void cycle(entry);
      },
      release() {
        if (released) return;
        released = true;
        consumers.delete(consumer);
        effective();
        reconcile();
      },
    };
  }

  function makeEntry(host: SavedHost, client: StoreClient, shared: boolean, inherit?: Entry, previousVersion = 0): Entry {
    const entry: Entry = {
      id: host.id,
      host,
      credentials: credentials(host),
      client,
      shared,
      limiter: limiterFor(host.id),
      name: host.name,
      state: inherit?.state === "offline" ? "checking" : (inherit?.state ?? "checking"),
      lastSuccess: inherit?.lastSuccess ?? 0,
      loaded: inherit?.loaded ?? false,
      projects: inherit?.projects ?? [],
      copies: inherit?.copies ?? new Map(),
      errors: new Map(),
      home: inherit?.home,
      askingHome: false,
      canonical: inherit?.canonical ?? new Map(),
      stuck: new Map(),
      noBatch: false,
      projectsAt: inherit?.projectsAt ?? 0,
      failures: 0,
      running: null,
      again: false,
      timer: null,
      version: (inherit?.version ?? previousVersion) + 1,
      view: undefined as unknown as HostView,
    };
    entry.view = buildView(entry);
    return entry;
  }

  return {
    sync(hosts: SavedHost[], current: CurrentHost | null) {
      const listed = hosts.filter((host) => !host.hidden);
      order = listed.map((host) => host.id);
      let changed = false;
      for (const [id, entry] of entries) {
        if (listed.some((host) => host.id === id)) continue;
        retire(entry);
        entries.delete(id);
        changed = true;
      }
      for (const [id, limiter] of limiters) if (!entries.has(id) && !limiter.inFlight && !limiter.queued) limiters.delete(id);
      for (const host of listed) {
        const existing = entries.get(host.id);
        const shared = current?.hostId === host.id;
        const same = existing && existing.credentials === credentials(host) && existing.shared === shared;
        const client = shared ? current.client : same ? existing.client : deps.createClient(host);
        if (existing && same && existing.client === client) {
          existing.host = host;
          let touched = false;
          if (existing.name !== host.name) {
            existing.name = host.name;
            touched = true;
          }
          if (shared) {
            existing.reload = current.reload;
            existing.seed = current.seed;
            if (current.projects !== undefined && (existing.projects !== current.projects || !existing.loaded)) {
              existing.projects = current.projects;
              existing.loaded = true;
              prune(existing);
              touched = true;
            }
          }
          if (touched) publish(existing);
          continue;
        }
        if (existing) retire(existing);
        const entry = makeEntry(host, client, shared, existing?.credentials === credentials(host) ? existing : undefined, existing?.version);
        if (shared) {
          entry.reload = current.reload;
          entry.seed = current.seed;
          if (current.projects !== undefined) {
            entry.projects = current.projects;
            entry.loaded = true;
            entry.projectsAt = deps.now();
            prune(entry);
          } else entry.projectsAt = 0;
          entry.view = buildView(entry);
        }
        entries.set(host.id, entry);
        changed = true;
      }
      publish();
      if (changed) reconcile();
    },
    register,
    show: () => register({ visible: true, expandAll: false, isFolded: () => false }).release,
    setForeground(next: boolean) {
      if (foreground === next) return;
      foreground = next;
      if (!next) departures++;
      reconcile();
    },
    refreshAll(): Promise<void> {
      return Promise.all([...entries.values()].map((entry) => cycle(entry, true))).then(() => undefined);
    },
    refreshHosts(ids: string[]): Promise<void> {
      return Promise.all(ids.map((id) => entries.get(id)).flatMap((entry) => (entry ? [cycle(entry, true)] : []))).then(() => undefined);
    },
    setProjectHidden(hostId: string, path: string, hidden: boolean) {
      const entry = entries.get(hostId);
      if (!entry || !entry.projects.some((item) => item.path === path && !!item.hidden !== hidden)) return;
      entry.projects = entry.projects.map((item) => {
        if (item.path !== path) return item;
        const { hidden: _hidden, ...rest } = item;
        return hidden ? { ...rest, hidden: true } : rest;
      });
      publish(entry);
    },
    setHome(hostId: string, home: ChatsHome) {
      const entry = entries.get(hostId);
      if (!entry || !keepHome(entry, home)) return;
      publish(entry);
      if (active()) void cycle(entry);
    },
    async refreshProject(hostId: string, path: string) {
      const entry = entries.get(hostId);
      if (!entry) return;
      const client = entry.client;
      try {
        const copy = await previewOne(entry, client, path, (weight, work) => guarded(entry, client, weight, work));
        entry.copies = new Map(entry.copies).set(path, copy);
        seedSession(entry, client, path, copy);
        if (entry.errors.has(path)) {
          entry.errors = new Map(entry.errors);
          entry.errors.delete(path);
        }
        publish(entry);
      } catch (error) {
        if (error !== STALE) throw error;
      }
    },
    clientFor: (hostId: string): Client | null => (entries.get(hostId)?.client as Client | undefined) ?? null,
    hostFor: (hostId: string): SavedHost | undefined => entries.get(hostId)?.host,
    views: () => views,
    viewOf: (hostId: string): HostView | undefined => entries.get(hostId)?.view,
    versions: () => key,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
