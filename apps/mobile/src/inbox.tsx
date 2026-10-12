import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Pressable, Text, View, Keyboard, type ScrollView } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useSafeAreaFrame, useSafeAreaInsets } from "react-native-safe-area-context";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { sessionIdFromKey } from "@milagre/shared/agent-runs";
import { providerName } from "@milagre/shared/providers";
import type { InboxItem, InboxSnapshot, InboxStatus } from "@milagre/shared/attention";
import { visibleInbox } from "@milagre/shared/attention";
import { useFloatingInboxActivity } from "./floating-inbox-setting";
import { FloatingInboxButton, floatingInboxStatus } from "./floating-inbox-button";
import { useSession } from "./session";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useReducedMotion } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { InboxPage, InboxPager, INBOX_LAYOUT } from "./inbox-motion";
import { ProviderLogo, SpinnerRing } from "./icons";
import { Approval, Questions, type InboxQuestionDraft } from "./questions";
import { useTheme } from "./theme";
import { GlassIconButton, ErrorNotice, PageScroll, PillButton, useStyles } from "./ui";

const EMPTY: InboxSnapshot = { agents: [], items: [] };
const needsYou = (item: InboxItem) => item.status === "approval" || item.status === "question";

function usePhoneInbox() {
  const [activity] = useFloatingInboxActivity();
  const { client } = useSession();
  const [loaded, setLoaded] = useState<{
    client: typeof client;
    snapshot: InboxSnapshot;
    error: string;
  } | null>(null);
  const refresh = useRef<() => void>(() => {});
  useFocusEffect(
    useCallback(() => {
      if (!client) return;
      let live = true,
        busy = false,
        again = false;
      const load = async () => {
        if (!live || AppState.currentState !== "active") return;
        if (busy) {
          again = true;
          return;
        }
        busy = true;
        try {
          const snapshot = await client.inbox();
          if (live)
            setLoaded((previous) =>
              previous?.client === client && !previous.error && JSON.stringify(previous.snapshot) === JSON.stringify(snapshot)
                ? previous
                : { client, snapshot, error: "" },
            );
        } catch (failure) {
          if (live)
            setLoaded({
              client,
              snapshot: EMPTY,
              error: failure instanceof Error ? failure.message : "Could not load the inbox.",
            });
        } finally {
          busy = false;
          if (again) {
            again = false;
            void load();
          }
        }
      };
      refresh.current = () => void load();
      void load();
      const timer = setInterval(() => void load(), 3000);
      const subscription = AppState.addEventListener("change", () => void load());
      return () => {
        live = false;
        refresh.current = () => {};
        clearInterval(timer);
        subscription.remove();
      };
    }, [client]),
  );
  const current = loaded?.client === client ? loaded : null;
  return {
    client,
    snapshot: visibleInbox(current?.snapshot ?? EMPTY, activity),
    error: current?.error ?? "",
    loading: !!client && !current,
    refresh: () => refresh.current(),
  };
}

function InboxDot({ status, monochrome = false }: { status: InboxStatus; monochrome?: boolean }) {
  const { colors, scheme } = useTheme();
  const reduced = useReducedMotion();
  const color = monochrome
    ? scheme === "dark"
      ? "#fff"
      : "#000"
    : status === "working"
      ? colors.accent
      : status === "completed"
        ? colors.green
        : status === "failed"
          ? colors.red
          : status === "question"
            ? colors.accentInk
            : colors.orange;
  if (status === "working" && !reduced) return <SpinnerRing size={11} stroke={1.5} tone="accent" color={monochrome ? color : undefined} />;
  return <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: color }} />;
}

const statusWords = (status: InboxStatus) =>
  status === "question"
    ? "Waiting for your answer"
    : status === "approval"
      ? "Waiting for approval"
      : status === "working"
        ? "Working"
        : status === "failed"
          ? "Failed"
          : "Finished";

export function FloatingInboxChip({ bottom }: { bottom?: number }) {
  const { snapshot, client } = usePhoneInbox();
  const status = floatingInboxStatus(snapshot.agents);
  const firstKey = snapshot.items.find((item) => item.status === status)?.key;
  const hostId = client?.url;
  const open = useCallback(
    () =>
      router.push({
        pathname: "/inbox",
        params: { hostId, ...(firstKey ? { chatKey: firstKey } : {}) },
      }),
    [hostId, firstKey],
  );
  const permissions = snapshot.items.filter((item) => item.status === "approval").length;
  const questions = snapshot.items.filter((item) => item.status === "question").length;
  const working = snapshot.agents.filter((item) => item.status === "working").length;
  const label = `${permissions} permission requests, ${questions} questions, ${working} Chats working`;
  return <FloatingInboxButton status={status} label={label} open={open} bottom={bottom} />;
}

