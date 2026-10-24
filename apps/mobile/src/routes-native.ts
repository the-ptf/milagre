import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import * as Network from "expo-network";
import { b64url } from "@milagre/shared/relay-crypto";
import { createRelayTransport } from "./relay-transport";
import { phoneIdentity, phoneRandom } from "./phone-identity";
import { phoneName } from "./phone-name-native";
import { createRouteSupervisor, PROBE_TIMEOUT, type RouteSupervisor } from "./routes";
import { lanRouteFromAnswer, type LanRoute } from "./lan-route";
import { savedHosts } from "./hosts-native";
import type { Client, RelayLink, RouteView } from "./client";

const CHECK_EVERY = 60_000;
type Entry = { token: string; lan: LanRoute | undefined; supervisor: RouteSupervisor };
const entries = new Map<string, Entry>();

/** Whether this address still answers as the Mac we paired with. No credentials go out. */
async function probe(endpoint: string, hostId: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
  try {
    const response = await fetch(`${endpoint.replace(/^ws:/, "http:")}/v1/hello`, { signal: controller.signal });
    if (!response.ok) return false;
    const body = (await response.json()) as { v?: unknown; hostId?: unknown };
    return body?.v === 1 && body.hostId === hostId;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function entry(id: string, token: string): Entry {
  const found = entries.get(id);
  if (found) {
    found.token = token;
    return found;
  }
  const created = { token, lan: undefined } as Entry;
  created.supervisor = createRouteSupervisor({
    lan: () => created.lan,
    probe,
    async openLan(endpoint, lan, onLost) {
      const identity = await phoneIdentity();
      const transport = createRelayTransport({
        relay: endpoint,
        hostId: lan.hostId,
        key: lan.key,
        token: created.token,
        identity,
        random: phoneRandom,
        name: phoneName,
        onLost,
      });
      try {
        await transport.ready();
      } catch (error) {
        transport.close();
        throw error;
      }
      return transport;
    },
  });
  entries.set(id, created);
  return created;
}

/** Each saved computer's LAN route: which transport carries it now, and when to look again. */
export const lanRoutes = {
  view(host: { id: string; token: string }): RouteView {
    const { supervisor } = entry(host.id, host.token);
    return {
      current: () => {
        const route = supervisor.current();
        return route.kind === "lan" ? route.transport : null;
      },
      subscribe: (listener) => supervisor.subscribe(() => listener()),
    };
  },
  set(id: string, token: string, lan: LanRoute | undefined) {
    const found = entry(id, token);
    found.lan = lan;
    void found.supervisor.check();
  },
  kind: (id: string): "lan" | "remote" => (entries.get(id)?.supervisor.current().kind === "lan" ? "lan" : "remote"),
  /** The IP the LAN route to this computer dialed, where its dev servers answer too; null off the LAN route. */
  address(id: string): string | null {
    const route = entries.get(id)?.supervisor.current();
    if (route?.kind !== "lan") return null;
    try {
      return new URL(route.endpoint).hostname.replace(/^\[|\]$/g, "") || null;
    } catch {
      return null;
    }
  },
  subscribe(id: string, listener: () => void) {
    return entry(id, entries.get(id)?.token ?? "").supervisor.subscribe(() => listener());
  },
  forget(id: string) {
    entries.get(id)?.supervisor.close();
    entries.delete(id);
  },
  checkAll() {
    for (const found of entries.values()) void found.supervisor.check();
  },
};

/**
 * Asks the Mac for its LAN route over the route this client already uses, and saves it. An older Mac, or the review
 * demo, refuses `phone:routes`: the computer keeps its paired route only.
 */
export async function learnRoutes(client: Client, host: { token: string; relay?: RelayLink }) {
  const identity = await phoneIdentity();
  let answer: unknown;
  try {
    answer = await client.call("phone:routes", [{ phoneKey: b64url(identity.publicKey) }]);
  } catch {
    return;
  }
  let lan = lanRouteFromAnswer(answer, Date.now());
  // A relay computer's LAN route must be the same Mac we pinned from its QR.
  if (lan && host.relay && (lan.key !== host.relay.key || lan.hostId !== host.relay.hostId)) lan = undefined;
  await savedHosts.learn(client.url, lan);
  lanRoutes.set(client.url, host.token, lan);
}

AppState.addEventListener("change", (state) => {
  if (state === "background") for (const found of entries.values()) found.supervisor.suspend();
  else if (state === "active") lanRoutes.checkAll();
});
Network.addNetworkStateListener(() => lanRoutes.checkAll());
setInterval(() => {
  if (AppState.currentState === "active") lanRoutes.checkAll();
}, CHECK_EVERY);

/** The address the phone reaches a computer's own servers on (lanRoutes.address), following its route as it changes. */
export function useReachableHost(id: string | null | undefined): string | null {
  return useSyncExternalStore(
    (listener) => (id ? lanRoutes.subscribe(id, listener) : () => {}),
    () => (id ? lanRoutes.address(id) : null),
  );
}
