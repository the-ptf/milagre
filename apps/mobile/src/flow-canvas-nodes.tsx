import { Pressable, Text, View } from "react-native";
import { Add01Icon, Alert02Icon, ArrowDown01Icon, ArrowRight01Icon, SplitIcon } from "@hugeicons/core-free-icons";
import type { FlowStep, FlowStepRun } from "@milagre/shared/model";
import type { FlowGraphNode, FlowPlace } from "@milagre/shared/routine-flow-graph";
import { conditionText, stepTitle } from "@milagre/shared/routine-flows";
import { TRIGGER_LOOK, stepLook, stepStateLook } from "./flow-looks";
import { StepTile } from "./flow-ui";
import { Icon } from "./icons";
import { hitSlopFor, lineHeight, radius, space, type } from "./design-tokens";
import { DISABLED_OPACITY, PRESSED_OPACITY, tap } from "./ui";
import { useTheme } from "./theme";

export type CanvasMark = { status: FlowStepRun["status"] | "not-taken"; text: string; run: FlowStepRun | null };
export type Spot = { position: "absolute"; left: number; top: number };

type Shared = {
  run: boolean;
  selected: string | null;
  mark?: (id: string) => CanvasMark | undefined;
  problems?: ReadonlyMap<string, string>;
  onPress: (id: string) => void;
};

const quiet = (mark: CanvasMark | undefined) => !mark || mark.status === "pending" || mark.status === "not-taken" || mark.status === "not-run";

export function CanvasPathLabel({
  branch,
  spot,
  taken,
  faded,
  folded,
  onToggle,
}: {
  branch: "yes" | "otherwise";
  spot: Spot;
  taken: boolean;
  faded: boolean;
  folded: boolean;
  onToggle: () => void;
}) {
  const { colors } = useTheme();
  const name = branch === "yes" ? "Yes" : "Otherwise";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${folded ? "Unfold" : "Fold"} the ${name} path`}
      hitSlop={hitSlopFor(22)}
      onPress={() => {
        tap();
        onToggle();
      }}
      style={[
        spot,
        {
          height: 22,
          flexDirection: "row",
          alignItems: "center",
          gap: space.xxs,
          paddingHorizontal: space.md,
          borderRadius: radius.full,
          backgroundColor: taken ? colors.greenTint : colors.field,
          opacity: faded ? PRESSED_OPACITY : 1,
        },
      ]}
    >
      <Text style={{ color: taken ? colors.greenInk : colors.ink2, fontSize: type.caption2, fontWeight: "600" }}>{name}</Text>
      <Icon icon={folded ? ArrowRight01Icon : ArrowDown01Icon} tone={taken ? "greenInk" : "ink2"} size={10} />
    </Pressable>
  );
}

export function CanvasPath({
  node,
  spot,
  dim,
  onAdd,
  onToggle,
}: {
  node: Extract<FlowGraphNode, { kind: "empty" | "collapsed" }>;
  spot: Spot;
  dim: boolean;
  onAdd?: (where: FlowPlace) => void;
  onToggle: (key: string) => void;
}) {
  const { colors } = useTheme();
  const key = node.id.slice(node.kind.length + 1);
  const folded = node.kind === "collapsed";
  const label = folded ? (node.count === 1 ? "1 step" : `${node.count} steps`) : onAdd ? "Add a step, or skip" : "Goes straight on";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={folded ? `${label}, folded. Unfold` : label}
      disabled={!folded && !onAdd}
      onPress={() => {
        tap();
        if (folded) onToggle(key);
        else onAdd?.(node.where);
      }}
      style={[
        spot,
        {
          width: node.width,
          height: node.height,
          borderRadius: radius.full,
          borderWidth: 1,
          borderStyle: folded ? "solid" : "dashed",
          borderColor: colors.lineStrong,
          backgroundColor: colors.surface,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: space.sm,
          opacity: dim ? DISABLED_OPACITY.control : 1,
        },
      ]}
    >
      {!folded && onAdd ? <Icon icon={Add01Icon} tone="ink3" size={12} /> : null}
      <Text style={{ color: colors.ink3, fontSize: type.footnote, fontWeight: folded ? "600" : "400" }}>{label}</Text>
      {folded ? <Icon icon={ArrowDown01Icon} tone="ink3" size={12} /> : null}
    </Pressable>
  );
}

export function CanvasCondition({
  node,
  spot,
  run,
  selected,
  mark,
  problems,
  onPress,
}: Shared & { node: Extract<FlowGraphNode, { kind: "condition" }>; spot: Spot }) {
  const { colors } = useTheme();
  const { step } = node;
  const dim = run && mark?.(step.id)?.status !== "done";
  const name = step.name && step.name !== "If" ? step.name : conditionText(step);
  const ring = problems?.has(step.id) ? colors.red : selected === step.id ? colors.ink : colors.line;
  return (
    <View style={[spot, { width: node.width, height: node.height, alignItems: "center" }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${name}${step.field ? `, reads ${step.field}` : ""}`}
        onPress={() => {
          tap();
          onPress(step.id);
        }}
        style={{
          height: node.height,
          maxWidth: node.width + 40,
          flexDirection: "row",
          alignItems: "center",
          gap: space.md,
          paddingLeft: space.sm,
          paddingRight: space.lg,
          borderRadius: radius.full,
          backgroundColor: colors.surface,
          borderWidth: ring === colors.line ? 1 : 2,
          borderColor: ring,
          opacity: dim ? DISABLED_OPACITY.control : 1,
        }}
      >
        <View style={{ width: 28, height: 28, borderRadius: radius.full, alignItems: "center", justifyContent: "center", backgroundColor: colors.field }}>
          <Icon icon={SplitIcon} tone="ink2" size={14} />
        </View>
        <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.ink, fontSize: type.subheadline, fontWeight: "600" }}>
          {name}
        </Text>
      </Pressable>
    </View>
  );
}

