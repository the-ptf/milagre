import type { ChatsHome } from "@milagre/shared/chats-home";
import type { Client, OpenProject, ProjectPreview, RecentProject, Snapshot } from "./client";
import type { SavedHost } from "./hosts-store";
import { PROJECTS_EVERY, REQUESTS_AT_ONCE, createLimiter, nextDelay } from "./all-computers-schedule.ts";

/** A computer's reachability as the sidebar shows it. */
export type Reach = "online" | "checking" | "offline";
/** A Project's Chats as a computer last answered: a preview, or the full snapshot of a Link. */
export type ProjectCopy = Snapshot | ProjectPreview;
/** What the store reads from a computer's client. */
export type StoreClient = Pick<Client, "url" | "call" | "recentScopes" | "preview" | "open" | "chatLists"> &
  Partial<Pick<Client, "retire" | "chatsHome" | "chatMessages">>;
/** A Chat the store lists, with what says how recent it is and which message it ends on. */
export type RecentChat = { projectPath: string; chatId: number; lastAt: number; lastId: number };

/** Everything the sidebar knows about one computer; replaced, never changed, so it can be compared by identity. */
export type HostView = {
  hostId: string;
  name: string;
  state: Reach;
  /** When a read of this computer last worked (ms since epoch); 0 before the first. */
  lastSuccess: number;
  /** Whether the computer has answered with its Project list yet: an empty list before that is not "no Projects". */
  loaded: boolean;
  projects: RecentProject[];
  copies: ReadonlyMap<string, ProjectCopy>;
  /** The Projects whose last read failed, with why. */
  errors: ReadonlyMap<string, string>;
  /**
   * Where the computer keeps its Chats without a Project: undefined before it answered, null when it has none (an
   * older daemon). Never one of `projects`; its Chats are in `copies` under its path once it exists.
   */
  home?: ChatsHome | null;
};

/** The session's own client and Project list, shared with the store instead of opening a second client. */
export type CurrentHost = {
  hostId: string;
  client: StoreClient;
  /** Undefined until this session has read the computer's list; keep any list the sidebar already holds. */
  projects: RecentProject[] | undefined;
  reload: () => Promise<void>;
  /** Hands the session a Project's Chat list the store just read from its own client, so opening that Project is warm. */
  seed?: (client: StoreClient, path: string, copy: ProjectCopy) => void;
};

/** What one mounted sidebar or page needs read: whether it is shown, whether it lists every Project, and which Projects it folds. */
export type ViewPolicy = { visible: boolean; expandAll: boolean; isFolded: (hostId: string, path: string) => boolean };

export type StoreDeps = {
  createClient: (host: SavedHost) => StoreClient;
  /** A computer's hidden Projects and saved order applied to what `recentScopes` answered. */
  applyProjects: (hostId: string, projects: RecentProject[]) => Promise<RecentProject[]>;
  now: () => number;
  random: () => number;
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** After a read, copies the computer's most recent Chats to the phone, each request through `limit` (chat-pages.ts). */
  warm?: (client: StoreClient, chats: RecentChat[], limit: <T>(work: () => Promise<T>) => Promise<T>) => Promise<void>;
};

/** Every listed Chat that isn't archived, from each Project's copy. */
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
/** The Mac's answers for a Project it hasn't opened yet, and for a Link, which the batch read doesn't list. */
const OPEN_FIRST = /open the project before reading/i;
const LINK_ERROR = /chats of a link are not listed/i;
/** A Project the Mac refused to list is asked again after this long, not every read. */
const STUCK_FOR = 5 * 60 * 1000;
const STALE = new Error("This computer was replaced.");
const SKIPPED = new Error("This computer is not answering.");
const isLink = (path: string) => path.startsWith("milagre-link:");
/**
 * What identifies the credentials and route a client was made with: a client made for other ones must not outlive them.
 * Every field that authenticates or addresses the computer counts (the learned LAN route does not: it is not part of the pairing).
 */
const credentials = (host: SavedHost) =>
  JSON.stringify([host.token, host.address, host.relay?.hostId, host.relay?.key, host.relay?.url, host.relay?.direct, host.access?.id, host.access?.secret]);
/** A refusal that comes from this Project or this request, not the network: asking again at once would only get it again. */
const deterministic = (error: unknown) => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;
};

