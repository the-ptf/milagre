/** What the bridge's live socket says: fetch the runs, or the whole Project, again. It never carries state. */
export type LiveSignal = "runs" | "project" | "accounts" | "links" | "designs" | "mcp" | "routines" | "usage" | "token-usage" | "keybindings" | "pulls";
/** Whether a live message names a signal this app knows; a newer bridge may send others, which are ignored. */
export const isLiveSignal = (type: unknown): type is LiveSignal =>
  type === "runs" ||
  type === "project" ||
  type === "accounts" ||
  type === "links" ||
  type === "designs" ||
  type === "mcp" ||
  type === "routines" ||
  type === "usage" ||
  type === "token-usage" ||
  type === "keybindings" ||
  type === "pulls";
type LiveEvents = { open: unknown; message: { data?: unknown }; error: { message?: string }; close: unknown };
export type LiveSocket = {
  addEventListener<K extends keyof LiveEvents>(type: K, listener: (event: LiveEvents[K]) => void): void;
  close(code?: number, reason?: string): void;
};
export type Timers = { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (id: unknown) => void };
export type LiveOptions = {
  onSignal: (signal: LiveSignal) => void;
  /** True when the socket opens, false when an open one is lost (it then reconnects). */
  onStatus: (open: boolean) => void;
  create?: (url: string, headers: Record<string, string>) => LiveSocket;
  timers?: Timers;
  random?: () => number;
};
export type Live = { close(): void };

/** React Native's WebSocket always sends an Origin; the bridge accepts this one and refuses every web page's. */
export const LIVE_ORIGIN = "milagre-app://phone";
const BACKOFF = [1000, 2000, 5000, 10000, 30000];
// An older bridge answers the upgrade with a 404; there is nothing to gain from asking it every few seconds.
const UNSUPPORTED = 5 * 60_000;
// The bridge sends a ping every 25 s; a socket silent for longer than two is dead (a network change leaves no close).
const SILENCE = 60_000;
const defaultTimers: Timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) };
// React Native's WebSocket takes headers as a third argument; a browser's does not.
const nativeSocket = (url: string, headers: Record<string, string>) =>
  new (WebSocket as unknown as new (url: string, protocols: undefined, options: { headers: Record<string, string> }) => LiveSocket)(url, undefined, {
    headers,
  });

/** A live socket that reconnects with backoff until closed. */
export function openLive(
  url: string,
  headers: Record<string, string>,
  { onSignal, onStatus, create = nativeSocket, timers = defaultTimers, random = Math.random }: LiveOptions,
): Live {
  let socket: LiveSocket | null = null;
  let retry: unknown;
  let silence: unknown;
  let failures = 0;
  let closed = false;
  let unsupported = false;
  let up = false;
  const quiet = () => {
    timers.clearTimeout(silence);
    silence = timers.setTimeout(() => {
      const dead = socket;
      dead?.close();
      if (dead) lost(dead);
    }, SILENCE);
  };
  function lost(from: LiveSocket) {
    if (from !== socket || closed) return;
    socket = null;
    timers.clearTimeout(silence);
    if (up) {
      up = false;
      onStatus(false);
    }
    const wait = unsupported ? UNSUPPORTED : (BACKOFF[Math.min(failures, BACKOFF.length - 1)] ?? 30000);
    failures++;
    unsupported = false;
    // Jitter, so a Mac coming back is not met by every socket at once.
    retry = timers.setTimeout(connect, wait * (0.8 + 0.4 * random()));
  }
  function connect() {
    if (closed) return;
    let next: LiveSocket;
    try {
      next = create(url, { ...headers, Origin: LIVE_ORIGIN });
    } catch {
      failures++;
      retry = timers.setTimeout(connect, UNSUPPORTED);
      return;
    }
    socket = next;
    next.addEventListener("open", () => {
      if (next !== socket) return;
      failures = 0;
      up = true;
      quiet();
      onStatus(true);
    });
    next.addEventListener("message", (event) => {
      if (next !== socket) return;
      quiet();
      let type: unknown;
      try {
        type = JSON.parse(String(event.data)).type;
      } catch {
        return;
      }
      if (isLiveSignal(type)) onSignal(type);
    });
    // Both platforms put the refused upgrade's status in the message ("…101… but was '404 Not Found'").
    next.addEventListener("error", (event) => {
      if (/\b404\b/.test(event?.message ?? "")) unsupported = true;
      lost(next);
    });
    next.addEventListener("close", () => lost(next));
  }
  connect();
  return {
    close() {
      closed = true;
      timers.clearTimeout(retry);
      timers.clearTimeout(silence);
      const last = socket;
      socket = null;
      last?.close(1000);
    },
  };
}

