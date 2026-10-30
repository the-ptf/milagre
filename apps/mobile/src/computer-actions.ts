import { outbox } from "./outbox";
import { Alert } from "react-native";
import { createClient } from "./client";
import { nativeActivity } from "./live-activity-native";
import { savedHosts } from "./hosts-native";
import { confirmSheet } from "./confirm-store";
import { relayRuntime } from "./relay-native";
import { lanRoutes } from "./routes-native";
import { seenAgo } from "./seen-ago";
import type { SavedHost } from "./hosts-store";
import type { usePush } from "./push";
import type { useSession } from "./session";

export type Reachability = "online" | "checking" | "offline";

/** Whether the computer answers right now; a failure of any kind counts as offline. */
export async function pingComputer(host: SavedHost): Promise<Reachability> {
  try {
    await createClient(host, fetch, 5000, relayRuntime).call("daemon:status");
    return "online";
  } catch {
    return "offline";
  }
}

/** Desktops get the monitor icon, laptops the laptop. */
export const isDesktopComputer = (name: string) => /studio|mini|imac/i.test(name);

/** How the phone reaches the computer: the local network when that route is up, else the relay or the address. */
export function routeLabel(host: SavedHost, reachability: Reachability): string {
  if (reachability === "online" && lanRoutes.kind(host.id) === "lan") return "Local network";
  return host.relay ? host.relay.url.replace(/^wss:\/\//, "") : host.address.replace(/^https?:\/\//, "");
}

/** The second line of a computer row: its route while it answers, else when this phone last saw it. */
export function statusLine(host: SavedHost, reachability: Reachability, now = Date.now()): string {
  if (reachability === "online") return `Connected · ${routeLabel(host, reachability)}`;
  if (reachability === "checking") return "Checking…";
  const seen = seenAgo(host.lastUsed, now);
  return seen ? `Offline · ${seen}` : "Offline";
}

type Session = Pick<ReturnType<typeof useSession>, "cancelNavigation" | "client" | "disconnect">;
type Push = Pick<ReturnType<typeof usePush>, "forget">;

/**
 * Asks, then forgets the computer: its push registration and Live Activity end, its saved pairing goes, and so do the
 * relay and local-network routes the phone learned. A computer the phone is connected to is disconnected first.
 */
export function forgetComputer(
  host: SavedHost,
  { session, push, onForgotten, onError }: { session: Session; push: Push; onForgotten?: () => unknown; onError: (message: string) => void },
) {
  const waiting = outbox.getSnapshot().items.filter((item) => item.computerId === host.id && item.status !== "sent");
  const discarded = waiting.length
    ? ` ${waiting.length === 1 ? "1 message" : `${waiting.length} messages`} waiting on this device for it will be discarded.`
    : "";
  confirmSheet(`Forget ${host.name}?`, `You will need to scan its code again to reconnect.${discarded}`, [
    { text: "Cancel", style: "cancel" },
    {
      text: "Forget",
      style: "destructive",
      onPress: () => {
        session.cancelNavigation();
        if (session.client?.url === host.address) session.disconnect();
        const forget = async () => {
          try {
            await push.forget(host);
            await nativeActivity?.endAsync(host.id);
            await savedHosts.forget(host.id);
            if (host.relay) relayRuntime.forget(host.relay.hostId);
            lanRoutes.forget(host.id);
            await Promise.allSettled(waiting.map((item) => outbox.remove(item.id)));
            await onForgotten?.();
          } catch (e) {
            onError((e as Error).message);
          }
        };
        void forget();
      },
    },
  ]);
}

/** Asks for a new name and saves it. */
export function renameComputer(host: SavedHost, { onRenamed, onError }: { onRenamed?: () => unknown; onError: (message: string) => void }) {
  const save = async (name: string) => {
    try {
      await savedHosts.rename(host.id, name);
      await onRenamed?.();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  Alert.prompt("Rename computer", undefined, (name) => void save(name), "plain-text", host.name);
}
