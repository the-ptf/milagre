import { readWithTimeout } from "@milagre/shared/read-timeout";
import { rememberChat } from "./offline-cache.ts";
import { bridgeForKey, isRemoteKey } from "./computer-bridge.ts";
import { computerOfKey } from "@milagre/shared/chat-scopes";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { ChatMessage } from "../model.ts";
import type { MessageChanges } from "../electron.d.ts";
import { stateEvents } from "./state-events.ts";
import { ChatWindowCache, prependChatPage } from "@milagre/shared/chat-window-cache";

// The messages of the Chats on screen, from a host that keeps them by Chat (chat-pages-v1, #300): a window of each Chat's
// latest turns, read with readChatMessages, extended back on request and kept current from each change's messages.

export type ChatWindow = {
  messages: ChatMessage[];
  /** Whether the Chat has messages before the window. */
  hasMore: boolean;
  /** All of the Chat's messages, the window or not. */
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

function set(key: string, next: ChatWindow) {
  windows.set(key, next);
  // A copy: a listener can resubscribe while it is told, and a live Set would then be walked forever.
  for (const listener of Array.from(listeners.get(key) ?? [])) listener();
  // A remote chat's window is its computer's offline copy too.
  if (!next.loading && !next.error) {
    const at = key.lastIndexOf("#");
    rememberChat(key.slice(0, at), Number(key.slice(at + 1)), next);
  }
}

/** `messages` with `changes` for Chat `chatId` applied: a known message replaced, a new one placed after the one before it. */
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
    // A message after one the window doesn't hold belongs before the window, unless the window ends there.
    if (before < 0 && after !== null && current.hasMore && messages.length) continue;
    const place = before < 0 ? (after === null ? 0 : messages.length) : before + 1;
    messages = [...messages.slice(0, place), message, ...messages.slice(place)];
  }
  return messages === current.messages && total === current.total ? current : { ...current, messages, total };
}

const loads = new Map<string, Promise<void>>();
const earlierLoads = new Map<string, Promise<void>>();
// Reads whose page may predate a change that arrived while they were on their way: each reads again when it ends.
const stale = new Set<string>();
// Scopes whose open is on its way to their computer. A Chat's page read goes out before it, so it can reach a host that
// hasn't loaded the Project yet: that read waits for the open and reads once more instead of showing the error.
const openings = new Map<string, Promise<unknown>>();
const NOT_OPEN = /Open the Project before reading its messages/;

/** The open of `scope` is on its way (`opened` settles with it): a page read that finds it not open there yet reads again. */
export function noteScopeOpening(scope: string, opened: Promise<unknown>) {
  openings.set(scope, opened);
  const settled = () => {
    if (openings.get(scope) === opened) openings.delete(scope);
  };
  opened.then(settled, settled);
}

function readPage(scope: string, chatId: number) {
  // The call is made now, not a microtask later: a switch's open, sent right after, must not reach the host first.
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
/** A paired computer's chat paints from its last copy on this Mac while the computer's own answer is on its way. */
function recallRemote(scope: string, chatId: number, key: string) {
  if (!isRemoteKey(scope)) return;
  const recall = window.milagre.computers?.recall;
  if (!recall) return;
  void Promise.resolve(recall(computerOfKey(scope), { kind: "chat", scope, chatId }))
    .then((kept) => {
      // The computer answered first, or nobody wants the Chat any more.
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
        if (loads.get(key) !== loading) return;
        loads.delete(key);
        if (stale.delete(key)) void load(scope, chatId);
      });
    loads.set(key, loading);
  }
  return loading;
}

/** Reads the turns before the window; resolves once they're in. */
async function loadEarlier(scope: string, chatId: number, turns = TURNS) {
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
    });
  earlierLoads.set(key, request);
  return request;
}

/** Reads every message of the Chat (find in chat searches all of it). */
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
      // A reconnect's old read may never answer. Replace it now; only the current read may commit its result.
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
    // A read on its way may have been answered before a change to its Chat: it reads again (a new Chat's reply can beat
    // its first page).
    for (const key of loads.keys()) {
      if (!key.startsWith(`${scope}#`)) continue;
      const chatId = Number(key.slice(scope.length + 1));
      if (changes?.removed.length || changes?.changed.some(({ message }) => message.session_id === chatId)) stale.add(key);
    }
    // A copy: set() moves a window to the end of the Map, and walking the Map itself would reach it again.
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

// Each paired computer's most recent Chats are copied to this Mac in the background, so even the first open of one paints
// from its copy (recallRemote) instead of waiting on the other Mac. Only into the offline copy: the windows held in memory
// stay the Chats this window showed.
const WARM_PER_COMPUTER = 5;
const WARM_DELAY_MS = 2_000;
type WarmCandidate = { scope: string; chatId: number; lastAt: number; lastId: number };
const warmCandidates = new Map<string, Map<string, WarmCandidate>>();
const WARM_RETRY_MS = 30_000;
const WARM_TRIES = 3;
// Chats copied, or found current, since the window opened; and the failed tries of the rest.
const warmed = new Set<string>();
const warmFailures = new Map<string, number>();
let warmTimer: ReturnType<typeof setTimeout> | undefined;
let warming: Promise<void> | null = null;

/** A paired computer's Project state reached the window: its most recent Chats are copied to this Mac a moment later, one at a time. */
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
  // Not pushed back by later states: a streaming turn sends one many times a second.
  warmTimer ??= setTimeout(() => {
    warmTimer = undefined;
    void warmNext();
  }, delayMs);
}

function warmNext(): Promise<void> {
  // A read already going finishes first; then the latest candidates are walked again.
  if (warming) return warming.then(warmNext);
  warming = (async () => {
    for (const [computer, candidates] of warmCandidates) {
      const recent = [...candidates.entries()].sort(([, a], [, b]) => b.lastAt - a.lastAt).slice(0, WARM_PER_COMPUTER);
      for (const [key, { scope, chatId, lastId }] of recent) {
        if (warmed.has(key) || windows.has(key) || loads.has(key) || (warmFailures.get(key) ?? 0) >= WARM_TRIES) continue;
        warmed.add(key);
        try {
          // A copy that ends on the Chat's last message is current already.
          const kept = await window.milagre.computers?.recall?.(computer, { kind: "chat", scope, chatId });
          if ((kept?.messages.at(-1) as { id?: number } | undefined)?.id === lastId) continue;
          const page = await readWithTimeout(() => bridgeForKey(scope).readChatMessages(scope, chatId, { turns: TURNS }));
          // Opened meanwhile: its window keeps the copy itself.
          if (!windows.has(key)) rememberChat(scope, chatId, page);
        } catch {
          // The computer isn't reachable yet (a window opening before its route is up) or went away: tried again a
          // while later, a few times. The Chat reads on open as before meanwhile.
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

/** Chat `chatId`'s window as held now, without reading it. Exported for its tests. */
export const peekChatWindow = (scope: string, chatId: number): ChatWindow | undefined => windows.get(keyOf(scope, chatId));

/** The window of Chat `chatId`'s messages, read when first shown; none while `scope` or `chatId` is missing. */
export function useChatMessages(scope: string | null | undefined, chatId: number | null | undefined) {
  const key = scope && typeof chatId === "number" && chatId > 0 ? keyOf(scope, chatId) : null;
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
  };
}