export function InboxSheet() {
  const { snapshot, client, error, loading, refresh } = usePhoneInbox();
  const { chatKey } = useLocalSearchParams<{ chatKey?: string }>();
  const items = snapshot.items;
  return (
    <PhoneInboxPages
      key={client?.url ?? "disconnected"}
      items={items}
      initialKey={chatKey}
      connected={!!client}
      error={error}
      loading={loading}
      refresh={refresh}
    />
  );
}

function inboxSwipe(select: (index: number) => void, index: number) {
  return Gesture.Pan()
    .activeOffsetX([-28, 28])
    .failOffsetY([-16, 16])
    .onEnd((event) => {
      const travel = event.translationX + event.velocityX * 0.12;
      if (Math.abs(travel) > 55) scheduleOnRN(select, index + (travel < 0 ? 1 : -1));
    });
}

function PhoneInboxPages({
  items,
  initialKey,
  connected = true,
  error = "",
  loading = false,
  refresh,
}: {
  items: InboxItem[];
  initialKey?: string;
  connected?: boolean;
  error?: string;
  loading?: boolean;
  refresh: () => void;
}) {
  const [selectedKey, setSelectedKey] = useState<string | undefined>(initialKey);
  const [direction, setDirection] = useState(1);
  const [drafts, setDrafts] = useState<Record<string, InboxQuestionDraft>>({});
  const { colors } = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const { height } = useSafeAreaFrame();
  const scroll = useRef<ScrollView>(null);
  const index = Math.max(
    0,
    items.findIndex((item) => item.key === selectedKey),
  );
  const selected = items[index];
  const draftKey = selected ? `${selected.key}:${selected.question?.requestId ?? ""}` : "";
  const select = useCallback(
    (next: number) => {
      if (!items[next] || next === index) return;
      Keyboard.dismiss();
      setDirection(next > index ? 1 : -1);
      setSelectedKey(items[next].key);
    },
    [items, index],
  );
  useEffect(() => {
    scroll.current?.scrollTo({ y: 0, animated: false });
  }, [selected?.key]);
  const swipe = useMemo(() => inboxSwipe(select, index), [select, index]);
  return (
    <Animated.View
      layout={INBOX_LAYOUT}
      style={{
        backgroundColor: colors.surface,
        paddingTop: 12,
        paddingBottom: Math.max(insets.bottom, 16),
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 14,
          minHeight: 44,
        }}
      >
        <View style={{ width: 44, alignItems: "center" }}>
          <GlassIconButton label="Close inbox" systemImage="xmark" icon={Cancel01Icon} onPress={() => router.back()} />
        </View>
        <View style={{ flex: 1, alignItems: "center" }}>{items.length > 0 && <InboxPager index={index} count={items.length} select={select} />}</View>
        <View style={{ width: 44 }} pointerEvents="none" accessibilityElementsHidden />
      </View>
      {items.length > 1 && (
        <Text style={{ color: colors.ink3, fontSize: 11, textAlign: "center", paddingBottom: 4 }}>Swipe or tap the arrows to move between messages</Text>
      )}
      <GestureDetector gesture={swipe}>
        <Animated.View layout={INBOX_LAYOUT} style={{ overflow: "hidden" }}>
          <PageScroll
            ref={scroll}
            showsVerticalScrollIndicator={false}
            showsHorizontalScrollIndicator={false}
            contentInsetAdjustmentBehavior="never"
            automaticallyAdjustKeyboardInsets
            style={{ flexGrow: 0, flexShrink: 1, maxHeight: height * 0.72 }}
            contentContainerStyle={{
              paddingHorizontal: 22,
              paddingTop: 16,
              paddingBottom: 8,
              gap: 0,
            }}
          >
            {error ? (
              <View style={{ gap: 10 }}>
                <ErrorNotice message={error} />
                <PillButton title="Retry" secondary onPress={refresh} />
              </View>
            ) : !connected ? (
              <Text style={styles.muted}>Connect to a computer to open its inbox.</Text>
            ) : loading ? (
              <Text style={styles.muted}>Loading inbox…</Text>
            ) : !selected ? (
              <View style={{ alignItems: "center", paddingVertical: 40, gap: 10 }}>
                <Text style={{ color: colors.ink, fontSize: 17, fontWeight: "500" }}>All caught up</Text>
                <Text style={styles.muted}>Questions and finished work will appear here.</Text>
              </View>
            ) : (
              <InboxPage pageKey={`${selected.key}:${selected.permission?.requestId ?? selected.question?.requestId ?? selected.at}`} direction={direction}>
                <PhoneInboxCard
                  key={`${selected.key}:${selected.permission?.requestId ?? selected.question?.requestId ?? selected.at}`}
                  item={selected}
                  refresh={refresh}
                  draft={drafts[draftKey]}
                  setDraft={(draft) => setDrafts((saved) => ({ ...saved, [draftKey]: draft }))}
                />
              </InboxPage>
            )}
          </PageScroll>
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  );
}

