import { uploadAttachment } from "@milagre/shared/attachment-upload";
import { retryKind, retrySend } from "@milagre/shared/send-retry";
import type { ChatMessage, CoordinatorState, NamedProjectLink, OpenLink } from "@milagre/shared/model";
import { isLinkScopeKey, scopeKey } from "@milagre/shared/chat-scopes";
import type { ChatsHome, ProjectKind } from "@milagre/shared/chats-home";
import { applyStatePatch } from "@milagre/shared/state-patch";
import type { StatePatch } from "@milagre/shared/state-patch";
import { phoneSnapshot } from "./chat-scope.ts";
import type { AgentRun, AgentRuns } from "@milagre/shared/agent-runs";
import { isLiveSignal, openLive, type Live, type LiveOptions } from "./live.ts";
import type { RelayTransport } from "./relay-transport.ts";
import { localEndpoint, relayAddress, validAccess, validRelay, type Access, type RelayLink } from "@milagre/shared/pairing-link";

export type OpenProject = {
  path: string;
  name: string;
  kind?: ProjectKind;
  state: CoordinatorState;
  link?: OpenLink;
  pullRequestRefs?: Record<number, string[]>;
};
export type Runs = { runs: AgentRuns; seq?: number };
export type RunsReply = Runs & { summaries?: Record<string, Omit<AgentRun, "text" | "steps">>; detailChats?: number[] };
export type ChatPage = { messages: ChatMessage[]; hasMore: boolean; total: number };
export type ChatSearchMatch = { message: { id: number; session_id: number }; score: number; snippet: string; highlight: [number, number]; term: string };
export type Snapshot = { project: OpenProject; runs: Runs; previewOnly?: false };
export type ProjectPreview = Omit<Snapshot, "previewOnly"> & { previewOnly: true };
export type RegisteredProject = { id: string; path: string; name: string };
export type RecentProject = {
  path: string;
  name?: string;
  hidden?: boolean;
  origin?: string;
  link?: NamedProjectLink;
  projects?: RegisteredProject[];
};

export { localEndpoint, relayAddress, validAccess, validRelay };
export type { Access, RelayLink };

