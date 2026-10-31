import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { ChatMessage } from "@milagre/shared/model";
import type { ChatPage } from "./client.ts";
import { ChatWindowCache, prependChatPage } from "@milagre/shared/chat-window-cache";

// The messages of the Chat on screen, from a host that keeps them by Chat (the snapshot then has none: messagesInChats,
// #300): its latest turns, earlier ones on request, and its last turns read again each time the Project state changes.

type PageClient = { url: string; chatMessages: (projectPath: string, chatId: number, options?: { before?: number; turns?: number }) => Promise<ChatPage> };
export type ChatWindow = ChatPage & { loading: boolean; error?: string };

const TURNS = 20;
const TAIL = 2;
const EMPTY: ChatWindow = Object.freeze({ messages: [], hasMore: false, total: 0, loading: true }) as ChatWindow;
const NONE: ChatWindow = Object.freeze({ messages: [], hasMore: false, total: 0, loading: false }) as ChatWindow;
const windows = new ChatWindowCache<ChatWindow>({ maxChats: 6, maxBytes: 4 * 1024 * 1024, turns: TURNS });
const listeners = new Map<string, Set<() => void>>();
const openings = new Map<string, Promise<unknown>>();

/** A computer that restarted may need its Project reopened before a prefetched page can be read. */
export function noteChatProjectOpening(client: PageClient, projectPath: string, opened: Promise<unknown>) {
  const key = `${client.url}|${projectPath}`;
  openings.set(key, opened);
  const settled = () => {
    if (openings.get(key) === opened) openings.delete(key);
  };
  void opened.then(settled, settled);
}

async function readPage(client: PageClient, projectPath: string, chatId: number, turns: number) {
  // Capture the open before reading: it may finish before a refused page's answer gets back.
  const opening = openings.get(`${client.url}|${projectPath}`);
  try {
    return await client.chatMessages(projectPath, chatId, { turns });
  } catch (error) {
    if (!opening || !/Open the Project before reading its messages/.test(error instanceof Error ? error.message : String(error))) throw error;
    await opening;
    return client.chatMessages(projectPath, chatId, { turns });
  }
}

/** Where each Chat's last page is kept between launches (chat-page-disk.ts); none in tests unless one sets it. */
export type PageDisk = { read(key: string): Promise<ChatPage | null>; write(key: string, page: ChatPage): Promise<void> };
let disk: PageDisk | null = null;
export function setChatPageDisk(next: PageDisk | null) {
  disk = next;
}
// Held back per Chat: a streaming turn reads its tail again many times a minute.
const SAVE_DELAY_MS = 2000;
const saves = new Map<string, ReturnType<typeof setTimeout>>();
function save(key: string, page: ChatPage) {
  if (!disk) return;
  clearTimeout(saves.get(key));
  saves.set(
    key,
    setTimeout(() => {
      saves.delete(key);
      void disk?.write(key, { messages: page.messages, hasMore: page.hasMore, total: page.total });
    }, SAVE_DELAY_MS),
  );
}

function set(key: string, next: ChatWindow) {
  windows.set(key, next);
  // A copy: a listener can resubscribe while it is told, and a live Set would then be walked forever.
  for (const listener of Array.from(listeners.get(key) ?? [])) listener();
  if (!next.loading && !next.error) save(key, next);
}

/** A Chat not held yet paints from its copy on the phone while the computer's own answer is on its way. */
function recall(key: string) {
  void disk
    ?.read(key)
    .then((kept) => {
      if (kept?.messages.length && !windows.has(key)) set(key, { ...kept, loading: true });
    })
    .catch(() => {});
}

/**
 * `current` with its last turns replaced by `tail` (the Chat's latest page): what changed in them is updated, new
 * messages are added, removed ones go. Null when the tail starts after the window ends (more changed than the tail holds).
 */
export function mergeTail(current: ChatPage, tail: ChatPage): ChatPage | null {
  const first = tail.messages[0];
  if (!first) return { ...current, messages: [], hasMore: false, total: tail.total };
  const start = current.messages.findIndex((message) => message.id === first.id);
  if (start < 0) return current.messages.length && tail.hasMore ? null : { ...tail };
  const messages = [...current.messages.slice(0, start), ...tail.messages];
  const same =
    messages.length === current.messages.length &&
    messages.every((message, index) => current.messages[index] !== undefined && sameMessage(message, current.messages[index]));
  return same && tail.total === current.total
    ? current
    : { messages, hasMore: current.hasMore || start > 0 ? current.hasMore : tail.hasMore, total: tail.total };
}
// Read again over the network, a message is a new object; the same JSON is the same message.
const sameMessage = (a: ChatMessage, b: ChatMessage) => a === b || JSON.stringify(a) === JSON.stringify(b);

