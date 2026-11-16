import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn, FadeInDown, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { ArrowUp01Icon, CheckmarkCircle02Icon, ComputerTerminal01Icon, GitMergeIcon, LockIcon, MinusSignIcon } from "@hugeicons/core-free-icons";
import { activeRoles, type OrchestratorMemoryNote, type OrchestratorSnapshot, type OrchestratorTask } from "@milagre/shared/orchestrator";
import { lineHeight, radius, space, type } from "./design-tokens";
import { Icon, SpinnerRing } from "./icons";
import { Mascot } from "./mascot";
import { springTo, useMotionScale, useReducedMotion } from "./motion";
import { DecidingCard } from "./orchestrator-cards";
import { MemoryNotes } from "./orchestrator-memory";
import type { OrchestratorStore } from "./orchestrator-store";
import { useSession } from "./session";
import { useTheme } from "./theme";
import { PageScroll, PillButton, pressStyle, useStyles } from "./ui";

const PROMPT = "the rest timer skips on the lock screen in my gym app";
const AT = { box: 3000, type: 3600, send: 5700, started: 6600, autopilot: 10600, answered: 11800, merge: 12800, end: 15200 } as const;
const TYPE_MS = 36;
const SPRING = { damping: 18, stiffness: 160 };

function useClock(stopped: boolean) {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (stopped) return;
    const start = Date.now();
    const timer = setInterval(() => setT(Date.now() - start), 100);
    return () => clearInterval(timer);
  }, [stopped]);
  return t;
}

export const sourceCount = ({ count, unit }: { count: number; unit?: "notes" | "rules" }) =>
  `${count} ${unit === "rules" ? (count === 1 ? "rule" : "rules") : count === 1 ? "note" : "notes"}`;

function SourcePills({ snapshot, reading }: { snapshot: OrchestratorSnapshot; reading: boolean }) {
  const { colors } = useTheme();
  const pill = {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: space.xs,
    minHeight: 28,
    paddingHorizontal: space.md,
    borderRadius: radius.full,
  };
  const text = { fontSize: type.caption1, lineHeight: lineHeight.caption1 };
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md, justifyContent: "center" }}>
      {snapshot.memory.sources.map((source) => (
        <Animated.View
          key={source.name}
          entering={FadeIn}
          style={[pill, { backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line }]}
        >
          <Icon icon={source.found ? CheckmarkCircle02Icon : MinusSignIcon} tone={source.found ? "green" : "ink4"} size={12} />
          <Text style={[text, { color: source.found ? colors.ink : colors.ink3 }]}>
            {source.name}
            {source.found ? ` · ${sourceCount(source)}` : " · not found"}
          </Text>
        </Animated.View>
      ))}
      {reading ? (
        <View style={[pill, { backgroundColor: colors.field }]}>
          <SpinnerRing size={12} />
          <Text style={[text, { color: colors.ink2 }]}>Reading…</Text>
        </View>
      ) : null}
    </View>
  );
}

function Bubble({ icon, text, children }: { icon: typeof GitMergeIcon; text: string; children: React.ReactNode }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <Animated.View entering={FadeInDown} style={[styles.card, { gap: space.sm, paddingVertical: space.lg }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Icon icon={icon} tone="ink3" size={16} />
        <Text style={{ color: colors.ink, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>{text}</Text>
      </View>
      {children}
    </Animated.View>
  );
}

function Autopilot({ t }: { t: number }) {
  const { colors } = useTheme();
  const small = { fontSize: type.footnote, lineHeight: lineHeight.footnote };
  return (
    <View style={{ gap: space.md }}>
      <Bubble icon={ComputerTerminal01Icon} text="Run npm test?">
        {t < AT.answered ? (
          <Text style={[small, { color: colors.ink3 }]}>Deny · Allow</Text>
        ) : (
          <Animated.Text entering={FadeIn} style={[small, { color: colors.greenInk }]}>
            Answered for you: Allow
          </Animated.Text>
        )}
      </Bubble>
      {t >= AT.merge && (
        <Bubble icon={GitMergeIcon} text="Merge #212 into main?">
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
            <View style={{ width: 8, height: 8, borderRadius: radius.full, backgroundColor: colors.orange }} />
            <Text style={[small, { color: colors.orangeInk }]}>Waiting for you</Text>
          </View>
        </Bubble>
      )}
    </View>
  );
}

function DemoBox({ t, color }: { t: number; color: string }) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const typed = t < AT.send ? (reduced ? PROMPT : PROMPT.slice(0, Math.max(0, Math.floor((t - AT.type) / TYPE_MS)))) : "";
  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderRadius: radius.composer,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.lineStrong,
        paddingVertical: space.md,
        paddingLeft: space.xl,
        paddingRight: space.md,
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
      }}
    >
      <Mascot size={24} color={color} gaze={t < AT.send ? { x: Math.min(1, -0.2 + typed.length / 40), y: 0.5 } : { x: 0, y: 1 }} />
      <Text
        numberOfLines={2}
        style={{ flex: 1, minHeight: 44, color: typed ? colors.ink : colors.ink3, fontSize: type.subheadline, lineHeight: lineHeight.subheadline }}
      >
        {typed || "Ask for anything, in any Project…"}
      </Text>
      <View style={{ width: 32, height: 32, borderRadius: radius.full, backgroundColor: colors.ink, alignItems: "center", justifyContent: "center" }}>
        <Icon icon={ArrowUp01Icon} tone="onInk" size={16} />
      </View>
    </View>
  );
}

