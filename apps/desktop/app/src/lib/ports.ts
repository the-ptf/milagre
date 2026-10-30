import { createContext, useEffect, useRef, useState } from "react";
import { LOCAL_COMPUTER } from "@milagre/shared/chat-scopes";
import type { AgentPort, AgentPorts } from "../model";
import { keepComputers, replaceComputerEntries } from "./agent-runs";
import { bridgeFor } from "./computer-bridge";
import { listensBeyondLoopback, reachableUrl } from "@milagre/shared/loopback-url";
import { computerAddressOf, computerNameOf, useComputers } from "./computers";
import { thisComputer } from "./shortcut-hints.ts";

/**
 * Where a port opens in the browser. This Mac's at localhost (a server bound only to IPv6 loopback needs its address);
 * another computer's at the IP its LAN route dialed, when the server listens beyond loopback; null when this Mac can't
 * reach it.
 */
export function portUrl(port: AgentPort): string | null {
  if (!port.computerId) return `http://${port.address === "::1" ? "[::1]" : "localhost"}:${port.port}`;
  const address = computerAddressOf(port.computerId);
  return address && listensBeyondLoopback(port.address) ? reachableUrl(`http://localhost:${port.port}`, address) : null;
}

/** The Chat's ports that listen on loopback alone (loopbackOnlyPorts, from ChatComposer): a reply link to one stays localhost. */
export const LoopbackPortsContext = createContext<ReadonlySet<number>>(new Set());

/** Why another computer's port has no link here, for its title. */
export function unreachablePortReason(port: AgentPort, computer: string): string {
  if (!computerAddressOf(port.computerId)) return `Listening on ${computer}, which ${thisComputer} reaches through the relay only`;
  return `Listening on ${computer}'s localhost only. Start it on 0.0.0.0 to open it from here`;
}

/** A computer's ports, marked with it: their `localhost` is not this Mac's. */
const tagged = (computerId: string, next: AgentPorts): AgentPorts =>
  Object.fromEntries(Object.entries(next ?? {}).map(([key, list]) => [key, Array.isArray(list) ? list.map((port) => ({ ...port, computerId })) : list]));

/** Where a port listens when it isn't this Mac: "studio", else null. */
export const portComputer = (port: AgentPort) => (port.computerId ? computerNameOf(port.computerId) : null);

/** Every chat's listening ports, by chat key, on this Mac and on each paired computer. */
export function useAgentPorts() {
  const [ports, setPorts] = useState<AgentPorts>({});
  // Per computer, how many pushed updates have landed: a getAgentPorts() answer older than one of them is stale.
  const pushed = useRef(new Map<string, number>());
  useEffect(() => {
    // An update that arrives first is newer than the snapshot.
    let live = true;
    let updated = false;
    const mine = (next: AgentPorts) => setPorts((current) => replaceComputerEntries(current, LOCAL_COMPUTER, next));
    const unsubscribe = window.milagre.onAgentPorts((next) => {
      updated = true;
      mine(next);
    });
    const recover = window.milagre.onRuntimeSnapshot?.((snapshot) => {
      updated = true;
      mine(snapshot.ports);
    });
    // A computer's ports arrive keyed by its chat keys (computer-routing.cjs); each replaces only that computer's.
    const remote = window.milagre.onComputerEvent?.((event) => {
      const next = event.channel === "agent:ports" ? event.payload : event.channel === "runtime:snapshot" ? event.payload?.ports : null;
      if (next) pushed.current.set(event.computerId, (pushed.current.get(event.computerId) ?? 0) + 1);
      if (next) setPorts((current) => replaceComputerEntries(current, event.computerId, tagged(event.computerId, next)));
    });
    void window.milagre
      .getAgentPorts()
      .then((next) => {
        // oxlint-disable-next-line promise/no-callback-in-promise -- the handler receives the resolved value, not a Node-style callback
        if (live && !updated) mine(next);
      })
      .catch(() => {});
    return () => {
      live = false;
      unsubscribe();
      recover?.();
      remote?.();
    };
  }, []);
  // A computer that comes online is asked for its ports (its runtime's first connection sends no snapshot); one that
  // is removed, or every one once Other computers is off, takes its ports with it.
  const { computers } = useComputers();
  const online = computers
    .filter((computer) => computer.state === "online")
    .map((computer) => computer.id)
    .join("\n");
  const known = computers.map((computer) => computer.id).join("\n");
  useEffect(() => {
    let live = true;
    for (const id of online.split("\n").filter(Boolean)) {
      const asked = pushed.current.get(id) ?? 0;
      void bridgeFor(id)
        .getAgentPorts()
        .then((next) => {
          // oxlint-disable-next-line promise/no-callback-in-promise -- the handler receives the resolved value, not a Node-style callback
          if (live && (pushed.current.get(id) ?? 0) === asked) setPorts((current) => replaceComputerEntries(current, id, tagged(id, next)));
        })
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [online]);
  useEffect(() => {
    const ids = new Set(known.split("\n").filter(Boolean));
    setPorts((current) => keepComputers(current, ids));
  }, [known]);
  return ports;
}