export type ClientHost = { address: string; token: string; access?: Access; relay?: RelayLink };
export type RouteView = { current(): RelayTransport | null; subscribe(listener: () => void): () => void };
/** The phone's side of the relay, injected so this file stays free of native modules. */
export type RelayRuntime = {
  randomUUID?(): string;
  transport(host: { relay: RelayLink; token: string }): Promise<RelayTransport>;
  lan?(host: { id: string; token: string }): RouteView;
  files: { find(name: string): Promise<string | null>; write(name: string, bytes: Uint8Array): Promise<string> };
};

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
const replaced = () => new Error("This computer was replaced.");
const lost = () => Object.assign(new Error(LOST), { retry: "unknown" as const });
const decoder = new TextDecoder();
const BUSY_RETRY_DELAYS = [250, 500, 1000, 2000] as const;
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
const LINK_DELETE_MS = 30 * 60 * 1000;
const LONG_CALLS = new Set([
  "worktree:create",
  "worktree:remove",
  "storage:worktrees",
  "storage:remove-worktree",
  "import:scan",
  "import:run",
  "link:send",
  "link:open",
  "agent:update-cli",
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
const PAGE_URL_MS = 75000;
const MCP_CALLS = new Set(["mcp:accounts", "mcp:check", "mcp:definition", "mcp:saveUrl", "mcp:remove", "mcp:toggle"]);
const DESIGN_SHARE_CALLS = new Set(["artifact:share-page", "artifact:revoke-page-share", "artifact:revoke-saved-page-share"]);

function overRelay(
  through: Promise<RelayTransport>,
  method: "GET" | "POST",
  route: string,
  headers: Record<string, string>,
  body: string | undefined,
  signal: AbortSignal,
) {
  const deadline = new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(lost()), { once: true }));
  const answer = through.then((relayed) =>
    relayed.request(method, route, headers, body).catch((error) => {
      throw (error as Error)?.name === "RelayTransportError" ? error : lost();
    }),
  );
  return Promise.race([deadline, answer]);
}

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
    () => {},
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
  if (relay && !runtime) throw new Error("This app cannot reach a computer through the relay.");
  const access = relay ? undefined : host.access;
  const url = relay ? relayAddress(relay.hostId) : localEndpoint(host.address);
  if (access && !url.startsWith("https:")) throw new Error("A Cloudflare access token needs an HTTPS address.");
  const token = host.token.trim();
  const cached = new Map<string, { etag: string; value: unknown }>();
  const CACHED_ROUTES = 200;
  const CHAT_LISTS = "/chat-lists?";
  function remember(route: string, entry: { etag: string; value: unknown }) {
    if (route.startsWith(CHAT_LISTS)) for (const known of cached.keys()) if (known !== route && known.startsWith(CHAT_LISTS)) cached.delete(known);
    cached.delete(route);
    cached.set(route, entry);
    while (cached.size > CACHED_ROUTES) cached.delete(cached.keys().next().value!);
  }
  let retired = false;
  const numbered = new Map<string, { epoch: string; version: number; value: SnapshotAnswer }>();
  type SnapshotAnswer = Snapshot | { link: OpenLink; runs: Runs };
  type NumberedAnswer = { epoch: string; version: number } & ({ base: number; patch?: StatePatch } | { snapshot: SnapshotAnswer });
  async function readSnapshot(owner: string): Promise<SnapshotAnswer> {
    const held = numbered.get(owner);
    const since = held ? `${held.epoch}:${held.version}` : "none";
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
      numbered.delete(owner);
      return readSnapshot(owner);
    }
    numbered.set(owner, { epoch: answer.epoch, version: answer.version, value });
    return value;
  }
  const auth = { Authorization: `Bearer ${token}`, ...(access ? { "CF-Access-Client-Id": access.id, "CF-Access-Client-Secret": access.secret } : {}) };
  const lanView = runtime?.lan?.({ id: url, token });
  const lanNow = () => lanView?.current() ?? null;
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
              ? "Your computer refused this phone. Scan its code again in Settings → Phone & sharing."
              : "Your computer's Cloudflare access was refused. Scan its pairing code again."
            : response.status >= 500
              ? "Your computer isn't answering. Check that Milagre and its mobile host are running on it."
              : `Unexpected response from your computer (${response.status}).`,
        ),
        { status: response.status },
      );
    }
    if (value?.v !== 1) throw new Error("Incompatible daemon response. Update the app and daemon together.");
    if (response.status === 429) throw Object.assign(new Error("Your computer is busy right now. Try again in a moment."), { status: 429 });
    if (!response.ok || value.error) throw Object.assign(new Error(value.error?.message || `Request failed (${response.status})`), { status: response.status });
    if (body === undefined && response.etag) remember(route, { etag: response.etag, value: value.result });
    return value.result as T;
  }

  const mediaRoute = (projectPath: string, path: string) => `/media?projectPath=${encodeURIComponent(projectPath)}&path=${encodeURIComponent(path)}`;
  function media(projectPath: string, path: string) {
    if (relay || lanNow()) throw new Error("Images from a relay computer load through mediaFile.");
    return { uri: url + mediaRoute(projectPath, path), headers: auth };
  }
  const images = new Map<string, Promise<{ uri: string }>>();
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
      const response = await inTurn(async () => {
        const through = carrier();
        if (!through) throw lost();
        return timed(timeoutMs, (signal) => overRelay(through, "GET", mediaRoute(projectPath, path), {}, undefined, signal));
      });
      if (response.status !== 200) throw new Error("Could not load this image from your computer.");
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
    retire() {
      retired = true;
    },
    async recentScopes(): Promise<RecentProject[]> {
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
    async chatsHome(): Promise<ChatsHome | null> {
      try {
        const home = await request<ChatsHome | null>("/rpc", { v: 1, method: "chats:home", args: [] });
        return home && typeof home.path === "string" && home.path ? { path: home.path, exists: home.exists === true } : null;
      } catch (error) {
        if (/not available from mobile|demo computer only/i.test((error as Error)?.message)) return null;
        throw error;
      }
    },
    ensureChatsHome: () => request<{ path: string; name: string; kind?: ProjectKind }>("/rpc", { v: 1, method: "chats:ensure", args: [] }),
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
    call: async <T>(method: string, args: unknown[] = []) => {
      if (retired) throw replaced();
      return request<T>(
        "/rpc",
        { v: 1, method, args },
        method === "link:delete"
          ? Math.max(timeoutMs, LINK_DELETE_MS)
          : LONG_CALLS.has(method)
            ? Math.max(timeoutMs, 330000)
            : DESIGN_SHARE_CALLS.has(method)
              ? Math.max(timeoutMs, method === "artifact:share-page" ? 420000 : 120000)
              : MCP_CALLS.has(method)
                ? Math.max(timeoutMs, 45000)
                : method === "browser:page-url"
                  ? Math.max(timeoutMs, PAGE_URL_MS)
                  : timeoutMs,
      );
    },
    media,
    mediaFile: (projectPath: string, path: string) => relayImage(projectPath, path).then((source) => source.uri),
    image: (projectPath: string, path: string): { uri: string; headers?: Record<string, string> } | Promise<{ uri: string }> =>
      relay || lanNow() ? relayImage(projectPath, path) : media(projectPath, path),
    chatMessages: (projectPath: string, chatId: number, options: { before?: number; turns?: number } = {}) =>
      request<ChatPage>(
        `/chat-messages?projectPath=${encodeURIComponent(projectPath)}&chatId=${chatId}` +
          (options.before !== undefined ? `&before=${options.before}` : "") +
          (options.turns !== undefined ? `&turns=${options.turns}` : ""),
      ),
    searchChats: (projectPath: string, query: string) =>
      request<ChatSearchMatch[]>(`/search?projectPath=${encodeURIComponent(projectPath)}&q=${encodeURIComponent(query)}`),
    message: (projectPath: string, id: number) => request<ChatMessage>(`/message?projectPath=${encodeURIComponent(projectPath)}&id=${id}`),
    snapshot: async (projectPath: string) => phoneSnapshot(await readSnapshot(projectPath)),
    preview: (projectPath: string) => request<ProjectPreview | Snapshot>("/snapshot?projectPath=" + encodeURIComponent(projectPath) + "&view=chats"),
    chatLists: (paths: string[]) =>
      request<Record<string, ProjectPreview | { error: string }>>("/chat-lists?paths=" + encodeURIComponent(JSON.stringify(paths))).catch((error: unknown) => {
        throw (error as { status?: number })?.status === 404 ? Object.assign(error as Error, { code: "unsupported" as const }) : error;
      }),
    runs: (projectPath: string, chats?: readonly number[]) =>
      request<RunsReply>(
        "/runs?projectPath=" +
          encodeURIComponent(projectPath) +
          (chats === undefined ? "" : "&chats=" + encodeURIComponent(JSON.stringify([...new Set(chats)].sort((a, b) => a - b)))),
      ),
    attention: () => request<string[]>("/attention"),
    inbox: () => request<import("@milagre/shared/attention").InboxSnapshot>("/inbox"),
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