function useDemoTask(t: number): OrchestratorTask {
  const session = useSession();
  const project = session.recent[0]?.path ?? "/happiergym";
  const routing = t < AT.started;
  return useMemo(
    () => ({
      id: "tour",
      prompt: PROMPT,
      title: "Rest timer skips on the lock screen",
      projectPath: routing ? null : project,
      worktreeId: null,
      sessionId: null,
      computer: null,
      remoteComputerId: null,
      remoteTaskId: null,
      role: "build",
      provider: "claude",
      model: "claude-opus-5-5",
      effort: "high",
      accountId: null,
      reason: { project: null, role: null, account: "Least used today", computer: null },
      state: routing ? "routing" : "started",
      error: null,
      createdAt: 0,
      answered: [],
    }),
    [routing, project],
  );
}

function Story({ t, snapshot }: { t: number; snapshot: OrchestratorSnapshot }) {
  const { colors } = useTheme();
  const session = useSession();
  const task = useDemoTask(t);
  const projects = session.recent.length ? session.recent : [{ path: "/happiergym", name: "happiergym" }];
  const color = snapshot.settings.mascotColor;
  const caption =
    t < AT.autopilot
      ? "Type anything. I pick the Project, the model, the account and the computer."
      : "I answer the small stuff for you. Anything you can't undo waits for you.";
  return (
    <View style={{ gap: space.lg }}>
      <Animated.Text
        key={caption}
        entering={FadeIn}
        style={{ color: colors.ink, fontSize: type.body, lineHeight: lineHeight.body, fontWeight: "600", textAlign: "center" }}
      >
        {caption}
      </Animated.Text>
      <DemoBox t={t} color={color} />
      {t >= AT.send && (
        <Animated.View entering={FadeInDown}>
          <DecidingCard task={task} projects={projects} roles={activeRoles(snapshot.settings.roles)} models={session.models} color={color} accountName={null} />
        </Animated.View>
      )}
      {t >= AT.autopilot && <Autopilot t={t} />}
    </View>
  );
}

