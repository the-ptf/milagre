import { useCallback, useSyncExternalStore } from "react";
import { AppState, View } from "react-native";
import { useSession } from "./session";
import { radius } from "./design-tokens";
import { useTheme } from "./theme";
import { useFloatingInbox } from "./floating-inbox-setting";
import { FloatingInboxChip } from "./inbox";

const NONE: string[] = [];
type AttentionClient = { attention: () => Promise<string[]> };
type Poller = { keys: string[]; readers: Set<() => void>; timer: ReturnType<typeof setInterval> | null; busy: boolean };
const pollers = new Map<AttentionClient, Poller>();
const POLL_MS = 5000;
function pollerOf(client: AttentionClient) {
  let poller = pollers.get(client);
  if (!poller) pollers.set(client, (poller = { keys: NONE, readers: new Set(), timer: null, busy: false }));
  return poller;
}
function load(client: AttentionClient, poller: Poller) {
  if (poller.busy || AppState.currentState !== "active") return;
  poller.busy = true;
  client
    .attention()
    .then(
      (keys) => {
        if (pollers.get(client) !== poller || poller.keys.join("\n") === keys.join("\n")) return;
        poller.keys = keys;
        for (const reader of Array.from(poller.readers)) reader();
      },
      () => {},
    )
    .finally(() => {
      poller.busy = false;
    });
}
function subscribeAttention(client: AttentionClient, reader: () => void) {
  const poller = pollerOf(client);
  poller.readers.add(reader);
  if (!poller.timer) {
    load(client, poller);
    poller.timer = setInterval(() => load(client, poller), POLL_MS);
  }
  return () => {
    poller.readers.delete(reader);
    if (poller.readers.size) return;
    if (poller.timer) clearInterval(poller.timer);
    pollers.delete(client);
  };
}
export function useAttention(): string[] {
  const { client } = useSession();
  const subscribe = useCallback((reader: () => void) => (client ? subscribeAttention(client, reader) : () => {}), [client]);
  return useSyncExternalStore(subscribe, () => (client ? (pollers.get(client)?.keys ?? NONE) : NONE));
}

export function AttentionDot() {
  const { colors } = useTheme();
  return <View accessibilityLabel="Needs attention" style={{ width: 8, height: 8, borderRadius: radius.full, backgroundColor: colors.orange }} />;
}

export function FloatingInboxSlot({ bottom }: { bottom?: number }) {
  const { client } = useSession();
  const [floatingInbox] = useFloatingInbox();
  return floatingInbox && client ? <FloatingInboxChip bottom={bottom} /> : null;
}
