import { computerOfKey } from "@milagre/shared/chat-scopes";
import { isRemoteKey } from "./computer-bridge.ts";
import { stateEvents } from "./state-events.ts";

// A paired computer's states and chat windows, forwarded to main as they change so its last copy can be read while it
// is away (spec "Offline cache"). Held back per key: a streaming turn changes a state many times a second.
const DELAY_MS = 3000;
const timers = new Map<string, { computerId: string; timer: ReturnType<typeof setTimeout> }>();
function later(computerId: string, key: string, write: () => void) {
  clearTimeout(timers.get(key)?.timer);
  timers.set(key, {
    computerId,
    timer: setTimeout(() => {
      timers.delete(key);
      write();
    }, DELAY_MS),
  });
}
/** A computer that was removed keeps nothing waiting to be written. */
function dropUnpaired(paired: Set<string>) {
  for (const [key, pending] of timers)
    if (!paired.has(pending.computerId)) {
      clearTimeout(pending.timer);
      timers.delete(key);
    }
}
const remember = (scope: string, entry: Parameters<typeof window.milagre.computers.remember>[1]) =>
  void Promise.resolve(window.milagre.computers?.remember?.(computerOfKey(scope), entry)).catch(() => {});

function rememberState(scope: string, state: unknown) {
  if (!isRemoteKey(scope) || !state) return;
  later(computerOfKey(scope), `state\n${scope}`, () => remember(scope, { kind: "state", scope, state }));
}
export function rememberChat(scope: string, chatId: number, chat: { messages: unknown[]; hasMore: boolean; total: number }) {
  if (!isRemoteKey(scope)) return;
  later(computerOfKey(scope), `chat\n${scope}#${chatId}`, () =>
    remember(scope, { kind: "chat", scope, chatId, window: { messages: chat.messages, hasMore: chat.hasMore, total: chat.total } }),
  );
}
/** A line about a remote scope for the host's daemon.log: the window keeps no log of its own. */
export function noteComputer(scope: string, line: string) {
  if (!isRemoteKey(scope)) return;
  void Promise.resolve(window.milagre.computers?.note?.(computerOfKey(scope), line)).catch(() => {});
}
let started = false;
/** Follows every remote scope's state; App starts it once. */
export function startOfflineCache() {
  if (started) return;
  started = true;
  window.milagre.onComputersChanged?.((snapshot) => dropUnpaired(new Set(snapshot.computers.map((computer) => computer.id))));
  stateEvents.onProjectState(({ path, state }) => rememberState(path, state));
  stateEvents.onLinkState(({ linkId, state }) => rememberState(`milagre-link:${linkId}`, state));
}
