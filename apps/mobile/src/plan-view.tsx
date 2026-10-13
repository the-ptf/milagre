import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from "react-native-svg";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
  EyeIcon,
  Flag01Icon,
  GitMergeIcon,
  Rocket01Icon,
  Target02Icon,
  TestTube01Icon,
  Tick02Icon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { PHASES } from "@milagre/shared/chat-plan";
import { phaseGraph, phaseGraphPath, rowY } from "@milagre/shared/phase-graph";
import type { ChatPlan, ChatTask } from "@milagre/shared/model";
import { withAlpha } from "@milagre/shared/themes";
import { Icon, SpinnerRing } from "./icons";
import { PHASE_LABELS } from "./plan-label";
import { useTheme } from "./theme";
import { useStyles } from "./ui";

const PHASE_ICONS = {
  start: Flag01Icon,
  plan: Target02Icon,
  build: Wrench01Icon,
  test: TestTube01Icon,
  review: EyeIcon,
  merge: GitMergeIcon,
  release: Rocket01Icon,
  done: CheckmarkCircle02Icon,
} as const;

const STATUS_LABELS: Record<ChatTask["status"], string> = { pending: "Pending", in_progress: "In progress", completed: "Completed" };

function TaskMarker({ status }: { status: ChatTask["status"] }) {
  const { colors } = useTheme();
  if (status === "in_progress") return <SpinnerRing size={12} />;
  if (status === "completed") return <Icon icon={Tick02Icon} tone="ink3" size={14} />;
  return <View style={{ width: 12, height: 12, borderRadius: 6, borderWidth: 1.5, borderColor: colors.lineStrong }} />;
}

function Rows({ tasks, depth, folded, toggle }: { tasks: ChatTask[]; depth: number; folded: Set<string>; toggle: (id: string) => void }) {
  const { colors } = useTheme();
  const styles = useStyles();
  return tasks.map((task, index) => {
    const parent = Boolean(task.children?.length);
    const open = parent && !folded.has(task.id);
    const current = task.status === "in_progress" && !parent;
    const title = current && task.activeForm ? task.activeForm : task.title;
    return (
      <View key={task.id}>
        <Pressable
          disabled={!parent}
          onPress={() => toggle(task.id)}
          accessibilityRole={parent ? "button" : undefined}
          accessibilityLabel={`${STATUS_LABELS[task.status]}: ${title}`}
          accessibilityHint={parent ? (open ? "Collapses the subtasks" : "Expands the subtasks") : undefined}
          accessibilityState={parent ? { expanded: open } : undefined}
          style={[
            styles.row,
            {
              flexWrap: "nowrap",
              alignItems: "flex-start",
              gap: 8,
              paddingVertical: 7,
              paddingLeft: 4 + depth * 18,
              paddingRight: 6,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: "transparent",
            },
            current && { backgroundColor: colors.hover, borderColor: withAlpha(colors.accent, 0.5) },
          ]}
        >
          <View style={{ width: 12, height: 21, justifyContent: "center" }}>
            {parent && <Icon icon={open ? ArrowDown01Icon : ArrowRight01Icon} tone="ink3" size={12} />}
          </View>
          <View
            style={{
              minWidth: 18,
              height: 21,
              paddingHorizontal: 4,
              borderRadius: 4,
              backgroundColor: colors.hover,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ color: colors.ink3, fontSize: 11, fontVariant: ["tabular-nums"] }}>{index + 1}</Text>
          </View>
          <Text style={{ flex: 1, color: task.status === "completed" && !parent ? colors.ink3 : colors.ink, fontSize: 15, lineHeight: 21 }}>{title}</Text>
          <View style={{ width: 16, height: 21, alignItems: "center", justifyContent: "center" }}>
            <TaskMarker status={task.status} />
          </View>
        </Pressable>
        {open && <Rows tasks={task.children!} depth={depth + 1} folded={folded} toggle={toggle} />}
      </View>
    );
  });
}