/** The first wait before a failed Project fetch is tried again with the socket open, doubling up to the cap. */
const PROJECT_RETRY_MS = 1000;
const PROJECT_RETRY_MAX_MS = 8000;

export type SyncOptions = {
  /** Opens the Project's live socket. */
  connect: (options: Pick<LiveOptions, "onSignal" | "onStatus">) => Live;
  snapshot: () => Promise<void>;
  runs: () => Promise<void>;
  accounts?: () => void;
  /** A Link was made or removed on the computer. */
  links?: () => void;
  /** A host-wide setting also travels over confined Project sockets. */
  designs?: () => void;
  /** The Mac's PR poll found a change in a Project's PRs. */
  pulls?: () => void;
  liveStatus?: (open: boolean) => void;
  onError: (error: Error) => void;
  active: () => boolean;
  /** Calls back with whether the app is in the foreground; returns an unsubscribe. */
  watchActive: (listener: (active: boolean) => void) => () => void;
  /** How long until the next poll while the socket is down. */
  pollDelay: () => number;
  timers?: Timers;
};

/**
 * Keeps one Project fresh: fetches when the live socket says something changed, and polls only while it is down (an
 * older bridge, or a network that drops WebSockets). The socket closes in the background and opens again on return.
 */
export function syncProject({
  connect,
  snapshot,
  runs,
  accounts,
  links,
  designs,
  pulls,
  liveStatus,
  onError,
  active,
  watchActive,
  pollDelay,
  timers = defaultTimers,
}: SyncOptions) {
  let stopped = false;
  let open = false;
  let live: Live | null = null;
  let poll: unknown;
  // One fetch at a time, so a slow response never lands over a newer one; "project" covers "runs".
  let pending: LiveSignal | null = null;
  let fetching = false;
  // A Project fetch that failed with the socket open is tried again: no signal may come until the turn ends, and until
  // then a send the computer took keeps the composer waiting for the saved copy (a busy Mac's 429, a dropped answer).
  let retry: unknown;
  let failures = 0;
  function retryLater() {
    timers.clearTimeout(retry);
    if (stopped || !open) return;
    retry = timers.setTimeout(() => void pull("project"), Math.min(PROJECT_RETRY_MS * 2 ** failures, PROJECT_RETRY_MAX_MS));
    failures++;
  }
  async function pull(kind: LiveSignal) {
    pending = pending === "project" || kind === "project" ? "project" : "runs";
    if (fetching) return;
    fetching = true;
    try {
      // oxlint-disable-next-line no-unmodified-loop-condition -- the returned stop function sets stopped, and watcher events set pending, while the loop awaits
      while (pending && !stopped) {
        const next = pending;
        pending = null;
        try {
          await (next === "project" ? snapshot() : runs());
          if (next === "project") {
            failures = 0;
            timers.clearTimeout(retry);
          }
        } catch (error) {
          if (stopped) continue;
          onError(error as Error);
          if (next === "project") retryLater();
        }
      }
    } finally {
      fetching = false;
    }
  }
  function schedule() {
    timers.clearTimeout(poll);
    if (stopped || open || !active()) return;
    poll = timers.setTimeout(() => {
      void pull("project").finally(schedule);
    }, pollDelay());
  }
  function start() {
    open = false;
    live?.close();
    live = connect({
      onSignal: (signal) => {
        if (stopped) return;
        if (signal === "accounts") accounts?.();
        else if (signal === "links") links?.();
        else if (signal === "designs") designs?.();
        else if (signal === "pulls") pulls?.();
        // The Routines screen and the Chat header read Routines on their own socket (use-routines.ts).
        else if (signal === "runs" || signal === "project") void pull(signal);
      },
      // On opening, catch up on what changed while it was down; on losing it, poll until it is back.
      onStatus: (next) => {
        if (stopped) return;
        open = next;
        liveStatus?.(open);
        if (open) timers.clearTimeout(poll);
        void pull("project");
        // A Link made or removed while the socket was down sent its signal to nobody.
        if (open) links?.();
        if (!open) schedule();
      },
    });
  }
  function background() {
    timers.clearTimeout(poll);
    timers.clearTimeout(retry);
    failures = 0;
    live?.close();
    live = null;
    open = false;
  }
  if (active()) {
    void pull("project");
    start();
    schedule();
  }
  const unwatch = watchActive((foreground) => {
    if (stopped) return;
    if (!foreground) {
      background();
      return;
    }
    void pull("project");
    start();
    schedule();
  });
  return () => {
    stopped = true;
    unwatch();
    background();
  };
}
