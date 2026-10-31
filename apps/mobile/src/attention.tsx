import { useCallback, useSyncExternalStore } from "react";
import { AppState, Pressable, StyleSheet, Text, View } from "react-native";
import { BlurView } from "@sbaiahmed1/react-native-blur";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { projectOfKey, sessionIdFromKey } from "@milagre/shared/agent-runs";
import { chatTitle } from "@milagre/shared/chats";
import { attentionLabel } from "@milagre/shared/attention";
import { readAttentionButton, saveAttentionButton } from "./hosts-native";
import { useSession } from "./session";
import { radius } from "./design-tokens";
import { Icon } from "./icons";
import { PullDown } from "./ui";
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

// The phone's "Attention button" setting, read once and shared by Settings and every Chat.
let showButton = true;
const listeners = new Set<() => void>();
void readAttentionButton().then((on) => {
  showButton = on;
  listeners.forEach((listener) => listener());
});
export function useAttentionButton(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => showButton,
  );
  return [
    on,
    (next) => {
      showButton = next;
      listeners.forEach((listener) => listener());
      void saveAttentionButton(next);
    },
  ];
}

export function AttentionDot() {
  const { colors } = useTheme();
  return <View accessibilityLabel="Needs attention" style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.orange }} />;
}

/** Under the header's right edge. One waiting Chat opens on tap; several open a menu to pick one, oldest first. */
export function AttentionPill({ currentChat, visibleChat, bottom }: { currentChat?: string; visibleChat?: string; bottom?: number }) {
  const { colors, scheme } = useTheme();
  const { client, recent, cachedProject, snapshot } = useSession();
  const insets = useSafeAreaInsets();
  const [enabled] = useAttentionButton();
  const [floatingInbox] = useFloatingInbox();
  // Skip the open Chat and Projects hidden from the list.
  const waiting = useAttention().filter((key) => key !== currentChat && key !== visibleChat && !recent.find((item) => item.path === projectOfKey(key))?.hidden);
  if (floatingInbox && client) return <FloatingInboxChip bottom={bottom} />;
  if (!enabled || !waiting.length || !client) return null;
  const name = (path: string) => recent.find((item) => item.path === path)?.name || path.split("/").at(-1) || "Project";
  // A Project the phone hasn't loaded yet has no titles here, so its rows read "Chat".
  const items = waiting.map((key) => {
    const path = projectOfKey(key);
    const state = (snapshot?.project.path === path ? snapshot : cachedProject(path))?.project.state;
    const chat = state?.sessions[sessionIdFromKey(key)];
    return {
      id: key,
      title: chat
        ? chatTitle(
            chat,
            state?.messages.filter((message) => message.session_id === chat.id),
          )
        : "Chat",
      subtitle: name(projectOfKey(key)),
    };
  });
  const label = attentionLabel(items.map((item) => item.title));
  const open = (key: string) =>
    router.replace({ pathname: "/chat", params: { projectPath: projectOfKey(key), hostId: client.url, id: String(sessionIdFromKey(key)) } });
  const pill = (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        minHeight: 32,
        paddingHorizontal: 12,
        borderRadius: radius.full,
        borderCurve: "continuous",
        overflow: "hidden",
      }}
    >
      <BlurView
        pointerEvents="none"
        blurType={scheme === "dark" ? "systemThickMaterialDark" : "systemThickMaterialLight"}
        blurAmount={32}
        reducedTransparencyFallbackColor={colors.surface}
        style={StyleSheet.absoluteFill}
      />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: colors.orangeTint }]} />
      <Text numberOfLines={1} style={{ color: colors.orangeInk, fontSize: 13, fontWeight: "600", maxWidth: 220 }}>
        {label}
      </Text>
      <Icon icon={waiting.length > 1 ? ArrowDown01Icon : ArrowRight01Icon} tone="orange" size={14} strokeWidth={2} />
    </View>
  );
  const place = { position: "absolute" as const, top: insets.top + 52, right: 12 };
  const first = waiting[0];
  if (waiting.length === 1 && first)
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}. Open the Chat.`}
        onPress={() => open(first)}
        hitSlop={{ top: 6, bottom: 6 }}
        style={({ pressed }) => [place, pressed && { transform: [{ scale: 0.97 }] }]}
      >
        {pill}
      </Pressable>
    );
  return (
    <PullDown label={`${label}. Choose a Chat.`} title="Waiting for you" sections={[{ items }]} onSelect={open} style={place}>
      {pill}
    </PullDown>
  );
}
