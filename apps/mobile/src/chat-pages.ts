import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { ChatMessage } from "@milagre/shared/model";
import type { ChatPage } from "./client.ts";
import { ChatWindowCache, prependChatPage } from "@milagre/shared/chat-window-cache";

type PageClient = { url: string; chatMessages: (projectPath: string, chatId: number, options?: { before?: number; turns?: number }) => Promise<ChatPage> };
export type ChatWindow = ChatPage & { loading: boolean; error?: string };

const TURNS = 20;
const TAIL = 2;
const EMPTY: ChatWindow = Object.freeze({ messages: [], hasMore: false, total: 0, loading: true }) as ChatWindow;
const NONE: ChatWindow = Object.freeze({ messages: [], hasMore: false, total: 0, loading: false }) as ChatWindow;
const windows = new ChatWindowCache<ChatWindow>({ maxChats: 6, maxBytes: 4 * 1024 * 1024, turns: TURNS });
const listeners = new Map<string, Set<() => void>>();
const openings = new Map<string, Promise<unknown>>();

export function noteChatProjectOpening(client: PageClient, projectPath: string, opened: Promise<unknown>) {
  const key = `${client.url}|${projectPath}`;
  openings.set(key, opened);
  const settled = () => {
    if (openings.get(key) === opened) openings.delete(key);
  };
  void opened.then(settled, settled);
}

async function readPage(client: PageClient, projectPath: string, chatId: number, turns: number) {
  const opening = openings.get(`${client.url}|${projectPath}`);
  try {
    return await client.chatMessages(projectPath, chatId, { turns });
  } catch (error) {
    if (!opening || !/Open the Project before reading its messages/.test(error instanceof Error ? error.message : String(error))) throw error;
    await opening;
    return client.chatMessages(projectPath, chatId, { turns });
  }
}

export type PageDisk = { read(key: string): Promise<ChatPage | null>; write(key: string, page: ChatPage): Promise<void> };
let disk: PageDisk | null = null;
export function setChatPageDisk(next: PageDisk | null) {
  disk = next;
}
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
  for (const listener of Array.from(listeners.get(key) ?? [])) listener();
  if (!next.loading && !next.error) save(key, next);
}

function recall(key: string) {
  void disk
    ?.read(key)
    .then((kept) => {
      if (kept?.messages.length && !windows.has(key)) set(key, { ...kept, loading: true });
    })
    .catch(() => {});
}

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
const sameMessage = (a: ChatMessage, b: ChatMessage) => a === b || JSON.stringify(a) === JSON.stringify(b);

const busy = new Map<string, Promise<void>>();
const earlierLoads = new Map<string, Promise<void>>();
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

export function trimChatPage(key: string, canTrim: () => boolean) {
  if (busy.has(key) || earlierLoads.has(key)) {
    pendingTrims.set(key, canTrim);
    return;
  }
  pendingTrims.delete(key);
  if (canTrim()) trimNow(key);
}

// iOS closes the phone's sockets when the app leaves the foreground, so a read on its way then fails without the
let foreground = true;
let departures = 0;
const cutOff = new Map<string, () => Promise<void>>();
export function setChatPagesForeground(next: boolean) {
  if (foreground === next) return;
  foreground = next;
  if (!next) {
    departures++;
    return;
  }
  const resumed = [...cutOff];
  cutOff.clear();
  for (const [key, work] of resumed) if (listeners.has(key)) void run(key, work);
}

async function load(key: string, client: PageClient, projectPath: string, chatId: number) {
  const current = windows.get(key);
  if (current) set(key, { ...current, loading: true, error: undefined });
  else recall(key);
  const departed = departures;
  try {
    const page = await readPage(client, projectPath, chatId, TURNS);
    set(key, { ...page, loading: false });
  } catch (error) {
    if (departed !== departures) {
      const shown = windows.get(key);
      if (shown?.messages.length) set(key, { ...shown, loading: false });
      const work = () => load(key, client, projectPath, chatId);
      if (foreground) void run(key, work);
      else cutOff.set(key, work);
      return;
    }
    set(key, { ...(windows.get(key) ?? EMPTY), loading: false, error: error instanceof Error ? error.message : String(error) });
  }
}

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
    const latest = windows.get(key) ?? current;
    const merged = mergeTail(latest, tail);
    if (!merged) return load(key, client, projectPath, chatId);
    if (merged !== latest) set(key, { ...merged, loading: false });
  } catch {}
}

export function refreshChatPage(key: string, client: PageClient, projectPath: string, chatId: number) {
  return run(key, () => (windows.has(key) ? refreshTail(key, client, projectPath, chatId) : load(key, client, projectPath, chatId)));
}

export function prefetchChatPage(client: PageClient, projectPath: string, chatId: number) {
  const key = `${client.url}|${projectPath}#${chatId}`;
  if (busy.has(key) || (windows.has(key) && !windows.get(key)?.error)) return;
  void run(key, () => load(key, client, projectPath, chatId));
}

export const peekChatPage = (key: string): ChatWindow | undefined => windows.get(key);

const WARM_PER_COMPUTER = 5;
const warmed = new Set<string>();
export type WarmChat = { projectPath: string; chatId: number; lastAt: number; lastId: number };

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
      if (!windows.has(key)) await disk.write(key, page);
    } catch {
      warmed.delete(key);
      return;
    }
  }
}

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
  const trim = useCallback((canTrim: () => boolean) => (key ? trimChatPage(key, canTrim) : undefined), [key]);
  return {
    ...page,
    loadEarlier,
    trim,
    retry: useCallback(() => (key ? run(key, () => load(key, client!, projectPath!, chatId!)) : Promise.resolve()), [key, client, projectPath, chatId]),
  };
}
