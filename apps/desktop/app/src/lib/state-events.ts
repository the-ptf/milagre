import { applyStatePatch } from "@milagre/shared/state-patch";
import { projectOfKey } from "@milagre/shared/agent-runs";
import { isLinkScopeKey, scopeKey } from "@milagre/shared/chat-scopes";
import { bridgeForKey } from "./computer-bridge.ts";
import type { StatePatch } from "@milagre/shared/state-patch";
import type { AgentEvent, CoordinatorState, LinkState } from "../model.ts";
import type { MessageChanges } from "../electron.d.ts";

// A host that sends state patches (state-patches-v1) puts what changed in a state event in place of the whole state,
// which runs to megabytes in a large Project: `patch`, made from the state numbered `base`, gives the one numbered
// `version`. This keeps the last state of each Project and Link, applies each patch to it, and hands the window whole
// states as before; every listener gets the same object. A missed number, a new host (`epoch`) or `resync` reads the
// state again with state:read. Events from an older host carry whole states and pass through.

type AnyState = CoordinatorState | LinkState;
type Numbered = { patch?: StatePatch; base?: number; version?: number; epoch?: string; resync?: boolean; messages?: MessageChanges };
/** A change to the messages of a scope's Chats, or `reset` when they must be read again (a missed change, a new host). */
export type MessagesUpdate = { scope: string; changes?: MessageChanges; reset?: boolean };

/**
 * Whether a state comes from a host that keeps messages by Chat (chat-pages-v1): its `messages` is empty, and the Chats
 * on screen read theirs with window.milagre.readChatMessages (see chat-messages.ts).
 */
export const isLean = (state: { messagesInChats?: boolean } | null | undefined) => state?.messagesInChats === true;
export type ProjectStateUpdate = { path: string; state: CoordinatorState };
export type LinkStateUpdate = { linkId: string; state: LinkState };
export type AgentEventUpdate = { chatId: string; event: AgentEvent; state?: AnyState; seq?: number };

const held = new Map<string, { epoch: string; version: number; state: AnyState }>();
// Scopes being read again, with the patches that arrived meanwhile and the agent events held back: a turn's end
// removes its run, so it waits for the state with its saved reply and both reach the window together.
type HeldEvent = { event: Omit<AgentEventUpdate, "state">; withState: boolean };
const reading = new Map<string, { patches: Numbered[]; events: HeldEvent[] }>();
const projectListeners = new Set<(update: ProjectStateUpdate) => void>();
const linkListeners = new Set<(update: LinkStateUpdate) => void>();
const agentListeners = new Set<(update: AgentEventUpdate) => void>();
const messageListeners = new Set<(update: MessagesUpdate) => void>();
let subscribed = false;

const linkPrefix = "milagre-link:";
const READ_TIMEOUT_MS = 3000;
const numbered = (payload: Numbered) => typeof payload.version === "number" && typeof payload.epoch === "string";

/** The state an event's patch gives, or null while the scope is read again (which then announces the state itself). */
function stateFor(scope: string, payload: Numbered): AnyState | null {
  const pending = reading.get(scope);
  if (pending) {
    pending.patches.push(payload);
    return null;
  }
  const last = held.get(scope);
  if (payload.resync || !last || last.epoch !== payload.epoch || last.version !== payload.base) {
    void readAgain(scope, payload);
    return null;
  }
  const state = applyStatePatch(last.state, payload.patch);
  held.set(scope, { epoch: payload.epoch!, version: payload.version!, state });
  if (payload.messages && (payload.messages.changed.length || payload.messages.removed.length))
    for (const listener of messageListeners) listener({ scope, changes: payload.messages });
  return state;
}

