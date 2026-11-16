import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withSequence, withTiming } from "react-native-reanimated";
import { Alert02Icon, CheckmarkCircle02Icon, GitMergeIcon, GitPullRequestIcon } from "@hugeicons/core-free-icons";
import { activeRoles, roleById, type OrchestratorRole, type OrchestratorTask } from "@milagre/shared/orchestrator";
import type { AgentModels } from "@milagre/shared/model";
import { lineHeight, radius, space, type } from "./design-tokens";
import { Icon, ProviderLogo, SpinnerRing } from "./icons";
import { Mascot, type MascotGaze } from "./mascot";
import { scaledTiming, useMotionScale, useReducedMotion } from "./motion";
import { modelAndEffort, projectName, reelStrip, relativeAge, type BoardItem } from "./orchestrator-board";
import { useTheme } from "./theme";
import { pressStyle, Tag, useStyles } from "./ui";

export type Projects = readonly { path: string; name?: string }[];
const REEL_ROW = lineHeight.footnote;
const REEL_MS = 700;
const LAND_PAUSE_MS = 180;

export function TaskMark({ item }: { item: BoardItem }) {
  const { colors } = useTheme();
  if (item.kind === "deciding" || item.kind === "loading" || item.kind === "remote") return <SpinnerRing size={16} />;
  if (item.kind === "failed" || item.mark === "failed") return <Icon icon={Alert02Icon} tone="red" size={16} />;
  if (item.column === "needs")
    return (
      <View style={{ width: 16, height: 16, alignItems: "center", justifyContent: "center" }}>
        <View style={{ width: 8, height: 8, borderRadius: radius.full, backgroundColor: colors.orange }} />
      </View>
    );
  if (item.column === "review" && item.pullRequest === "open") return <Icon icon={GitPullRequestIcon} tone="green" size={16} />;
  if (item.column === "review") return <Icon icon={CheckmarkCircle02Icon} tone="ink3" size={16} />;
  if (item.column === "done")
    return item.pullRequest === "merged" ? <Icon icon={GitMergeIcon} tone="purple" size={16} /> : <Icon icon={CheckmarkCircle02Icon} tone="ink3" size={16} />;
  if (item.mark === "running" || item.mark === "background") return <SpinnerRing size={16} />;
  if (item.mark === "unread")
    return (
      <View style={{ width: 16, height: 16, alignItems: "center", justifyContent: "center" }}>
        <View style={{ width: 8, height: 8, borderRadius: radius.full, backgroundColor: colors.accent }} />
      </View>
    );
  return <Icon icon={CheckmarkCircle02Icon} tone="ink3" size={16} />;
}

