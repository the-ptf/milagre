import { useCallback, useSyncExternalStore } from "react";
import { AppState, View } from "react-native";
import { useSession } from "./session";
import { radius } from "./design-tokens";
import { useTheme } from "./theme";
import { useFloatingInbox } from "./floating-inbox-setting";
import { FloatingInboxChip } from "./inbox";

const NONE: string[] = [];
type AttentionClient = { attention: () => Promise<string[]> };
/**
 * One poller per computer, however many lists and pills read it: the first reader starts it, the last one to go stops
 * it. Each answer is kept with its computer, so switching computers never shows the last one's Chats.
 */
type Poller = { keys: string[]; readers: Set<() => void>; timer: ReturnType<typeof setInterval> | null; busy: boolean };
const pollers = new Map<AttentionClient, Poller>();
const POLL_MS = 5000;
function pollerOf(client: AttentionClient) {
  let poller = pollers.get(client);
  if (!poller) pollers.set(client, (poller = { keys: NONE, readers: new Set(), timer: null, busy: false }));
  return poller;
}
function load(client: AttentionClient, poller: Poller) {
  // One call at a time: on a busy Mac a slow answer would otherwise stack a new call every 5 s.
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
/** Chat keys, in every Project, whose turn waits on an approval or question. A Mac from before /attention gives none. */
// ponytail: polls every 5 s while the app is open; a live "attention" signal from the bridge if this ever costs too much.
export function useAttention(): string[] {
  const { client } = useSession();
  const subscribe = useCallback((reader: () => void) => (client ? subscribeAttention(client, reader) : () => {}), [client]);
  return useSyncExternalStore(subscribe, () => (client ? (pollers.get(client)?.keys ?? NONE) : NONE));
}

export function AttentionDot() {
  const { colors } = useTheme();
  return <View accessibilityLabel="Needs attention" style={{ width: 8, height: 8, borderRadius: radius.full, backgroundColor: colors.orange }} />;
}

/**
 * Under the header's right edge, while the experimental floating inbox is on: its chip. (The "N waiting" pill that sat
 * here is gone; waiting Chats show in the list and in notifications.)
 */
export function FloatingInboxSlot({ bottom }: { bottom?: number }) {
  const { client } = useSession();
  const [floatingInbox] = useFloatingInbox();
  return floatingInbox && client ? <FloatingInboxChip bottom={bottom} /> : null;
}