function Outputs({ names, width }: { names: string[]; width: number }) {
  const { colors } = useTheme();
  if (names.length === 0) return null;
  return (
    <View pointerEvents="none" style={{ position: "absolute", top: 50, left: 0, width, flexDirection: "row", justifyContent: "center", gap: space.xs }}>
      {names.slice(0, 3).map((name) => (
        <Text
          key={name}
          style={{
            height: 20,
            paddingHorizontal: space.sm,
            borderRadius: radius.chip,
            overflow: "hidden",
            backgroundColor: colors.surface,
            borderWidth: 1,
            borderColor: colors.lineStrong,
            color: colors.ink2,
            fontSize: type.caption2,
            lineHeight: lineHeight.footnote,
            fontFamily: "Menlo",
          }}
        >
          {name}
        </Text>
      ))}
    </View>
  );
}

export function CanvasStep({
  node,
  spot,
  trigger,
  subtitle,
  run,
  selected,
  mark,
  problems,
  onPress,
}: Shared & {
  node: Extract<FlowGraphNode, { kind: "step" | "trigger" }>;
  spot: Spot;
  trigger: { title: string; subtitle: string };
  subtitle: (step: FlowStep) => string;
}) {
  const { colors } = useTheme();
  const step = node.kind === "step" ? node.step : null;
  const id = step?.id ?? "trigger";
  const own = mark?.(id);
  const dim = run && quiet(own);
  const asking = own?.status === "waiting" && own.run?.approval && !own.run.approval.decision;
  const problem = step ? problems?.get(step.id) : undefined;
  const ring = own?.status === "failed" || problem ? colors.red : asking ? colors.orange : selected === id ? colors.ink : colors.line;
  const state = own ? stepStateLook(own.status, own.run) : null;
  const title = step ? stepTitle(step) || "Untitled step" : trigger.title;
  const line = own?.text ?? (step ? subtitle(step) : trigger.subtitle);
  const tone = asking ? colors.orangeInk : own?.status === "failed" ? colors.redInk : colors.ink3;
  return (
    <View style={spot}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[title, line, problem ?? ""].filter(Boolean).join(". ")}
        onPress={() => {
          tap();
          onPress(id);
        }}
        style={{
          width: node.width,
          height: node.height,
          flexDirection: "row",
          alignItems: "center",
          gap: space.md,
          paddingHorizontal: space.lg,
          borderRadius: radius.card,
          borderCurve: "continuous",
          backgroundColor: colors.surface,
          borderWidth: ring === colors.line ? 1 : 2,
          borderColor: ring,
          opacity: dim ? DISABLED_OPACITY.control : 1,
        }}
      >
        <StepTile look={step ? stepLook(step.kind) : TRIGGER_LOOK} size={32} />
        <View style={{ flex: 1, gap: space.xxs }}>
          <Text numberOfLines={1} style={{ color: colors.ink, fontSize: type.subheadline, lineHeight: lineHeight.subheadline, fontWeight: "600" }}>
            {title}
          </Text>
          <Text numberOfLines={1} style={{ color: tone, fontSize: type.footnote, lineHeight: lineHeight.footnote }}>
            {line}
          </Text>
        </View>
        {problem ? <Icon icon={Alert02Icon} tone="redInk" size={16} /> : state?.icon ? <Icon icon={state.icon} tone={state.tone} size={18} /> : null}
      </Pressable>
      <Outputs names={step?.kind === "agent" && !dim ? step.output.map((field) => field.name).filter(Boolean) : []} width={node.width} />
    </View>
  );
}
