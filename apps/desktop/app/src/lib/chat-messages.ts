import { readWithTimeout } from "@milagre/shared/read-timeout";
import { rememberChat } from "./offline-cache.ts";
import { bridgeForKey, isRemoteKey } from "./computer-bridge.ts";
import { computerOfKey } from "@milagre/shared/chat-scopes";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { ChatMessage } from "../model.ts";
import type { MessageChanges } from "../electron.d.ts";
import { stateEvents } from "./state-events.ts";
import { ChatWindowCache, prependChatPage } from "@milagre/shared/chat-window-cache";

export type ChatWindow = {
  messages: ChatMessage[];
  hasMore: boolean;
  total: number;
  loading: boolean;
  error?: string;
};

const TURNS = 20;
const EMPTY: ChatWindow = Object.freeze({ messages: [], hasMore: false, total: 0, loading: true }) as ChatWindow;
const NONE: ChatWindow = Object.freeze({ messages: [], hasMore: false, total: 0, loading: false }) as ChatWindow;
const windows = new ChatWindowCache<ChatWindow>({ maxChats: 8, maxBytes: 8 * 1024 * 1024, turns: TURNS });
const listeners = new Map<string, Set<() => void>>();
const keyOf = (scope: string, chatId: number) => `${scope}#${chatId}`;

function notify(key: string) {
  for (const listener of Array.from(listeners.get(key) ?? [])) listener();
}

function set(key: string, next: ChatWindow) {
  windows.set(key, next);
  notify(key);
  if (!next.loading && !next.error) {
    const at = key.lastIndexOf("#");
    rememberChat(key.slice(0, at), Number(key.slice(at + 1)), next);
  }
}

export function applyChanges(current: ChatWindow, chatId: number, changes: MessageChanges): ChatWindow {
  const removed = new Set(changes.removed);
  let messages = removed.size ? current.messages.filter((message) => !removed.has(message.id)) : current.messages;
  let total = current.total - (current.messages.length - messages.length);
  for (const { message, after } of changes.changed) {
    if (message.session_id !== chatId) continue;
    const at = messages.findIndex((item) => item.id === message.id);
    if (at >= 0) {
      messages = messages.map((item, index) => (index === at ? message : item));
      continue;
    }
    total++;
    const before = after === null ? -1 : messages.findIndex((item) => item.id === after);
    if (before < 0 && after !== null && current.hasMore && messages.length) continue;
    const place = before < 0 ? (after === null ? 0 : messages.length) : before + 1;
    messages = [...messages.slice(0, place), message, ...messages.slice(place)];
  }
  return messages === current.messages && total === current.total ? current : { ...current, messages, total };
}

const loads = new Map<string, Promise<void>>();
const earlierLoads = new Map<string, Promise<void>>();
const stale = new Set<string>();
const openings = new Map<string, Promise<unknown>>();
const NOT_OPEN = /Open the Project before reading its messages/;

export function noteScopeOpening(scope: string, opened: Promise<unknown>) {
  openings.set(scope, opened);
  const settled = () => {
    if (openings.get(scope) === opened) openings.delete(scope);
  };
  opened.then(settled, settled);
}

function readPage(scope: string, chatId: number) {
  const read = () => {
    let page: Promise<{ messages: ChatMessage[]; hasMore: boolean; total: number }>;
    try {
      page = bridgeForKey(scope).readChatMessages(scope, chatId, { turns: TURNS });
    } catch (error) {
      page = Promise.reject(error);
    }
    return readWithTimeout(() => page);
  };
  return read().catch((error: unknown) => {
    const opening = openings.get(scope);
    if (!opening || !NOT_OPEN.test(error instanceof Error ? error.message : String(error))) throw error;
    return opening.then(read, read);
  });
}
function recallRemote(scope: string, chatId: number, key: string) {
  if (!isRemoteKey(scope)) return;
  const recall = window.milagre.computers?.recall;
  if (!recall) return;
  void Promise.resolve(recall(computerOfKey(scope), { kind: "chat", scope, chatId }))
    .then((kept) => {
      if (!kept?.messages.length || !loads.has(key) || windows.has(key)) return;
      set(key, { messages: kept.messages as ChatMessage[], hasMore: kept.hasMore, total: kept.total, loading: true });
    })
    .catch(() => {});
}
function load(scope: string, chatId: number) {
  const key = keyOf(scope, chatId);
  let loading = loads.get(key);
  if (!loading) {
    const current = windows.get(key);
    if (current) set(key, { ...current, loading: true, error: undefined });
    recallRemote(scope, chatId, key);
    loading = readPage(scope, chatId)
      .then(
        (page) => {
          if (loads.get(key) === loading) set(key, { messages: page.messages, hasMore: page.hasMore, total: page.total, loading: false });
        },
        (error: Error) => {
          if (loads.get(key) === loading) set(key, { ...(windows.get(key) ?? EMPTY), loading: false, error: error.message });
        },
      )
      .finally(() => {
        if (loads.get(key) === loading) {
          loads.delete(key);
          if (stale.delete(key)) void load(scope, chatId);
        }
        settleTrim(key);
      });
    loads.set(key, loading);
  }
  return loading;
}

