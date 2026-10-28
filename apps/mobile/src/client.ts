import { uploadAttachment } from "@milagre/shared/attachment-upload";
import { retryKind, retrySend } from "@milagre/shared/send-retry";
import type { ChatMessage, CoordinatorState, NamedProjectLink, OpenLink } from "@milagre/shared/model";
import { isLinkScopeKey, scopeKey } from "@milagre/shared/chat-scopes";
import { applyStatePatch } from "@milagre/shared/state-patch";
import type { StatePatch } from "@milagre/shared/state-patch";
import { phoneSnapshot } from "./chat-scope.ts";
import type { AgentRuns } from "@milagre/shared/agent-runs";
import { isLiveSignal, openLive, type Live, type LiveOptions } from "./live.ts";
import type { RelayTransport } from "./relay-transport.ts";
import { localEndpoint, relayAddress, validAccess, validRelay, type Access, type RelayLink } from "@milagre/shared/pairing-link";

export type OpenProject = {
  path: string;
  name: string;
  state: CoordinatorState;
  link?: OpenLink;
  /** Derived before the host removes shell output from phone snapshots. Absent on older hosts. */
  pullRequestRefs?: Record<number, string[]>;
};
/** A Project's streaming turns; `seq` numbers the last event they hold. */
export type Runs = { runs: AgentRuns; seq?: number };
/** A page of a Chat's messages, from a host that keeps them by Chat (the snapshot then has none: messagesInChats). */
export type ChatPage = { messages: ChatMessage[]; hasMore: boolean; total: number };
export type ChatSearchMatch = { message: { id: number; session_id: number }; score: number; snippet: string; highlight: [number, number]; term: string };
export type Snapshot = { project: OpenProject; runs: Runs; previewOnly?: false };
/** Drawer metadata only. Never use it as the Chat screen's snapshot. Older hosts return a full Snapshot. */
export type ProjectPreview = Omit<Snapshot, "previewOnly"> & { previewOnly: true };
export type RegisteredProject = { id: string; path: string; name: string };
/** `hidden`: the user keeps this Project out of the Projects list (and desktop's all-Projects sidebar). */
export type RecentProject = { path: string; name?: string; hidden?: boolean; link?: NamedProjectLink; projects?: RegisteredProject[] };

// The pairing link's parts moved to @milagre/shared with parsePairing; the phone's modules still import them from here.
export { localEndpoint, relayAddress, validAccess, validRelay };
export type { Access, RelayLink };

/** What a client needs to reach one computer: a direct address, or the relay. */
export type ClientHost = { address: string; token: string; access?: Access; relay?: RelayLink };
/** Which LAN transport, if any, carries this computer's traffic right now. */
export type RouteView = { current(): RelayTransport | null; subscribe(listener: () => void): () => void };
/** The phone's side of the relay, injected so this file stays free of native modules. */
export type RelayRuntime = {
  randomUUID?(): string;
  /** Device consent runs before the network deadline starts. */
  beforeCall?(method: string, args: unknown[]): Promise<void>;
  /** The one transport for this Mac, opened on first use and shared by every client. */
  transport(host: { relay: RelayLink; token: string }): Promise<RelayTransport>;
  /** This computer's LAN route; requests and live streams use its transport while `current()` has one. */
  lan?(host: { id: string; token: string }): RouteView;
  /** Images fetched through the relay, kept as files in the cache folder. */
  files: { find(name: string): Promise<string | null>; write(name: string, bytes: Uint8Array): Promise<string> };
};

/** A short, stable file name for an image: FNV-1a twice over, plus the image's own extension. */
function mediaName(text: string, path: string): string {
  const fnv = (seed: number) => {
    let hash = seed >>> 0;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  };
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(path)?.[1]?.toLowerCase();
  return fnv(0x811c9dc5) + fnv(0x050c5d1f) + (ext ? `.${ext}` : "");
}