const busy = new Map<string, Promise<void>>();
const earlierLoads = new Map<string, Promise<void>>();
// A refresh asked for while a read is on its way runs once more when it ends: that read may predate the change.
const again = new Map<string, () => Promise<void>>();
function run(key: string, work: () => Promise<void>): Promise<void> {
  const pending = busy.get(key);
  if (pending) {
    again.set(key, work);
    return pending;
  }
  const next = work().finally(() => {
    busy.delete(key);
    const queued = again.get(key);
    again.delete(key);
    if (queued) void run(key, queued);
    else settleTrim(key);
  });
  busy.set(key, next);
  return next;
}

// A trim asked for while the Chat's window is being read waits for the read: the refresh that brings the new message
// is still on its way when the screen asks. `canTrim` is asked again then: the reader may have scrolled up meanwhile.
const pendingTrims = new Map<string, () => boolean>();
function settleTrim(key: string) {
  if (busy.has(key) || earlierLoads.has(key)) return;
  const canTrim = pendingTrims.get(key);
  pendingTrims.delete(key);
  if (canTrim?.()) trimNow(key);
}
function trimNow(key: string) {
  if (!windows.trim(key)) return;
  for (const listener of Array.from(listeners.get(key) ?? [])) listener();
}

/** Trims Chat `key`'s window to its last turns, now or once the read on its way settles, while `canTrim` says so. */
export function trimChatPage(key: string, canTrim: () => boolean) {
  if (busy.has(key) || earlierLoads.has(key)) {
    pendingTrims.set(key, canTrim);
    return;
  }
  pendingTrims.delete(key);
  if (canTrim()) trimNow(key);
}

