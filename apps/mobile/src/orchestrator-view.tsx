import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { Stack, router } from "expo-router";
import { SlidersHorizontalIcon } from "@hugeicons/core-free-icons";
import type { BoardColumn, OrchestratorTask } from "@milagre/shared/orchestrator";
import { lineHeight, space, type } from "./design-tokens";
import type { MascotMood } from "./mascot";
import { accountName, openTaskChat, useAccountNames } from "./orchestrator-actions";
import { projectName } from "./orchestrator-board";
import { BoardList, BoardTabs } from "./orchestrator-board-view";
import { CarriedNote, StartedToast } from "./orchestrator-overlays";
import { OrchestratorPrompt } from "./orchestrator-prompt";
import { OrchestratorTour } from "./orchestrator-tour";
import { useSession } from "./session";
import { useTheme } from "./theme";
import { EmptyState, ErrorNotice, HeaderButton, PageScroll, pressStyle, useStyles } from "./ui";
import { useOrchestrator } from "./use-orchestrator";
import { useOrchestratorBoard } from "./use-orchestrator-board";

type Carry = { id: number; text: string; from: number; to: number };

function Header({ shown = true }: { shown?: boolean }) {
  const open = () => router.push("/orchestrator-settings");
  return (
    <>
      <Stack.Screen options={{ title: "Orchestrator", headerShown: shown }} />
      <Stack.Toolbar placement="right">
        {Platform.OS === "ios" ? (
          <Stack.Toolbar.Button icon="slider.horizontal.3" accessibilityLabel="Orchestrator settings" onPress={open} />
        ) : (
          <Stack.Toolbar.View>
            <HeaderButton label="Orchestrator settings" icon={SlidersHorizontalIcon} onPress={open} />
          </Stack.Toolbar.View>
        )}
      </Stack.Toolbar>
    </>
  );
}

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function LinkButton({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      hitSlop={12}
      style={({ pressed }) => [{ minHeight: 28, justifyContent: "center" }, pressStyle({ pressed })]}
    >
      <Text style={{ color: colors.accentInk, fontSize: type.footnote, lineHeight: lineHeight.footnote, fontWeight: "500" }}>{label}</Text>
    </Pressable>
  );
}