type Answer = { status: number; ok: boolean; etag?: string | null; text: () => Promise<string> };
const LOST = "Connection lost. Reconnect to your computer. Check the Chat before sending again.";
/** What a retired client's callers get: the computer it served was replaced, and nothing more is started for it. */
const replaced = () => new Error("This computer was replaced.");
/** The connection dropped or a deadline passed: the request may have reached the Mac (see retryKind in send-retry). */
const lost = () => Object.assign(new Error(LOST), { retry: "unknown" as const });
const decoder = new TextDecoder();
// The waits before a request a busy Mac turned away (429) goes again; its own deadline ends the tries.
const BUSY_RETRY_DELAYS = [250, 500, 1000, 2000] as const;
/** Waits `ms`, or rejects as a lost connection once `signal` aborts (the request's deadline passed). */
function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(lost());
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(lost());
      },
      { once: true },
    );
  });
}
const MEDIA_AT_ONCE = 4;
// Creating a worktree can fetch and copy files; removing one with big ignored folders can take minutes.
const LONG_CALLS = new Set([
  "worktree:create",
  "worktree:remove",
  "link:send",
  "link:open",
  "agent:update-cli",
  // PR reads and writes go through gh to GitHub (paged GraphQL, a fetch for missing commits, a merge).
  "pr:detail",
  "pr:diff-files",
  "pr:diff-file",
  "pr:comment",
  "pr:reply",
  "pr:submit-review",
  "pr:merge",
  "pr:ready",
  "pr:image",
  "pr:labels",
  "pr:set-labels",
  "pr:reviewer-candidates",
  "pr:request-reviewers",
]);
// Settings › MCP: the Mac caps one check at 30 s (packages/core/src/mcp/index.cjs); wait a little longer for its answer.
const MCP_CALLS = new Set(["mcp:accounts", "mcp:check", "mcp:definition", "mcp:saveUrl", "mcp:remove", "mcp:toggle"]);
// The Mac embeds images before uploading a public snapshot; match its desktop RPC deadline.
const DESIGN_SHARE_CALLS = new Set(["artifact:share-page", "artifact:revoke-page-share", "artifact:revoke-saved-page-share"]);

/**
 * One request through a transport, the relay's or the LAN's. The relay's own failures, and a phone key that can't be read, carry copy for the
 * user; anything else is a lost connection.
 */
function overRelay(
  through: Promise<RelayTransport>,
  method: "GET" | "POST",
  route: string,
  headers: Record<string, string>,
  body: string | undefined,
  signal: AbortSignal,
) {
  // The transport cannot cancel a request, so the deadline only stops waiting for it.
  const deadline = new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(lost()), { once: true }));
  const answer = through.then((relayed) =>
    relayed.request(method, route, headers, body).catch((error) => {
      throw (error as Error)?.name === "RelayTransportError" ? error : lost();
    }),
  );
  return Promise.race([deadline, answer]);
}

/** The bridge's live socket, read through the relay. It opens once the transport is ready, unless closed first. */
function relayLive(path: string, { onSignal, onStatus }: LiveOptions, through: Promise<RelayTransport>): Live {
  let closed = false;
  let handle: { close(): void } | null = null;
  through.then(
    (relayed) => {
      if (closed) return;
      handle = relayed.live(
        path,
        (data) => {
          let type: unknown;
          try {
            type = JSON.parse(data).type;
          } catch {
            return;
          }
          if (isLiveSignal(type)) onSignal(type);
        },
        onStatus,
      );
    },
    () => {
      /* the snapshot polls until a live socket opens */
    },
  );
  return {
    close() {
      closed = true;
      handle?.close();
      handle = null;
    },
  };
}

