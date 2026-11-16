import { createContext, useEffect, useRef, useState } from "react";
import { LOCAL_COMPUTER } from "@milagre/shared/chat-scopes";
import type { AgentPort, AgentPorts } from "../model";
import { keepComputers, replaceComputerEntries } from "./agent-runs";
import { bridgeFor } from "./computer-bridge";
import { listensBeyondLoopback, reachableUrl } from "@milagre/shared/loopback-url";
import { computerAddressOf, computerNameOf, useComputers } from "./computers";
import { thisComputer } from "./shortcut-hints.ts";

export function portUrl(port: AgentPort): string | null {
  if (!port.computerId) return `http://${port.address === "::1" ? "[::1]" : "localhost"}:${port.port}`;
  const address = computerAddressOf(port.computerId);
  return address && listensBeyondLoopback(port.address) ? reachableUrl(`http://localhost:${port.port}`, address) : null;
}

export const LoopbackPortsContext = createContext<ReadonlySet<number>>(new Set());

export function unreachablePortReason(port: AgentPort, computer: string): string {
  if (!computerAddressOf(port.computerId)) return `Listening on ${computer}, which ${thisComputer} reaches through the relay only`;
  return `Listening on ${computer}'s localhost only. Start it on 0.0.0.0 to open it from here`;
}

const tagged = (computerId: string, next: AgentPorts): AgentPorts =>
  Object.fromEntries(Object.entries(next ?? {}).map(([key, list]) => [key, Array.isArray(list) ? list.map((port) => ({ ...port, computerId })) : list]));

export const portComputer = (port: AgentPort) => (port.computerId ? computerNameOf(port.computerId) : null);

export function useAgentPorts() {
  const [ports, setPorts] = useState<AgentPorts>({});
  const pushed = useRef(new Map<string, number>());
  useEffect(() => {
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