function Summary({ snapshot, store, onReview }: { snapshot: OrchestratorSnapshot; store: OrchestratorStore; onReview: () => void }) {
  const { colors } = useTheme();
  const [notes, setNotes] = useState<OrchestratorMemoryNote[]>(snapshot.memory.notes);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState("");
  const [seen, setSeen] = useState(snapshot.memory.notes);
  if (seen !== snapshot.memory.notes) {
    setSeen(snapshot.memory.notes);
    if (notes === seen) setNotes(snapshot.memory.notes);
  }
  const finish = async (then?: () => void) => {
    setBusy(true);
    setFailed("");
    try {
      if (notes !== snapshot.memory.notes) await store.saveNotes(notes);
      await store.saveSettings({ tourDone: true });
      then?.();
    } catch (failure) {
      setFailed(failure instanceof Error ? failure.message : "Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <PageScroll contentContainerStyle={{ gap: space.section }}>
      <View style={{ alignItems: "center", gap: space.md }}>
        <Mascot size={64} color={snapshot.settings.mascotColor} mood="happy" live />
        <Text
          accessibilityRole="header"
          style={{ color: colors.ink, fontSize: type.title2, lineHeight: lineHeight.title2, fontWeight: "600", textAlign: "center" }}
        >
          {"Here's what I already know about you"}
        </Text>
        <Text style={{ color: colors.ink2, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, textAlign: "center" }}>
          {"Read on this computer from your agents' instructions and memories. Untick anything I shouldn't keep."}
        </Text>
      </View>
      <SourcePills snapshot={snapshot} reading={false} />
      {notes.length ? (
        <MemoryNotes notes={notes} onChange={setNotes} />
      ) : (
        <Text style={{ color: colors.ink3, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, textAlign: "center" }}>
          {"Nothing yet. I'll learn from how you correct me."}
        </Text>
      )}
      <Text style={{ color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote, textAlign: "center" }}>
        {"Autopilot starts on Answer for me. I'll learn the rest from how you correct me."}
      </Text>
      {failed ? <Text style={{ color: colors.redInk, fontSize: type.footnote, lineHeight: lineHeight.footnote, textAlign: "center" }}>{failed}</Text> : null}
      <View style={{ gap: space.md }}>
        <PillButton title="Start" size="large" loading={busy} onPress={() => void finish()} />
        <PillButton title="Review in Settings" size="large" variant="plain" disabled={busy} onPress={() => void finish(onReview)} />
      </View>
    </PageScroll>
  );
}

/** The first-run story: hello, a prompt routed on a demo card, autopilot answering, then what it read about you. */
export function OrchestratorTour({ snapshot, store }: { snapshot: OrchestratorSnapshot; store: OrchestratorStore }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const motion = useMotionScale();
  const [skipped, setSkipped] = useState(false);
  const [reading, setReading] = useState(true);
  const t = useClock(skipped);
  useEffect(() => {
    void store
      .act("orchestrator:memory:import", [])
      .catch(() => {})
      .finally(() => setReading(false));
  }, [store]);
  const summary = skipped || (t >= AT.end && !reading);
  const size = useSharedValue(1);
  const big = t < AT.box;
  useEffect(() => {
    size.set(reducedMotion ? (big ? 1 : 0.5) : springTo(big ? 1 : 0.5, SPRING, motion));
  }, [big, reducedMotion, motion, size]);
  const grow = useAnimatedStyle(() => ({ transform: [{ scale: size.value }], marginBottom: (size.value - 1) * 96 }));
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.page, paddingTop: insets.top }]}>
      {summary ? (
        <Summary snapshot={snapshot} store={store} onReview={() => router.push("/orchestrator-settings")} />
      ) : (
        <View style={{ flex: 1, paddingHorizontal: space.gutter, paddingBottom: Math.max(insets.bottom, space.xl), gap: space.xl }}>
          <View style={{ alignItems: "flex-end" }}>
            <Pressable
              accessibilityRole="button"
              onPress={() => setSkipped(true)}
              hitSlop={8}
              style={({ pressed }) => [{ minHeight: 44, justifyContent: "center", paddingHorizontal: space.md }, pressStyle({ pressed })]}
            >
              <Text style={{ color: colors.ink2, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "600" }}>Skip tour</Text>
            </Pressable>
          </View>
          <View style={{ flex: 1, gap: space.xl, justifyContent: big ? "center" : "flex-start" }}>
            <Animated.View style={[{ alignItems: "center" }, grow]}>
              <Mascot size={96} color={snapshot.settings.mascotColor} mood={big ? "happy" : t >= AT.send && t < AT.autopilot ? "thinking" : "idle"} live />
            </Animated.View>
            {big ? (
              <Animated.View entering={FadeInDown.delay(250)} style={{ gap: space.sm }}>
                <Text style={{ color: colors.ink, fontSize: type.title1, lineHeight: lineHeight.title1, fontWeight: "600", textAlign: "center" }}>
                  {"Hi, I'm your Orchestrator."}
                </Text>
                <Text style={{ color: colors.ink2, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, textAlign: "center" }}>
                  One box for every Project. Let me show you how it works, while I read what your agents already know about you.
                </Text>
              </Animated.View>
            ) : (
              <Story t={t} snapshot={snapshot} />
            )}
          </View>
          <View style={{ gap: space.md, alignItems: "center" }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
              <Icon icon={LockIcon} tone="ink3" size={12} />
              <Text style={{ color: colors.ink3, fontSize: type.caption1, lineHeight: lineHeight.caption1 }}>
                {reading ? "Reading what your agents already know, on this computer" : "Done reading. Wrapping up the tour…"}
              </Text>
            </View>
            <SourcePills snapshot={snapshot} reading={reading} />
          </View>
        </View>
      )}
    </View>
  );
}
