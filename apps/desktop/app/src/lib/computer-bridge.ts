import { createContext, useContext } from "react";
import { LOCAL_COMPUTER, computerOfKey } from "@milagre/shared/chat-scopes";
import type { MilagreBridge } from "../electron";

type AgentEventPayload = Parameters<Parameters<MilagreBridge["onAgentEvent"]>[0]>[0];

const remotes = new Map<string, MilagreBridge>();

/** One computer's calls (spec "Routing"): this Mac's window.milagre, or a paired computer's, carried there by main. */
export function bridgeFor(computerId: string | null | undefined): MilagreBridge {
  if (!computerId || computerId === LOCAL_COMPUTER) return window.milagre;
  let bridge = remotes.get(computerId);
  if (!bridge) {
    bridge = window.milagre.on(computerId);
    remotes.set(computerId, bridge);
  }
  return bridge;
}

/** The calls of the computer a scope or chat key belongs to. */
export const bridgeForKey = (key: string | null | undefined) => bridgeFor(key ? computerOfKey(key) : LOCAL_COMPUTER);

/** Whether a scope or chat key is another Mac's. */
export const isRemoteKey = (key: string | null | undefined) => Boolean(key) && computerOfKey(key!) !== LOCAL_COMPUTER;

/** Drops a removed computer's bridge. */
export function forgetBridge(computerId: string) {
  remotes.delete(computerId);
}

/** The bridge of the Project or Link on screen, which App provides; this Mac's anywhere else. */
export const BridgeContext = createContext<MilagreBridge | null>(null);
export function useBridge(): MilagreBridge {
  return useContext(BridgeContext) ?? window.milagre;
}

/** The scope key of the Project or Link on screen, which App and LinkWorkspace provide. */
export const ScopeContext = createContext<string | null>(null);
export const useScope = () => useContext(ScopeContext);

/** Agent events from this Mac and from every paired computer, raw (keys already name their computer). */
export function onAnyAgentEvent(callback: (payload: AgentEventPayload) => void) {
  const offLocal = window.milagre.onAgentEvent?.(callback);
  const offRemote = window.milagre.onComputerEvent?.((event) => {
    if (event.channel === "agent:event") callback(event.payload);
  });
  return () => {
    offLocal?.();
    offRemote?.();
  };
}

/** Connection metadata comes from this Mac, even when the reader belongs to a paired computer. */
export function onComputerConnection(key: string, reconnect: () => void, removed: () => void) {
  const computerId = computerOfKey(key);
  let online = false;
  let unsubscribe: (() => void) | undefined;
  unsubscribe = window.milagre.onComputersChanged?.(({ computers }) => {
    const computer = computers.find((computer) => computer.id === computerId);
    if (!computer) {
      unsubscribe?.();
      removed();
      return;
    }
    const next = computer.state === "online";
    if (next && !online) reconnect();
    online = next;
  });
  return () => unsubscribe?.();
}