async function readAgain(scope: string, first: Numbered) {
  const pending = { patches: [first], events: [] as HeldEvent[] };
  const queue = pending.patches;
  reading.set(scope, pending);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      // A read that doesn't answer soon gives up: the events held back behind it (a turn streaming) must not wait on it.
      const read = await Promise.race([
        bridgeForKey(scope).readState(scope),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("The state read took too long")), READ_TIMEOUT_MS)),
      ]);
      const current = { epoch: read.epoch, version: read.version, state: read.state as AnyState };
      let gap = false;
      // What arrived during the read: older patches are in the state read; newer ones follow it in order.
      for (const payload of queue.splice(0)) {
        if (payload.epoch !== current.epoch || payload.version! <= current.version) continue;
        if (payload.resync || payload.base !== current.version) {
          gap = true;
          break;
        }
        current.state = applyStatePatch(current.state, payload.patch);
        current.version = payload.version!;
      }
      if (gap) continue;
      held.set(scope, current);
      reading.delete(scope);
      // Message changes in the gap are lost: the Chats shown read their messages again.
      if (isLean(current.state)) for (const listener of messageListeners) listener({ scope, reset: true });
      for (const { event, withState } of pending.events)
        for (const listener of agentListeners) listener(withState ? { ...event, state: current.state } : event);
      announce(scope, current.state);
      return;
    }
  } catch {
    // The next state event reads it again.
  }
  held.delete(scope);
  reading.delete(scope);
  for (const { event } of pending.events) for (const listener of agentListeners) listener(event);
}

function announce(scope: string, state: AnyState) {
  if (isLinkScopeKey(scope)) for (const listener of linkListeners) listener({ linkId: scope.slice(linkPrefix.length), state: state as LinkState });
  else for (const listener of projectListeners) listener({ path: scope, state: state as CoordinatorState });
}

function subscribe() {
  if (subscribed) return;
  subscribed = true;
  const project = (update: { path: string; state?: CoordinatorState } & Numbered) => {
    if (!numbered(update)) {
      held.delete(update.path);
      if (update.state) for (const listener of projectListeners) listener({ path: update.path, state: update.state });
      return;
    }
    const state = stateFor(update.path, update);
    if (state) for (const listener of projectListeners) listener({ path: update.path, state: state as CoordinatorState });
  };
  const link = (update: { linkId: string; state?: LinkState } & Numbered) => {
    const scope = scopeKey({ kind: "link", linkId: update.linkId });
    if (!numbered(update)) {
      held.delete(scope);
      if (update.state) for (const listener of linkListeners) listener({ linkId: update.linkId, state: update.state });
      return;
    }
    const state = stateFor(scope, update);
    if (state) for (const listener of linkListeners) listener({ linkId: update.linkId, state: state as LinkState });
  };
  const agent = (update: AgentEventUpdate & Numbered) => {
    const { patch: _patch, base: _base, version: _version, epoch: _epoch, resync: _resync, state: whole, ...event } = update;
    const scope = projectOfKey(update.chatId);
    // While its scope is read again, a chat's events wait their turn behind the ones held back.
    const pending = scope ? reading.get(scope) : undefined;
    if (pending) {
      if (numbered(update)) pending.patches.push(update);
      pending.events.push({ event, withState: numbered(update) });
      return;
    }
    let state = whole;
    if (numbered(update) && scope) {
      state = stateFor(scope, update) ?? undefined;
      if (!state) {
        reading.get(scope)?.events.push({ event, withState: true });
        return;
      }
    } else if (scope && state) held.delete(scope);
    for (const listener of agentListeners) listener({ ...event, ...(state ? { state } : {}) });
  };
  window.milagre.onProjectState?.(project);
  window.milagre.onLinkState?.(link);
  window.milagre.onAgentEvent?.(agent);
  // A paired computer's events arrive with keys that name it (computer-routing.cjs), so its scopes keep apart from this Mac's.
  window.milagre.onComputerEvent?.((event) => {
    if (event.channel === "project:state") project(event.payload);
    else if (event.channel === "link:state") link(event.payload);
    else if (event.channel === "agent:event") agent(event.payload);
  });
}

function listen<T>(listeners: Set<T>, listener: T) {
  subscribe();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Like window.milagre's listeners, with whole states whether the host sends them or patches. */
export const stateEvents = {
  onProjectState: (listener: (update: ProjectStateUpdate) => void) => listen(projectListeners, listener),
  onLinkState: (listener: (update: LinkStateUpdate) => void) => listen(linkListeners, listener),
  onAgentEvent: (listener: (update: AgentEventUpdate) => void) => listen(agentListeners, listener),
  /** The messages each change adds, changes or removes, from a host that keeps them by Chat. */
  onMessages: (listener: (update: MessagesUpdate) => void) => listen(messageListeners, listener),
};