type Entry = {
  id: string;
  host: SavedHost;
  credentials: string;
  client: StoreClient;
  /** The session's own client, which the session replaces when it connects again. */
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
  /** Whether a chats:home ask is queued or out, so a read that follows doesn't ask a second time. */
  askingHome: boolean;
  canonical: Map<string, string>;
  /** Projects the Mac refused to list, and until when they are left alone. */
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

/**
 * Every saved computer's Chats for the sidebar. One entry per computer holds its client, its request limit, its poller
 * and its last answers. Whatever an entry's read returns is kept only while that entry is still the computer's: the
 * session swapping its client, a computer being forgotten or hidden, or a re-pair with another token drops the entry, so
 * a late answer can neither revive it nor reach the new one. Reads only run while a sidebar is shown and the app is in
 * the foreground; one poller serves however many sidebars are mounted.
 */
export function createAllComputersStore(deps: StoreDeps) {
  const entries = new Map<string, Entry>();
  // One limit per computer for as long as any of its requests is out: a new entry for the same computer (its client or
  // credentials changed) must not open three more while the old one's still run, so a slot frees only when its request settles.
  const limiters = new Map<string, ReturnType<typeof createLimiter>>();
  let order: string[] = [];
  // Every mounted consumer's own requirements; what is read is their union (see `effective`).
  const consumers = new Set<{ policy: ViewPolicy }>();
  let foreground = true;
  let expandAll = false;
  let isFolded: (hostId: string, path: string) => boolean = () => false;
  const listeners = new Set<() => void>();
  let key = "";
  let views: HostView[] = [];

  const active = () => foreground && [...consumers].some((consumer) => consumer.policy.visible);
  /**
   * The union of the shown consumers' requirements: any wants every Project read, or a Project is read unless every one
   * of them folds it. With none shown, the hidden ones still decide how a read the user asked for goes.
   */
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
    lastSuccess: entry.lastSuccess,
    loaded: entry.loaded,
    projects: entry.projects,
    copies: entry.copies,
    errors: entry.errors,
    ...(entry.home !== undefined ? { home: entry.home } : {}),
  });
  function publish(entry?: Entry) {
    if (entry) {
      entry.version++;
      entry.view = buildView(entry);
    }
    const present = order.flatMap((id) => entries.get(id) ?? []);
    key = present.map((item) => `${item.id}:${item.version}`).join(",");
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
  /** Ends an entry that is no longer the computer's: no timer, and a client of its own starts no request from now on. */
  function retire(entry: Entry) {
    dispose(entry);
    if (!entry.shared) entry.client.retire?.();
  }
  /** Gives the session a fresh copy of a Project it is the one to open: only from its own client, and only while that client is the entry's. */
  function seedSession(entry: Entry, client: StoreClient, path: string, copy: ProjectCopy) {
    if (entry.shared && alive(entry, client)) entry.seed?.(client, path, copy);
  }
  /** Forgets what the computer's Project list no longer names, so a Project that left it stops being kept. */
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

  /**
   * Runs `work` in the entry's limit; its answer counts only if the entry still owns `client` afterwards. Work that
   * starts after the entry was replaced, or for which `skip` says no, is never issued.
   */
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
    // The drawer's Chats group isn't folded per computer, so a home that exists is always read.
    const home = entry.home?.exists ? entry.home.path : "";
    return home && !paths.includes(home) && (entry.stuck.get(home) ?? 0) <= deps.now() ? [...paths, home] : paths;
  }
  /**
   * Opens a Project for its canonical path before its first read. The home opens with chats:ensure, which leaves the
   * computer's shown Project alone: listing Chats must not move what a desktop window shows.
   */
  const openFor = (entry: Entry, client: StoreClient, path: string) =>
    path === entry.home?.path ? client.call<OpenProject>("chats:ensure", []) : client.call<OpenProject>("project:open", [path]);
  /**
   * Asks where the computer's Chats home is, queued behind its Project list and never waited on: the drawer's first
   * Projects don't sit behind it. It counts neither way for the computer's health (a failed ask keeps what was known), and
   * a home that changed is read by the cycle that follows.
   */
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
    // Only a home that now exists has Chats to read; one not made yet changes nothing to read.
    if (found?.exists && active()) void cycle(entry);
  }
  /** Records the computer's home as it answered, publishing only a change. */
  function keepHome(entry: Entry, home: ChatsHome | null) {
    if (entry.home === home || (entry.home && home && entry.home.path === home.path && entry.home.exists === home.exists)) return false;
    entry.home = home;
    prune(entry);
    return true;
  }

  /** One Project's Chats the way the sidebar always read them: open it (once) for its path, then its Chat list. */
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
    // A scheduled read this one replaces: left set, it would start a second read right behind this one.
    dispose(entry);
    const client = entry.client;
    // A read the user asked for goes on while no sidebar shows; the poller's stops issuing requests once none does.
    const idle = () => !force && !active();
    const run = (async () => {
      let succeeded = 0;
      let failed = 0;
      const dead = () => succeeded === 0 && failed >= 2;
      const skipped = () => dead() || idle();
      // Counts the requests that worked and failed in this read; a skipped one is neither.
      const tracked = async <T>(weight: number, work: () => Promise<T>): Promise<T> => {
        try {
          const value = await guarded(entry, client, weight, work, skipped);
          succeeded++;
          return value;
        } catch (error) {
          if (error !== STALE && error !== SKIPPED) failed++;
          throw error;
        }
      };
      try {
        const listDue = force || !entry.projectsAt || deps.now() - entry.projectsAt >= PROJECTS_EVERY;
        if (listDue) {
          try {
            // The Project list costs three requests on the Mac.
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
        // A home not known yet is asked on every read, not only with the Project list: the session's computer comes with
        // its list already read (right after pairing too), and its No project choice must not wait a minute for the next one.
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
        // A Project the Mac refused is left alone for a while; a dropped connection or a busy Mac is not the Project's fault.
        const cool = (path: string) => entry.stuck.set(path, deps.now() + STUCK_FOR);
        const accept = (path: string, copy: ProjectCopy) => {
          cleared.add(path);
          if (entry.copies.get(path) !== copy) updates.set(path, copy);
          seedSession(entry, client, path, copy);
        };
        const single = paths.filter((path) => isLink(path) || entry.noBatch || !client.chatLists);
        const batched = paths.filter((path) => !single.includes(path));
        // One batch read of up to 20 Projects. A Project the Mac hasn't opened yet is opened once for this computer
        // (opening moves it in the Mac's recent list, so never again) and read in a second batch.
        const readBatch = async (chunk: string[], mayOpen: boolean): Promise<void> => {
          const answer = await tracked(1, () => client.chatLists(chunk));
          const unopened: string[] = [];
          for (const path of chunk) {
            const found = answer[path];
            if (found && !("error" in found)) accept(path, found);
            else if (!found || LINK_ERROR.test(found.error)) single.push(path);
            else if (OPEN_FIRST.test(found.error) && mayOpen && !entry.canonical.has(path)) unopened.push(path);
            else {
              // Anything else (confinement, a bad path) keeps the last good data and is not asked again for a while.
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
            // A Mac without the route is asked per Project, now and from here on.
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
        if (failed > 0 && succeeded === 0) {
          entry.failures++;
          entry.state = entry.failures >= (entry.lastSuccess ? 2 : 1) ? "offline" : entry.state === "online" ? "online" : "checking";
        } else if (succeeded > 0 || entry.shared || entry.state === "checking") {
          entry.failures = 0;
          entry.state = "online";
          entry.lastSuccess = deps.now();
        }
        publish(entry);
        // In the background, through the same limit: a sidebar read never waits on it.
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

  /** Starts every computer's reads when the sidebar shows, and stops them when it doesn't. */
  function reconcile() {
    for (const entry of entries.values()) {
      if (active()) {
        if (!entry.running && entry.timer === null) void cycle(entry);
      } else dispose(entry);
    }
  }

  /**
   * A sidebar or page registers what it needs read. What is read is the union of everyone registered, so one closing
   * gives back exactly what the others asked for. `update` changes this consumer's requirements; `release` ends them.
   */
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
    /**
     * Matches the entries to the saved computers that aren't hidden, and to the session's client. A computer that
     * left the list is dropped; one whose credentials or client changed gets a new entry, so work started for the old
     * one is discarded when it lands. Cheap to call on every change.
     */
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
        // Another pairing of the same computer's id shares nothing with the old one: not its Projects, nor its answers.
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
    /** A sidebar is shown; returns what ends that. Any number may be shown at once, and the reads run once. */
    show: () => register({ visible: true, expandAll: false, isFolded: () => false }).release,
    setForeground(next: boolean) {
      if (foreground === next) return;
      foreground = next;
      reconcile();
    },
    /** Reads every computer now, its Project list too: pull to refresh. */
    refreshAll(): Promise<void> {
      return Promise.all([...entries.values()].map((entry) => cycle(entry, true))).then(() => undefined);
    },
    /** Reads just these computers now, their Project lists too: Retry on the offline line. */
    refreshHosts(ids: string[]): Promise<void> {
      return Promise.all(ids.map((id) => entries.get(id)).flatMap((entry) => (entry ? [cycle(entry, true)] : []))).then(() => undefined);
    },
    /** Hides or shows one of a computer's Projects in what the sidebar lists, as Choose projects saved it. */
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
    /**
     * The phone made a computer's Chats home (picking No project there): it shows as made at once and its Chats are read
     * from now on, without waiting for the next read of the computer's Project list.
     */
    setHome(hostId: string, home: ChatsHome) {
      const entry = entries.get(hostId);
      if (!entry || !keepHome(entry, home)) return;
      publish(entry);
      if (active()) void cycle(entry);
    },
    /** Reads one Project again, after a Chat action changed it. */
    async refreshProject(hostId: string, path: string) {
      const entry = entries.get(hostId);
      if (!entry) return;
      const client = entry.client;
      try {
        const copy = await previewOne(entry, client, path, (weight, work) => guarded(entry, client, weight, work));
        entry.copies = new Map(entry.copies).set(path, copy);
        seedSession(entry, client, path, copy);
        if (entry.errors.delete(path)) entry.errors = new Map(entry.errors);
        publish(entry);
      } catch (error) {
        if (error !== STALE) throw error;
      }
    },
    /** The client that talks to this computer now, for an action on one of its Chats. Null once it is gone. */
    clientFor: (hostId: string): Client | null => (entries.get(hostId)?.client as Client | undefined) ?? null,
    hostFor: (hostId: string): SavedHost | undefined => entries.get(hostId)?.host,
    views: () => views,
    viewOf: (hostId: string): HostView | undefined => entries.get(hostId)?.view,
    /** Changes whenever any computer's data does; the sidebar's one subscription. */
    versions: () => key,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