/** Desktop's Tasks list: the Chat's nested tasks with per-level numbers; parents fold, the working leaf is highlighted. */
export function PlanTree({ plan }: { plan: ChatPlan }) {
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <View>
      <Rows tasks={plan.tasks} depth={0} folded={folded} toggle={toggle} />
    </View>
  );
}

const HEIGHT = 168;
// One legend row per phase: its centre is rowY(row, HEIGHT), so every dot sits on its label.
const ROW = HEIGHT / PHASES.length;

/** The Chat's phase history on a time axis that ends at Now; long idle stretches fold into a labelled gap. */
export function PlanPhaseGraph({ plan }: { plan: ChatPlan }) {
  const { colors } = useTheme();
  // Now is taken when the graph opens, so rerenders do not move the axis.
  const [opened] = useState(() => Date.now());
  // The SVG is drawn in real pixels at the cell's width, so its rows line up with the legend beside it.
  const [width, setWidth] = useState(0);
  const graph = phaseGraph(plan.phases, opened);
  if (!graph.points.length || !graph.current) return null;
  const last = graph.points.length - 1;
  const path = width > 0 ? phaseGraphPath(graph.points, width, HEIGHT) : "";
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      <View style={{ height: HEIGHT, flexDirection: "column-reverse" }}>
        {PHASES.map((phase) => {
          const current = graph.current === phase;
          return (
            <View
              key={phase}
              style={{
                height: ROW,
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                paddingHorizontal: 4,
                borderRadius: 4,
                backgroundColor: current ? colors.hover : "transparent",
              }}
            >
              <Icon icon={PHASE_ICONS[phase]} tone={current ? "ink" : "ink3"} size={11} />
              <Text style={{ fontSize: 11, lineHeight: 13, color: current ? colors.ink : colors.ink3 }}>{PHASE_LABELS[phase]}</Text>
            </View>
          );
        })}
      </View>
      <View style={{ flex: 1, minWidth: 0 }} onLayout={(event) => setWidth(Math.max(1, Math.round(event.nativeEvent.layout.width)))}>
        {width > 0 && (
          <Svg width={width} height={HEIGHT + 18} style={{ overflow: "visible" }} accessibilityLabel={`Current phase: ${PHASE_LABELS[graph.current]}`}>
            <Path d={path} fill="none" stroke={colors.accent} strokeWidth={2} strokeLinecap="round" />
            {graph.points.map((point, index) => (
              <Circle
                key={`${point.at}-${point.phase}`}
                cx={point.x * width}
                cy={rowY(point.row, HEIGHT)}
                r={index === last ? 5 : 3}
                fill={index === last ? colors.accent : colors.ink2}
              />
            ))}
            {graph.gaps.map((gap) => (
              <G key={`${gap.x0}-${gap.x1}`}>
                <Rect x={((gap.x0 + gap.x1) / 2) * width - 12} y={HEIGHT / 2 - 8} width={24} height={16} rx={4} fill={colors.hover} />
                <SvgText x={((gap.x0 + gap.x1) / 2) * width} y={HEIGHT / 2 + 4} textAnchor="middle" fontSize={10} fill={colors.ink2}>
                  {gap.label}
                </SvgText>
              </G>
            ))}
            <Line x1={width} x2={width} y1={0} y2={HEIGHT} stroke={colors.accent} strokeWidth={1} strokeDasharray="3 3" />
            {graph.ticks.map((tick) => (
              <SvgText key={tick.x} x={tick.x * width} y={HEIGHT + 14} textAnchor="middle" fontSize={10} fill={colors.ink3}>
                {tick.label}
              </SvgText>
            ))}
            <SvgText x={width} y={HEIGHT + 14} textAnchor="middle" fontSize={10} fill={colors.ink3}>
              Now
            </SvgText>
          </Svg>
        )}
      </View>
    </View>
  );
}