async function load(key: string, client: PageClient, projectPath: string, chatId: number) {
  const current = windows.get(key);
  if (current) set(key, { ...current, loading: true, error: undefined });
  else recall(key);
  try {
    // The client bounds the read itself (30 s, with retries while the Mac is busy); a shorter cap here would lose its answer.
    const page = await readPage(client, projectPath, chatId, TURNS);
    set(key, { ...page, loading: false });
  } catch (error) {
    set(key, { ...(windows.get(key) ?? EMPTY), loading: false, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * What a Chat's last turns are read again on: the Project state the computer last sent whole. A snapshot passed in
 * counts by its `project.state`, so a read of its streaming turns alone (up to every 150 ms while one streams) never
 * reads the messages again: a saved message changes the Project state, and its "project" signal brings a new one.
 */
export function savedChange(changed: unknown): unknown {
  if (!changed || typeof changed !== "object" || !("project" in changed)) return changed;
  const project = (changed as { project?: { state?: unknown } }).project;
  return project?.state ?? project;
}

async function refreshTail(key: string, client: PageClient, projectPath: string, chatId: number) {
  const current = windows.get(key);
  if (!current || current.loading || current.error) return load(key, client, projectPath, chatId);
  try {
    const tail = await readPage(client, projectPath, chatId, TAIL);
    // Earlier messages can arrive while the tail is on its way; merge into the window that holds them now.
    const latest = windows.get(key) ?? current;
    const merged = mergeTail(latest, tail);
    if (!merged) return load(key, client, projectPath, chatId);
    if (merged !== latest) set(key, { ...merged, loading: false });
  } catch {}
}

/** Reads Chat `key`'s window, or its last turns again once it holds one; one read at a time per Chat. */
export function refreshChatPage(key: string, client: PageClient, projectPath: string, chatId: number) {
  return run(key, () => (windows.has(key) ? refreshTail(key, client, projectPath, chatId) : load(key, client, projectPath, chatId)));
}

/** Start a cold read during the route handoff; a cached Chat is already ready for its first render. */
export function prefetchChatPage(client: PageClient, projectPath: string, chatId: number) {
  const key = `${client.url}|${projectPath}#${chatId}`;
  if (busy.has(key) || (windows.has(key) && !windows.get(key)?.error)) return;
  void run(key, () => load(key, client, projectPath, chatId));
}

/** Chat `key`'s window as held now, without reading it. Exported for its tests. */
export const peekChatPage = (key: string): ChatWindow | undefined => windows.get(key);

// Each computer's most recent Chats are copied to the phone in the background (the all-computers store reads its Chat
// lists, then calls warmChatPages), so even the first open of one paints from its copy.
const WARM_PER_COMPUTER = 5;
// Chats copied, or found current, since the app started.
const warmed = new Set<string>();
export type WarmChat = { projectPath: string; chatId: number; lastAt: number; lastId: number };

/**
 * Copies `client`'s WARM_PER_COMPUTER most recent `chats` to the phone, one at a time, each read through `limit` (the
 * computer's request limit). A Chat held already, or whose copy ends on its last message, is left alone.
 */
export async function warmChatPages(client: PageClient, chats: WarmChat[], limit: <T>(work: () => Promise<T>) => Promise<T> = (work) => work()) {
  if (!disk) return;
  const recent = [...chats].sort((a, b) => b.lastAt - a.lastAt).slice(0, WARM_PER_COMPUTER);
  for (const { projectPath, chatId, lastId } of recent) {
    const key = `${client.url}|${projectPath}#${chatId}`;
    if (warmed.has(key) || windows.has(key) || busy.has(key)) continue;
    warmed.add(key);
    try {
      const kept = await disk.read(key);
      if (kept?.messages.at(-1)?.id === lastId) continue;
      const page = await limit(() => client.chatMessages(projectPath, chatId, { turns: TURNS }));
      // Opened meanwhile: its window saves the copy itself.
      if (!windows.has(key)) await disk.write(key, page);
    } catch {
      // The computer went away or got busy: the Chat reads on open as before. A later list may try it again.
      warmed.delete(key);
      return;
    }
  }
}

/** Tells `listener` of Chat `key`'s window changes; its window keeps all it read while someone listens. */
export function subscribeChatPage(key: string, listener: () => void) {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(listener);
  windows.retain(key);
  return () => {
    set!.delete(listener);
    if (!set!.size) listeners.delete(key);
    windows.release(key);
  };
}

/**
 * The window of Chat `chatId`'s messages, read when first shown and its last turns again whenever `changed` (the
 * Project state, or a snapshot: see savedChange) changes; none while `client` (only a host that keeps messages by Chat),
 * `projectPath` or `chatId` is missing. `reconnected` counts the connection's recoveries: a snapshot unchanged since the
 * outage keeps its identity (the host answers 304), so a page that failed or went stale while the Mac was away reads
 * again on it.
 */
export function useChatPage(
  client: PageClient | null | undefined,
  projectPath: string | null | undefined,
  chatId: number | null | undefined,
  changed?: unknown,
  reconnected?: number,
) {
  const key = client && projectPath && typeof chatId === "number" && chatId > 0 ? `${client.url}|${projectPath}#${chatId}` : null;
  const subscribe = useCallback((listener: () => void) => (key ? subscribeChatPage(key, listener) : () => {}), [key]);
  const page = useSyncExternalStore(subscribe, () => (key ? (windows.get(key) ?? EMPTY) : NONE));
  const saved = savedChange(changed);
  useEffect(() => {
    if (!key) return;
    void refreshChatPage(key, client!, projectPath!, chatId!);
  }, [key, client, projectPath, chatId, saved, reconnected]);
  const loadEarlier = useCallback(() => {
    if (!key) return Promise.resolve();
    const pending = earlierLoads.get(key);
    if (pending) return pending;
    const current = windows.get(key);
    const first = current?.messages[0];
    if (!current?.hasMore || !first) return Promise.resolve();
    const request = client!
      .chatMessages(projectPath!, chatId!, { before: first.id, turns: TURNS })
      .then((earlier) => {
        const latest = windows.get(key);
        const next = prependChatPage(latest, first.id, earlier);
        if (next && next !== latest) set(key, next);
      })
      .finally(() => {
        earlierLoads.delete(key);
        settleTrim(key);
      });
    earlierLoads.set(key, request);
    return request;
  }, [key, client, projectPath, chatId]);
  // Followed at its bottom, the window drops what it read beyond its last turns; scrolling up reads them again.
  const trim = useCallback((canTrim: () => boolean) => (key ? trimChatPage(key, canTrim) : undefined), [key]);
  return {
    ...page,
    loadEarlier,
    trim,
    retry: useCallback(() => (key ? run(key, () => load(key, client!, projectPath!, chatId!)) : Promise.resolve()), [key, client, projectPath, chatId]),
  };
}