function Meta({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <Text numberOfLines={1} style={{ color: colors.ink3, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>
      {children}
    </Text>
  );
}

export function TaskCard({
  item,
  projects,
  roles,
  models,
  now,
  onPress,
}: {
  item: BoardItem;
  projects: Projects;
  roles: readonly OrchestratorRole[];
  models: AgentModels | null;
  now: number;
  onPress: () => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { task } = item;
  const role = roles.find((entry) => entry.id === task.role)?.name ?? task.role;
  const needsTone = item.kind === "failed" ? colors.redInk : colors.orangeInk;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${task.title}. ${item.detail}`}
      onPress={onPress}
      style={({ pressed }) => [styles.card, { gap: space.sm, paddingVertical: space.lg }, pressStyle({ pressed, kind: "row" })]}
    >
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.md }}>
        <View style={{ paddingTop: space.xxs }}>
          <TaskMark item={item} />
        </View>
        <Text style={{ flex: 1, color: colors.ink, fontSize: type.callout, lineHeight: lineHeight.callout, fontWeight: "600" }}>{task.title}</Text>
        <Text style={{ color: colors.ink3, fontSize: type.caption1, lineHeight: lineHeight.callout }}>{relativeAge(task.createdAt, now)}</Text>
      </View>
      {item.detail ? (
        <Text
          numberOfLines={2}
          style={{
            color: item.column === "needs" ? needsTone : colors.ink2,
            fontSize: type.footnote,
            lineHeight: lineHeight.footnote,
          }}
        >
          {item.detail}
        </Text>
      ) : null}
      {task.state === "started" && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          {task.provider ? <ProviderLogo provider={task.provider} size={12} /> : null}
          <View style={{ flex: 1 }}>
            <Meta>
              {task.remoteComputerId ? `On ${task.computer ?? "another computer"} · ` : ""}
              {projectName(task.projectPath, projects)} · {modelAndEffort(task.provider, task.model, task.effort, models)} · {role}
            </Meta>
          </View>
          {item.inSidebar ? <Tag label="In sidebar" /> : null}
        </View>
      )}
    </Pressable>
  );
}

type Slot = { label: string; options: string[]; picked: string };

function Reel({ slot, state, onLanded }: { slot: Slot; state: "wait" | "active" | "done"; onLanded: () => void }) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const scale = useMotionScale();
  const strip = useMemo(() => reelStrip(slot.options, slot.picked).map((value, position) => ({ value, position })), [slot.options, slot.picked]);
  const offset = useSharedValue(0);
  const end = -REEL_ROW * (strip.length - 1);
  useEffect(() => {
    if (state !== "active") return;
    if (reduced || scale === 0) {
      offset.set(end);
      const timer = setTimeout(onLanded, LAND_PAUSE_MS);
      return () => clearTimeout(timer);
    }
    offset.set(0);
    offset.set(
      withSequence(
        withTiming(end - 3, scaledTiming({ duration: REEL_MS * 0.85, easing: Easing.bezier(0.2, 0.75, 0.25, 1) }, scale)),
        withTiming(end, scaledTiming({ duration: REEL_MS * 0.15, easing: Easing.out(Easing.quad) }, scale), (finished) => {
          if (finished) runOnJS(onLanded)();
        }),
      ),
    );
  }, [state, reduced, scale, end, offset, onLanded]);
  const moving = useAnimatedStyle(() => ({ transform: [{ translateY: state === "done" ? end : offset.value }] }));
  const text = { fontSize: type.footnote, lineHeight: REEL_ROW };
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 28 }}>
      <Text style={[text, { width: 72, color: colors.ink3 }]}>{slot.label}</Text>
      <View style={{ flex: 1, height: REEL_ROW, overflow: "hidden" }}>
        {state === "wait" ? (
          <Text style={[text, { color: colors.ink4 }]}>…</Text>
        ) : (
          <Animated.View style={moving}>
            {strip.map(({ value, position }) => (
              <Text
                key={position}
                numberOfLines={1}
                style={[
                  text,
                  { color: state === "done" && position === strip.length - 1 ? colors.ink : colors.ink3, fontWeight: state === "done" ? "500" : "400" },
                ]}
              >
                {value}
              </Text>
            ))}
          </Animated.View>
        )}
      </View>
    </View>
  );
}

function Cycling({ options }: { options: string[] }) {
  const { colors } = useTheme();
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (reduced || options.length < 2) return;
    const timer = setInterval(() => setIndex((current) => (current + 1) % options.length), 140);
    return () => clearInterval(timer);
  }, [reduced, options.length]);
  return (
    <Text numberOfLines={1} style={{ flex: 1, color: colors.ink3, fontSize: type.footnote, lineHeight: REEL_ROW }}>
      {reduced ? "…" : (options[index] ?? "…")}
    </Text>
  );
}

const GAZE: MascotGaze[] = [
  { x: 0.4, y: 0.1 },
  { x: 0.4, y: 0.45 },
  { x: 0.4, y: 0.75 },
  { x: 0.4, y: 1 },
];

/**
 * A task the host is routing, then the four decisions landing one after another (Project, role, model and effort,
 * account) while a small Pebble watches each slot; `onDone` fires once the last one lands.
 */
export function DecidingCard({
  task,
  projects,
  roles,
  models,
  color,
  accountName,
  onDone,
}: {
  task: OrchestratorTask;
  projects: Projects;
  roles: readonly OrchestratorRole[];
  models: AgentModels | null;
  color: string;
  accountName: string | null;
  onDone?: () => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const routing = task.state === "routing";
  const [step, setStep] = useState(0);
  const projectNames = useMemo(() => projects.map((project) => projectName(project.path, projects)), [projects]);
  const usable = activeRoles(roles);
  const role = roleById(roles, task.role);
  const slots: Slot[] = [
    { label: "Project", options: projectNames, picked: projectName(task.projectPath, projects) },
    { label: "Role", options: usable.map((entry) => entry.name), picked: role?.name ?? task.role },
    {
      label: "Model",
      options: usable.map((entry) => modelAndEffort(entry.provider, entry.model, entry.effort, models)),
      picked: modelAndEffort(task.provider, task.model, task.effort, models),
    },
    { label: "Account", options: ["Least used", "Project's account"], picked: accountName ?? task.reason.account ?? "Project's account" },
  ];
  const landed = () => {
    setTimeout(() => {
      if (step >= slots.length - 1) onDone?.();
      setStep((current) => current + 1);
    }, LAND_PAUSE_MS);
  };
  const looking = routing ? 0 : Math.min(step, slots.length - 1);
  return (
    <View accessibilityLabel={`Routing ${task.title}`} accessibilityLiveRegion="polite" style={[styles.card, { gap: space.sm, paddingVertical: space.lg }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
        <Mascot size={20} color={color} mood={routing ? "thinking" : step >= slots.length ? "happy" : "thinking"} gaze={GAZE[looking] ?? null} />
        <Text numberOfLines={1} style={{ flex: 1, color: colors.ink, fontSize: type.callout, lineHeight: lineHeight.callout, fontWeight: "600" }}>
          {task.title}
        </Text>
      </View>
      {slots.map((slot, index) =>
        routing ? (
          <View key={slot.label} style={{ flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 28 }}>
            <Text style={{ width: 72, color: colors.ink3, fontSize: type.footnote, lineHeight: REEL_ROW }}>{slot.label}</Text>
            {index === 0 ? <Cycling options={slot.options} /> : <Text style={{ color: colors.ink4, fontSize: type.footnote, lineHeight: REEL_ROW }}>…</Text>}
          </View>
        ) : (
          <Reel key={slot.label} slot={slot} state={step === index ? "active" : step > index ? "done" : "wait"} onLanded={landed} />
        ),
      )}
    </View>
  );
}