function PhoneInboxCard({
  item,
  refresh,
  draft,
  setDraft,
}: {
  item: InboxItem;
  refresh: () => void;
  draft?: InboxQuestionDraft;
  setDraft: (draft: InboxQuestionDraft) => void;
}) {
  const { client } = useSession();
  const { colors } = useTheme();
  const styles = useStyles();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const action = async (run: () => Promise<unknown>) => {
    if (!client || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      if ((await run()) === false) throw new Error("This request is no longer waiting. Refresh the inbox.");
      setDraft({ page: 0, picked: {}, typed: {} });
      refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not send your answer.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const open = () => {
    if (client)
      router.dismissTo({
        pathname: "/chat",
        params: {
          projectPath: item.projectPath,
          hostId: client.url,
          id: String(sessionIdFromKey(item.key)),
        },
      });
  };
  return (
    <View accessibilityLabel={`Inbox Chat: ${item.title}`} style={{ gap: 18 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${item.title}`}
        onPress={open}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          minHeight: 44,
        }}
      >
        <View style={{ position: "relative" }}>
          <ProviderLogo provider={item.provider ?? "claude"} size={28} />
          <View
            style={{
              position: "absolute",
              right: -2,
              bottom: -2,
              padding: 2,
              borderRadius: 7,
              backgroundColor: colors.surface,
            }}
          >
            <InboxDot status={item.status} />
          </View>
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={{ color: colors.ink, fontSize: 17, fontWeight: "600" }}>{providerName(item.provider ?? "claude")}</Text>
          <Text style={{ color: colors.ink3, fontSize: 13 }}>
            {statusWords(item.status)} · {item.project}
            {item.computer ? ` · ${item.computer}` : ""}
          </Text>
        </View>
      </Pressable>
      {item.question ? (
        <Questions
          variant="inline"
          request={item.question}
          busy={busy}
          confirmSingle
          draft={draft}
          onDraftChange={setDraft}
          submit={(answers, summary) =>
            void action(() =>
              client!.call("agent:answer-question", [
                {
                  chatId: item.key,
                  requestId: item.question!.requestId,
                  answers,
                  summary,
                },
              ]),
            )
          }
        />
      ) : item.permission ? (
        <Approval
          variant="inline"
          approval={item.permission}
          busy={busy}
          respond={(decision) =>
            void action(() =>
              client!.call("agent:respond-permission", [
                {
                  chatId: item.key,
                  requestId: item.permission!.requestId,
                  decision,
                },
              ]),
            )
          }
        />
      ) : (
        <View style={{ gap: 8 }}>
          <Text
            style={{
              fontSize: 17,
              fontWeight: "500",
              color: item.status === "failed" ? colors.red : colors.ink,
            }}
          >
            {item.status === "failed" ? "Turn failed" : item.status === "working" ? item.title : "Ready to review"}
          </Text>
          <Text style={[styles.muted, { lineHeight: 20 }]}>{item.preview}</Text>
        </View>
      )}
      {error && <ErrorNotice message={error} />}
      {!needsYou(item) && item.status !== "working" && (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <PillButton title="Open Chat" onPress={open} />
          <PillButton
            title="Clear"
            secondary
            disabled={busy}
            onPress={() => void action(() => client!.call("chat:patch", [item.projectPath, sessionIdFromKey(item.key), { unread: false }]))}
          />
        </View>
      )}
    </View>
  );
}