export async function loadEarlier(scope: string, chatId: number, turns = TURNS) {
  const key = keyOf(scope, chatId);
  const pending = earlierLoads.get(key);
  if (pending) return pending;
  const current = windows.get(key);
  const first = current?.messages[0];
  if (!current?.hasMore || !first) return;
  const request = bridgeForKey(scope)
    .readChatMessages(scope, chatId, { before: first.id, turns })
    .then((page) => {
      if (earlierLoads.get(key) !== request) return;
      const latest = windows.get(key);
      const next = prependChatPage(latest, first.id, page);
      if (next && next !== latest) set(key, next);
    })
    .finally(() => {
      if (earlierLoads.get(key) === request) earlierLoads.delete(key);
      settleTrim(key);
    });
  earlierLoads.set(key, request);
  return request;
}

const pendingTrims = new Map<string, () => boolean>();
const reading = (key: string) => loads.has(key) || earlierLoads.has(key);

function trimNow(key: string, canTrim: () => boolean) {
  if (canTrim() && windows.trim(key)) notify(key);
}

export function trimChatWindow(scope: string, chatId: number, canTrim: () => boolean) {
  const key = keyOf(scope, chatId);
  if (reading(key)) pendingTrims.set(key, canTrim);
  else {
    pendingTrims.delete(key);
    trimNow(key, canTrim);
  }
}

function settleTrim(key: string) {
  const canTrim = pendingTrims.get(key);
  if (!canTrim || reading(key)) return;
  pendingTrims.delete(key);
  trimNow(key, canTrim);
}

async function loadAll(scope: string, chatId: number, signal?: AbortSignal) {
  const key = keyOf(scope, chatId);
  while (listeners.get(key)?.size && windows.get(key)?.hasMore) {
    if (signal?.aborted) break;
    await loadEarlier(scope, chatId, 1_000);
  }
}

let following = false;
function follow() {
  if (following) return;
  following = true;
  stateEvents.onMessages(({ scope, changes, reset }) => {
    if (reset) {
      const keys = new Set([...loads.keys(), ...earlierLoads.keys(), ...windows.keys()]);
      for (const key of keys) {
        if (!key.startsWith(`${scope}#`)) continue;
        loads.delete(key);
        earlierLoads.delete(key);
        stale.delete(key);
        void load(scope, Number(key.slice(scope.length + 1)));
      }
      return;
    }
    for (const key of loads.keys()) {
      if (!key.startsWith(`${scope}#`)) continue;
      const chatId = Number(key.slice(scope.length + 1));
      if (changes?.removed.length || changes?.changed.some(({ message }) => message.session_id === chatId)) stale.add(key);
    }
    for (const [key, current] of Array.from(windows)) {
      if (!key.startsWith(`${scope}#`)) continue;
      const chatId = Number(key.slice(scope.length + 1));
      if (changes) {
        const next = applyChanges(current, chatId, changes);
        if (next !== current) set(key, next);
      }
    }
  });
}

/**
 * Reads Chat `chatId`'s window before it is shown (the pointer is over its row, or a click is switching to it), so
 * opening it paints at once: a switch calls this before it sets any state, so the page read goes out ahead of the reads
 * the switch's render starts. A window already read, or being read, is left alone; one whose read failed reads again.
 */
export function prefetchChatMessages(scope: string, chatId: number) {
  if (!(chatId > 0)) return;
  const key = keyOf(scope, chatId);
  if (loads.has(key) || (windows.has(key) && !windows.get(key)?.error)) return;
  follow();
  void load(scope, chatId);
}