export function createClient(host: ClientHost, fetcher: typeof fetch = fetch, timeoutMs = 30000, runtime?: RelayRuntime) {
  const relay = host.relay ? validRelay(host.relay) : undefined;
  if (relay && !runtime) throw new Error("This app cannot reach a Mac through the relay.");
  const access = relay ? undefined : host.access;
  const url = relay ? relayAddress(relay.hostId) : localEndpoint(host.address);
  if (access && !url.startsWith("https:")) throw new Error("A Cloudflare access token needs an HTTPS address.");
  const token = host.token.trim();
  // The last snapshot per route and its ETag: an unchanged Project answers 304 instead of megabytes.
  const cached = new Map<string, { etag: string; value: unknown }>();
  // Every route is cached by its URL, so a route whose URL varies (the Projects of /chat-lists) must not pile up.
  const CACHED_ROUTES = 200;
  const CHAT_LISTS = "/chat-lists?";
  function remember(route: string, entry: { etag: string; value: unknown }) {
    // The Projects asked for change from read to read: only the latest batch's answer can still be revalidated.
    if (route.startsWith(CHAT_LISTS)) for (const known of cached.keys()) if (known !== route && known.startsWith(CHAT_LISTS)) cached.delete(known);
    cached.delete(route);
    cached.set(route, entry);
    while (cached.size > CACHED_ROUTES) cached.delete(cached.keys().next().value!);
  }
  // Set once the owner replaced this client: it starts no request, transport or stream after that.
  let retired = false;
  // Per Project, the last snapshot the host numbered: the next one comes as a patch on it, a few hundred bytes where a
  // large Project's snapshot runs to megabytes. A host that doesn't number snapshots answers with the whole one.
  const numbered = new Map<string, { epoch: string; version: number; value: SnapshotAnswer }>();
  type SnapshotAnswer = Snapshot | { link: OpenLink; runs: Runs };
  type NumberedAnswer = { epoch: string; version: number } & ({ base: number; patch?: StatePatch } | { snapshot: SnapshotAnswer });
  async function readSnapshot(owner: string): Promise<SnapshotAnswer> {
    const held = numbered.get(owner);
    // In a header, so the route stays the one an older host answers with an ETag (and a 304 when nothing changed).
    const since = held ? `${held.epoch}:${held.version}` : "none";
    // X-Milagre-Chat-Pages: the snapshot without messages; the chat screen reads its Chat's as pages (chatMessages).
    const answer = await request<SnapshotAnswer | NumberedAnswer>(`/snapshot?projectPath=${encodeURIComponent(owner)}`, undefined, timeoutMs, {
      "X-Milagre-Snapshot-Since": since,
      "X-Milagre-Chat-Pages": "1",
    });
    if (!("epoch" in answer) || typeof answer.version !== "number") {
      numbered.delete(owner);
      return answer as SnapshotAnswer;
    }
    let value: SnapshotAnswer;
    if ("snapshot" in answer) value = answer.snapshot;
    else if (held && answer.epoch === held.epoch && answer.base === held.version) value = applyStatePatch(held.value, answer.patch);
    else {
      // A patch on a snapshot this app no longer holds: ask for the whole one.
      numbered.delete(owner);
      return readSnapshot(owner);
    }
    numbered.set(owner, { epoch: answer.epoch, version: answer.version, value });
    return value;
  }
  const auth = { Authorization: `Bearer ${token}`, ...(access ? { "CF-Access-Client-Id": access.id, "CF-Access-Client-Secret": access.secret } : {}) };
  const lanView = runtime?.lan?.({ id: url, token });
  const lanNow = () => lanView?.current() ?? null;
  // The Mac adds the token to every request it forwards; over the relay or the LAN it only rides the handshake.
  /** The transport this request rides: the LAN when it is up, else the relay for a relay computer, else none (HTTPS). */
  const carrier = (): Promise<RelayTransport> | null => {
    if (retired) throw replaced();
    const lan = lanNow();
    if (lan) return Promise.resolve(lan);
    return relay ? runtime!.transport({ relay, token }) : null;
  };

  async function overHttp(route: string, headers: Record<string, string>, body: string | undefined, signal: AbortSignal): Promise<Answer> {
    let response: Response;
    try {
      response = await fetcher(url + route, { method: body === undefined ? "GET" : "POST", headers: { ...auth, ...headers }, body, signal, redirect: "error" });
    } catch {
      throw lost();
    }
    if (response.redirected || (response.url && new URL(response.url).origin !== url))
      throw new Error("The computer address redirected. Enter its direct HTTPS address.");
    return { status: response.status, ok: response.ok, etag: response.headers?.get?.("etag"), text: () => response.text() };
  }

  /** Runs `work` with a signal that aborts after `deadlineMs`, including the time to read the body. */
  async function timed<T>(deadlineMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), deadlineMs);
    try {
      return await work(controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  }

  function request<T>(route: string, body?: unknown, deadlineMs = timeoutMs, extraHeaders: Record<string, string> = {}): Promise<T> {
    const started = Date.now();
    return timed(deadlineMs, async (signal) => {
      for (let tries = 0; ; tries++) {
        try {
          return await attempt<T>(route, body, extraHeaders, signal);
        } catch (error) {
          // A busy Mac turns a request away unread (429), so it goes again while its deadline lasts.
          const delay = BUSY_RETRY_DELAYS[Math.min(tries, BUSY_RETRY_DELAYS.length - 1)] ?? 2000;
          if ((error as { status?: number }).status !== 429 || Date.now() - started + delay >= deadlineMs) throw error;
          await pause(delay, signal);
        }
      }
    });
  }

  async function attempt<T>(route: string, body: unknown, extraHeaders: Record<string, string>, signal: AbortSignal): Promise<T> {
    if (retired) throw replaced();
    const previous = body === undefined ? cached.get(route) : undefined;
    const headers = { "Content-Type": "application/json", ...extraHeaders, ...(previous ? { "If-None-Match": previous.etag } : {}) };
    const sent = body === undefined ? undefined : JSON.stringify(body);
    let response: Answer;
    const through = carrier();
    if (through) {
      const relayed = await overRelay(through, sent === undefined ? "GET" : "POST", route, headers, sent, signal);
      response = {
        status: relayed.status,
        ok: relayed.status >= 200 && relayed.status < 300,
        etag: relayed.headers.etag,
        text: async () => decoder.decode(relayed.body),
      };
    } else response = await overHttp(route, headers, sent, signal);
    if (response.status === 304 && cached.has(route)) return cached.get(route)!.value as T;
    let value;
    // Cloudflare and proxies answer with an HTML page when the request never reaches the host.
    try {
      value = JSON.parse(await response.text());
    } catch {
      throw Object.assign(
        new Error(
          [401, 403].includes(response.status)
            ? through
              ? "Your Mac refused this phone. Scan its code again in Settings → Devices."
              : "Your computer's Cloudflare access was refused. Scan its pairing code again."
            : response.status >= 500
              ? "Your computer isn't answering. Check that Milagre and its mobile host are running on your Mac."
              : `Unexpected response from your computer (${response.status}).`,
        ),
        { status: response.status },
      );
    }
    if (value?.v !== 1) throw new Error("Incompatible daemon response. Update the app and daemon together.");
    // The Mac runs 16 requests at once and holds 64 more (phone-channels.cjs, mobile-bridge.cjs); an older Mac refuses past 16.
    if (response.status === 429) throw Object.assign(new Error("Your computer is busy right now. Try again in a moment."), { status: 429 });
    if (!response.ok || value.error) throw Object.assign(new Error(value.error?.message || `Request failed (${response.status})`), { status: response.status });
    if (body === undefined && response.etag) remember(route, { etag: response.etag, value: value.result });
    return value.result as T;
  }

  const mediaRoute = (projectPath: string, path: string) => `/media?projectPath=${encodeURIComponent(projectPath)}&path=${encodeURIComponent(path)}`;
  /** An image file on the computer, served by the bridge only from the Project's Worktrees and Milagre's image folders. */
  function media(projectPath: string, path: string) {
    if (relay || lanNow()) throw new Error("Images from a relay computer load through mediaFile.");
    return { uri: url + mediaRoute(projectPath, path), headers: auth };
  }
  // One load per image: thumbnails ask on every render, and must get the same source back.
  const images = new Map<string, Promise<{ uri: string }>>();
  // The Mac serves at most 16 relayed requests at once. A chat full of images takes 4 of them, in order, so the
  // snapshot, runs and sends always find a free one.
  let fetching = 0;
  const waiting: (() => void)[] = [];
  function inTurn<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        fetching++;
        work()
          .then(resolve, reject)
          .finally(() => {
            fetching--;
            waiting.shift()?.();
          });
      };
      if (fetching < MEDIA_AT_ONCE) run();
      else waiting.push(run);
    });
  }
  function relayImage(projectPath: string, path: string): Promise<{ uri: string }> {
    const name = mediaName(`${url}\n${projectPath}\n${path}`, path);
    const known = images.get(name);
    if (known) return known;
    const loading = (async () => {
      const found = await runtime!.files.find(name);
      if (found) return { uri: found };
      // The carrier is chosen when the request starts: a route that switched while this waited its turn is not the one to use.
      const response = await inTurn(async () => {
        const through = carrier();
        if (!through) throw lost();
        return timed(timeoutMs, (signal) => overRelay(through, "GET", mediaRoute(projectPath, path), {}, undefined, signal));
      });
      if (response.status !== 200) throw new Error("Could not load this image from your Mac.");
      return { uri: await runtime!.files.write(name, response.body) };
    })();
    images.set(name, loading);
    loading.catch(() => {
      if (images.get(name) === loading) images.delete(name);
    });
    return loading;
  }

  return {
    url,
    /** Stops this client from starting any request, relay transport or stream; what is already in flight settles on its own. */
    retire() {
      retired = true;
    },
    async recentScopes(): Promise<RecentProject[]> {
      // All three requests settle before this answers or fails: a caller that limits requests in flight counts them as one job.
      const [recent, linked, registered] = await Promise.allSettled([
        request<RecentProject[]>("/rpc", { v: 1, method: "project:recent", args: [] }),
        request<NamedProjectLink[]>("/rpc", { v: 1, method: "link:list", args: [] }),
        request<RegisteredProject[]>("/rpc", { v: 1, method: "project:registry", args: [] }),
      ]);
      if (recent.status === "rejected") throw recent.reason;
      let groups: [NamedProjectLink[], RegisteredProject[]];
      const failure = linked.status === "rejected" ? linked : registered.status === "rejected" ? registered : null;
      if (failure) {
        if (!/not available from mobile|demo computer only/i.test((failure.reason as Error)?.message)) throw failure.reason;
        groups = [[], []];
      } else groups = [(linked as PromiseFulfilledResult<NamedProjectLink[]>).value, (registered as PromiseFulfilledResult<RegisteredProject[]>).value];
      const projects = recent.value;
      const [links, registry] = groups;
      return [
        ...projects.map(({ hidden: _hidden, ...project }) => project),
        ...links.map(({ hidden: _hidden, ...link }) => ({
          path: scopeKey({ kind: "link", linkId: link.id }),
          name: link.name,
          link,
          projects: link.projectIds.map((id) => registry.find((project) => project.id === id) ?? { id, name: "Unavailable Project", path: "" }),
        })),
      ];
    },
    async open(owner: string) {
      const link = isLinkScopeKey(owner);
      const opened = await request<{ path?: string }>(
        "/rpc",
        { v: 1, method: link ? "link:open" : "project:open", args: [link ? owner.slice("milagre-link:".length) : owner] },
        link ? Math.max(timeoutMs, 330000) : timeoutMs,
      );
      return phoneSnapshot(await readSnapshot(link ? owner : (opened.path ?? owner)));
    },
    upload: (projectPath: string, name: string, base64: string) =>
      uploadAttachment(
        (part) =>
          retrySend(() => request<{ path: string; name: string; id?: string } | null>("/attachments", part), {
            retryable: (error) => retryKind(error) !== null,
          }),
        { projectPath, name, base64 },
        runtime?.randomUUID,
      ),
    reuseUpload: (projectPath: string, id: string) => request<{ path: string; name: string; id: string } | null>("/attachments", { projectPath, reuse: id }),
    // Git fetches, worktree setup and removing a worktree get the same deadline as the desktop daemon client.
    call: async <T>(method: string, args: unknown[] = []) => {
      if (retired) throw replaced();
      if (runtime?.beforeCall) await runtime.beforeCall(method, args);
      return request<T>(
        "/rpc",
        { v: 1, method, args },
        LONG_CALLS.has(method)
          ? Math.max(timeoutMs, 330000)
          : DESIGN_SHARE_CALLS.has(method)
            ? Math.max(timeoutMs, method === "artifact:share-page" ? 420000 : 120000)
            : MCP_CALLS.has(method)
              ? Math.max(timeoutMs, 45000)
              : timeoutMs,
      );
    },
    media,
    /** A relay computer's image, fetched once into the cache folder; resolves to its file:// URI. */
    mediaFile: (projectPath: string, path: string) => relayImage(projectPath, path).then((source) => source.uri),
    /** The image source to show: the authenticated URL directly, or the cached file through the relay. */
    image: (projectPath: string, path: string): { uri: string; headers?: Record<string, string> } | Promise<{ uri: string }> =>
      relay || lanNow() ? relayImage(projectPath, path) : media(projectPath, path),
    /** A page of one Chat's messages: its latest turns, or those before the message `before`. */
    chatMessages: (projectPath: string, chatId: number, options: { before?: number; turns?: number } = {}) =>
      request<ChatPage>(
        `/chat-messages?projectPath=${encodeURIComponent(projectPath)}&chatId=${chatId}` +
          (options.before !== undefined ? `&before=${options.before}` : "") +
          (options.turns !== undefined ? `&turns=${options.turns}` : ""),
      ),
    /** Matches across the Chats of a Project or Link, best first: where each is and what matched. */
    searchChats: (projectPath: string, query: string) =>
      request<ChatSearchMatch[]>(`/search?projectPath=${encodeURIComponent(projectPath)}&q=${encodeURIComponent(query)}`),
    /** One message with its tools' full output; the snapshot leaves that out. */
    message: (projectPath: string, id: number) => request<ChatMessage>(`/message?projectPath=${encodeURIComponent(projectPath)}&id=${id}`),
    snapshot: async (projectPath: string) => phoneSnapshot(await readSnapshot(projectPath)),
    preview: (projectPath: string) => request<ProjectPreview | Snapshot>("/snapshot?projectPath=" + encodeURIComponent(projectPath) + "&view=chats"),
    /**
     * The drawer previews of up to 20 Projects in one read-only request. A Project the Mac can't read comes back as
     * `{ error }`. A Mac without the route fails with code "unsupported": ask for each Project's `preview` instead.
     */
    chatLists: (paths: string[]) =>
      request<Record<string, ProjectPreview | { error: string }>>("/chat-lists?paths=" + encodeURIComponent(JSON.stringify(paths))).catch((error: unknown) => {
        throw (error as { status?: number })?.status === 404 ? Object.assign(error as Error, { code: "unsupported" as const }) : error;
      }),
    /** Just the Project's streaming turns: what a live "runs" signal fetches instead of the whole snapshot. */
    runs: (projectPath: string) => request<Runs>("/runs?projectPath=" + encodeURIComponent(projectPath)),
    /** Chat keys, in every Project, whose turn waits on an approval or question. */
    attention: () => request<string[]>("/attention"),
    inbox: () => request<import("@milagre/shared/attention").InboxSnapshot>("/inbox"),
    /** The Project's live socket, through the same tunnel and Access headers as every request, or through the relay. */
    live: (projectPath: string, options: LiveOptions): Live => {
      if (retired) return { close() {} };
      const path = `/live?projectPath=${encodeURIComponent(projectPath)}`;
      const open = () => {
        const through = carrier();
        return through ? relayLive(path, options, through) : openLive(`${url.replace(/^http/, "ws")}${path}`, auth, options);
      };
      if (!lanView) return open();
      let using = lanNow();
      let inner = open();
      // A switch of route moves the stream: the old one closes, the new one opens; the snapshot polls in between.
      const unsubscribe = lanView.subscribe(() => {
        if (lanNow() === using) return;
        using = lanNow();
        inner.close();
        options.onStatus(false);
        inner = open();
      });
      return {
        close() {
          unsubscribe();
          inner.close();
        },
      };
    },
  };
}
export type Client = ReturnType<typeof createClient>;