export function OrchestratorView() {
  const styles = useStyles();
  const { colors } = useTheme();
  const session = useSession();
  const client = session.client;
  const { snapshot, error, unavailable, loading, store } = useOrchestrator(client);
  const tasks = snapshot?.tasks ?? [];
  const { items, counts } = useOrchestratorBoard(tasks);
  const accounts = useAccountNames(client);
  const now = useNow();
  const [tab, setTab] = useState<BoardColumn>("running");
  const [mood, setMood] = useState<MascotMood>("idle");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [landing, setLanding] = useState<ReadonlySet<string>>(() => new Set());
  const [toast, setToast] = useState<OrchestratorTask | null>(null);
  const [carry, setCarry] = useState<Carry | null>(null);
  const frames = useRef({ prompt: 0, box: 0, board: 0 });
  const routingKey = items
    .filter((item) => item.kind === "deciding")
    .map((item) => item.task.id)
    .join(",");
  const [seenRouting, setSeenRouting] = useState("");
  if (routingKey !== seenRouting) {
    setSeenRouting(routingKey);
    if (routingKey)
      setLanding((current) => {
        const next = new Set(current);
        for (const id of routingKey.split(",")) next.add(id);
        return next.size === current.size ? current : next;
      });
  }
  const landed = useCallback((task: OrchestratorTask) => {
    setLanding((current) => {
      const next = new Set(current);
      next.delete(task.id);
      return next;
    });
    setMood("happy");
    setToast(task);
    setTimeout(() => setMood("idle"), 1500);
  }, []);
  const hideToast = useCallback(() => setToast(null), []);
  if (!client) return <EmptyState title="Connect to a computer">Open a computer from the list to use its Orchestrator.</EmptyState>;
  if (unavailable)
    return (
      <View style={styles.screen}>
        <Header />
        <EmptyState title="Update Milagre on your computer">{"This computer's Milagre doesn't have the Orchestrator yet."}</EmptyState>
      </View>
    );
  const settings = snapshot?.settings;
  const color = settings?.mascotColor ?? "";
  const send = (prompt: string) => {
    if (!store) return;
    setSendError("");
    setSending(true);
    setMood("thinking");
    setTab("running");
    setCarry({ id: Date.now(), text: prompt, from: frames.current.prompt + frames.current.box, to: frames.current.board });
    store
      .send(prompt)
      .catch((failure: Error) => {
        setMood("idle");
        setSendError(failure.message || "Couldn't send that. Try again.");
      })
      .finally(() => setSending(false));
  };
  const touring = !!settings?.enabled && !settings.tourDone;
  return (
    <View style={styles.screen}>
      <Header shown={!touring} />
      <PageScroll keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: space.section }}>
        {error ? <ErrorNotice message={error} /> : null}
        {!settings ? (
          loading ? null : (
            <EmptyState title="Couldn't read the Orchestrator">{"Open it again, or check the computer's connection."}</EmptyState>
          )
        ) : !settings.enabled ? (
          <EmptyState
            title="The Orchestrator is off"
            action={{ title: "Turn it on", onPress: () => void store?.saveSettings({ enabled: true }).catch(() => {}) }}
          >
            One box for every Project. It picks the Project, the role, the model and the account, then runs the work as a Subchat.
          </EmptyState>
        ) : (
          <>
            <View
              onLayout={(event) => {
                frames.current.prompt = event.nativeEvent.layout.y;
              }}
            >
              <OrchestratorPrompt
                color={color}
                mood={mood}
                busy={sending}
                onSend={send}
                onBoxLayout={(frame) => {
                  frames.current.box = frame.y;
                }}
              />
            </View>
            {sendError ? <ErrorNotice message={sendError} /> : null}
            <View
              style={{ gap: space.lg }}
              onLayout={(event) => {
                frames.current.board = event.nativeEvent.layout.y + 80;
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md }}>
                <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: type.title3, lineHeight: lineHeight.title3, fontWeight: "600" }}>
                  Tasks
                </Text>
                <LinkButton
                  label={settings.boardHidden ? "Show board" : "Hide board"}
                  onPress={() => void store?.saveSettings({ boardHidden: !settings.boardHidden }).catch(() => {})}
                />
              </View>
              {settings.boardHidden ? (
                <Text style={styles.footnote}>
                  {counts.running} running · {counts.needs} need you · {counts.review} in review
                </Text>
              ) : (
                <>
                  <BoardTabs tab={tab} counts={counts} onTab={setTab} />
                  <BoardList
                    tab={tab}
                    items={items}
                    landing={landing}
                    projects={session.recent}
                    roles={settings.roles}
                    models={session.models}
                    color={color}
                    now={now}
                    accountOf={(task) => accountName(accounts, task)}
                    onLanded={landed}
                    onOpen={(item) => router.push({ pathname: "/orchestrator-task", params: { id: item.task.id } })}
                  />
                </>
              )}
            </View>
          </>
        )}
        {carry ? <CarriedNote key={carry.id} text={carry.text} from={carry.from} to={carry.to} color={color} onDone={() => setCarry(null)} /> : null}
      </PageScroll>
      {toast ? (
        <StartedToast
          key={toast.id}
          project={projectName(toast.projectPath, session.recent)}
          color={color}
          onHide={hideToast}
          onUndo={() => {
            setToast(null);
            void store?.act("orchestrator:task:undo", [toast.id], { optimisticDrop: toast.id }).catch(() => {});
          }}
          onOpen={() => {
            setToast(null);
            openTaskChat(toast, session).catch((failure: Error) => setSendError(failure.message));
          }}
        />
      ) : null}
      {touring && snapshot && store ? <OrchestratorTour snapshot={snapshot} store={store} /> : null}
    </View>
  );
}