// from its copy (recallRemote) instead of waiting on the other Mac. Only into the offline copy: the windows held in memory
const WARM_PER_COMPUTER = 5;
const WARM_DELAY_MS = 2_000;
type WarmCandidate = { scope: string; chatId: number; lastAt: number; lastId: number };
const warmCandidates = new Map<string, Map<string, WarmCandidate>>();
const WARM_RETRY_MS = 30_000;
const WARM_TRIES = 3;
const warmed = new Set<string>();
const warmFailures = new Map<string, number>();
let warmTimer: ReturnType<typeof setTimeout> | undefined;
let warming: Promise<void> | null = null;

export function warmRecentChats(
  scope: string,
  state: { messagesInChats?: boolean; sessions?: Record<string, { id: number; archived?: boolean; summary?: { lastAt?: number; lastId?: number } }> },
  delayMs = WARM_DELAY_MS,
) {
  if (!isRemoteKey(scope) || state.messagesInChats !== true || !window.milagre.computers?.recall) return;
  const computer = computerOfKey(scope);
  let candidates = warmCandidates.get(computer);
  if (!candidates) warmCandidates.set(computer, (candidates = new Map()));
  for (const session of Object.values(state.sessions ?? {})) {
    const { lastAt, lastId } = session.summary ?? {};
    if (session.archived || !(session.id > 0) || !lastAt || !lastId) continue;
    candidates.set(keyOf(scope, session.id), { scope, chatId: session.id, lastAt, lastId });
  }
  warmTimer ??= setTimeout(() => {
    warmTimer = undefined;
    void warmNext();
  }, delayMs);
}

function warmNext(): Promise<void> {
  if (warming) return warming.then(warmNext);
  warming = (async () => {
    for (const [computer, candidates] of warmCandidates) {
      const recent = [...candidates.entries()].sort(([, a], [, b]) => b.lastAt - a.lastAt).slice(0, WARM_PER_COMPUTER);
      for (const [key, { scope, chatId, lastId }] of recent) {
        if (warmed.has(key) || windows.has(key) || loads.has(key) || (warmFailures.get(key) ?? 0) >= WARM_TRIES) continue;
        warmed.add(key);
        try {
          const kept = await window.milagre.computers?.recall?.(computer, { kind: "chat", scope, chatId });
          if ((kept?.messages.at(-1) as { id?: number } | undefined)?.id === lastId) continue;
          const page = await readWithTimeout(() => bridgeForKey(scope).readChatMessages(scope, chatId, { turns: TURNS }));
          if (!windows.has(key)) rememberChat(scope, chatId, page);
        } catch {
          warmed.delete(key);
          const failures = (warmFailures.get(key) ?? 0) + 1;
          warmFailures.set(key, failures);
          if (failures < WARM_TRIES) warmTimer ??= setTimeout(() => ((warmTimer = undefined), void warmNext()), WARM_RETRY_MS);
          break;
        }
      }
    }
  })().finally(() => {
    warming = null;
  });
  return warming;
}

export const peekChatWindow = (scope: string, chatId: number): ChatWindow | undefined => windows.get(keyOf(scope, chatId));

export function watchChatWindow(scope: string, chatId: number, listener: () => void) {
  const key = keyOf(scope, chatId);
  let heard = listeners.get(key);
  if (!heard) listeners.set(key, (heard = new Set()));
  heard.add(listener);
  windows.retain(key);
  return () => {
    heard.delete(listener);
    if (!heard.size) listeners.delete(key);
    windows.release(key);
  };
}

export function useChatMessages(scope: string | null | undefined, chatId: number | null | undefined) {
  const key = scope && typeof chatId === "number" && chatId > 0 ? keyOf(scope, chatId) : null;
  const subscribe = useCallback((listener: () => void) => (key ? watchChatWindow(scope!, chatId!, listener) : () => {}), [key, scope, chatId]);
  const chat = useSyncExternalStore(subscribe, () => (key ? (windows.get(key) ?? EMPTY) : NONE));
  useEffect(() => {
    if (!key) return;
    follow();
    if (!windows.has(key) || windows.get(key)?.error) void load(scope!, chatId!);
  }, [key, scope, chatId]);
  return {
    ...chat,
    retry: useCallback(() => (key ? load(scope!, chatId!) : Promise.resolve()), [key, scope, chatId]),
    loadEarlier: useCallback(() => (key ? loadEarlier(scope!, chatId!) : Promise.resolve()), [key, scope, chatId]),
    loadAll: useCallback((signal?: AbortSignal) => (key ? loadAll(scope!, chatId!, signal) : Promise.resolve()), [key, scope, chatId]),
    trim: useCallback((canTrim: () => boolean) => (key ? trimChatWindow(scope!, chatId!, canTrim) : undefined), [key, scope, chatId]),
  };
}
