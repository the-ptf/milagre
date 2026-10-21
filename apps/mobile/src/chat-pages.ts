import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { ChatMessage } from "@milagre/shared/model";
import type { ChatPage } from "./client.ts";
import { ChatWindowCache, prependChatPage } from "@milagre/shared/chat-window-cache";

// The messages of the Chat on screen, from a host that keeps them by Chat (the snapshot then has none: messagesInChats,
// #300): its latest turns, earlier ones on request, and its last turns read again each time the snapshot changes.

type PageClient = { url: string; chatMessages: (projectPath: string, chatId: number, options?: { before?: number; turns?: number }) => Promise<ChatPage> };
export type ChatWindow = ChatPage & { loading: boolean };

const TURNS = 20;
const TAIL = 2;
const EMPTY: ChatWindow = Object.freeze({ messages: [], hasMore: false, total: 0, loading: true }) as ChatWindow;
const NONE: ChatWindow = Object.freeze({ messages: [], hasMore: false, total: 0, loading: false }) as ChatWindow;
const windows = new ChatWindowCache<ChatWindow>({ maxChats: 6, maxBytes: 4 * 1024 * 1024, turns: TURNS });
const listeners = new Map<string, Set<() => void>>();

function set(key: string, next: ChatWindow) {
  windows.set(key, next);
  // A copy: a listener can resubscribe while it is told, and a live Set would then be walked forever.
  for (const listener of [...(listeners.get(key) ?? [])]) listener();
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
  });
  busy.set(key, next);
  return next;
}

async function load(key: string, client: PageClient, projectPath: string, chatId: number) {
  try {
    const page = await client.chatMessages(projectPath, chatId, { turns: TURNS });
    set(key, { ...page, loading: false });
  } catch {
    set(key, { ...(windows.get(key) ?? EMPTY), loading: false });
  }
}

async function refreshTail(key: string, client: PageClient, projectPath: string, chatId: number) {
  const current = windows.get(key);
  if (!current || current.loading) return load(key, client, projectPath, chatId);
  try {
    const tail = await client.chatMessages(projectPath, chatId, { turns: TAIL });
    // Earlier messages can arrive while the tail is on its way; merge into the window that holds them now.
    const latest = windows.get(key) ?? current;
    const merged = mergeTail(latest, tail);
    if (!merged) return load(key, client, projectPath, chatId);
    if (merged !== latest) set(key, { ...merged, loading: false });
  } catch {}
}

/**
 * The window of Chat `chatId`'s messages, read when first shown and its last turns again whenever `changed` (the
 * snapshot) changes; none while `client` (only a host that keeps messages by Chat), `projectPath` or `chatId` is missing.
 */
export function useChatPage(
  client: PageClient | null | undefined,
  projectPath: string | null | undefined,
  chatId: number | null | undefined,
  changed?: unknown,
) {
  const key = client && projectPath && typeof chatId === "number" && chatId > 0 ? `${client.url}|${projectPath}#${chatId}` : null;
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!key) return () => {};
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(listener);
      windows.retain(key);
      return () => {
        set!.delete(listener);
        if (!set!.size) listeners.delete(key);
        windows.release(key);
      };
    },
    [key],
  );
  const page = useSyncExternalStore(subscribe, () => (key ? (windows.get(key) ?? EMPTY) : NONE));
  useEffect(() => {
    if (!key) return;
    void run(key, () => (windows.has(key) ? refreshTail(key, client!, projectPath!, chatId!) : load(key, client!, projectPath!, chatId!)));
  }, [key, client, projectPath, chatId, changed]);
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
      .finally(() => earlierLoads.delete(key));
    earlierLoads.set(key, request);
    return request;
  }, [key, client, projectPath, chatId]);
  return { ...page, loadEarlier };
}
