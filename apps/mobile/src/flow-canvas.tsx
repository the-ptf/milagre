import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import Svg, { Path } from "react-native-svg";
import { Add01Icon } from "@hugeicons/core-free-icons";
import type { FlowStep, FlowStepRun } from "@milagre/shared/model";
import { layoutFlow, runPath, type FlowGraph, type FlowGraphEdge, type FlowPlace } from "@milagre/shared/routine-flow-graph";
import { Icon } from "./icons";
import { hitSlopFor, radius, space, type } from "./design-tokens";
import { DISABLED_OPACITY, PRESSED_OPACITY, tap } from "./ui";
import { useTheme } from "./theme";
import { CanvasCondition, CanvasPath, CanvasPathLabel, CanvasStep, type CanvasMark, type Spot } from "./flow-canvas-nodes";

export type { CanvasMark } from "./flow-canvas-nodes";

const SIZES = { step: { width: 236, height: 60 }, condition: { height: 40 }, empty: { width: 160, height: 32 }, gapY: 64, gapX: 40, pathGap: 56, mergeGap: 28 };
const PAD = 32;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 1.6;
const CORNER = 8;
const AnimatedPath = Animated.createAnimatedComponent(Path);

type Camera = {
  x: SharedValue<number>;
  y: SharedValue<number>;
  k: SharedValue<number>;
  start: SharedValue<{ x: number; y: number; k: number; fx: number; fy: number }>;
};

function route(edge: FlowGraphEdge, ox: number): string {
  const a = { x: edge.from.x + ox, y: edge.from.y + PAD };
  const b = { x: edge.to.x + ox, y: edge.to.y + PAD };
  if (Math.abs(a.x - b.x) < 1) return `M${a.x} ${a.y} L${b.x} ${b.y}`;
  const d = b.x > a.x ? CORNER : -CORNER;
  if (edge.kind === "merge") return `M${a.x} ${a.y} L${a.x} ${b.y - CORNER} Q${a.x} ${b.y} ${a.x + d} ${b.y} L${b.x} ${b.y}`;
  const turn = edge.kind === "path" ? a.y + 18 : b.y - 18;
  return `M${a.x} ${a.y} L${a.x} ${turn - CORNER} Q${a.x} ${turn} ${a.x + d} ${turn} L${b.x - d} ${turn} Q${b.x} ${turn} ${b.x} ${turn + CORNER} L${b.x} ${b.y}`;
}

const arrow = (x: number, y: number) => `M${x - 4} ${y - 6} L${x} ${y} L${x + 4} ${y - 6}`;

function panZoomGesture(camera: Camera, onInteract?: (active: boolean) => void) {
  const { start } = camera;
  const pan = Gesture.Pan()
    .minDistance(4)
    .onBegin(() => {
      start.set({ ...start.get(), x: camera.x.get(), y: camera.y.get() });
      if (onInteract) scheduleOnRN(onInteract, true);
    })
    .onUpdate((event) => {
      camera.x.set(start.get().x + event.translationX);
      camera.y.set(start.get().y + event.translationY);
    })
    .onFinalize(() => {
      if (onInteract) scheduleOnRN(onInteract, false);
    });
  const pinch = Gesture.Pinch()
    .onBegin((event) => {
      start.set({ x: camera.x.get(), y: camera.y.get(), k: camera.k.get(), fx: event.focalX, fy: event.focalY });
    })
    .onUpdate((event) => {
      const from = start.get();
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, from.k * event.scale));
      camera.k.set(next);
      camera.x.set(from.fx - ((from.fx - from.x) * next) / from.k);
      camera.y.set(from.fy - ((from.fy - from.y) * next) / from.k);
    });
  return Gesture.Simultaneous(pan, pinch);
}

function LiveLine({ d, color }: { d: string; color: string }) {
  const reduced = useReducedMotion();
  const offset = useSharedValue(0);
  useEffect(() => {
    offset.set(withRepeat(withTiming(reduced ? 1 : -12, { duration: 800, easing: reduced ? Easing.steps(2) : Easing.linear }), -1, reduced));
  }, [offset, reduced]);
  const props = useAnimatedProps(() =>
    reduced ? { strokeDashoffset: 0, opacity: 1 - offset.get() * (1 - PRESSED_OPACITY) } : { strokeDashoffset: offset.get(), opacity: 1 },
  );
  return <AnimatedPath d={d} stroke={color} strokeWidth={2} fill="none" strokeDasharray={reduced ? undefined : "6 6"} animatedProps={props} />;
}

function Lines({
  graph,
  ox,
  run,
  reached,
  runState,
}: {
  graph: FlowGraph;
  ox: number;
  run: boolean;
  reached: (id: string) => boolean;
  runState?: Record<string, FlowStepRun>;
}) {
  const { colors } = useTheme();
  return (
    <Svg width={graph.bounds.width + PAD * 2} height={graph.bounds.height + PAD * 2 + 40} style={{ position: "absolute", left: 0, top: 0 }}>
      {graph.edges.map((edge) => {
        const on = run && reached(edge.from.id) && reached(edge.to.id);
        const color = on ? colors.green : colors.lineStrong;
        const d = route(edge, ox);
        if (on && runState?.[edge.to.id]?.status === "running") return <LiveLine key={edge.id} d={d} color={color} />;
        return (
          <Path
            key={edge.id}
            d={edge.kind === "merge" ? d : `${d} ${arrow(edge.to.x + ox, edge.to.y + PAD)}`}
            stroke={color}
            strokeWidth={on ? 2 : 1.5}
            strokeDasharray={run && !on ? "4 4" : undefined}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={run && !on ? PRESSED_OPACITY : 1}
            fill="none"
          />
        );
      })}
      {!run && graph.end.from.id !== "trigger" ? (
        <Path d={`M${ox} ${graph.end.from.y + PAD} L${ox} ${graph.end.y + PAD}`} stroke={colors.lineStrong} strokeWidth={1.5} />
      ) : null}
    </Svg>
  );
}

function AddDot({ where, spot, onAdd }: { where: FlowPlace; spot: Spot; onAdd: (where: FlowPlace) => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={where.parentId ? `Add to the ${where.branch === "yes" ? "Yes" : "Otherwise"} path` : "Add a step here"}
      hitSlop={hitSlopFor(24)}
      onPress={() => {
        tap();
        onAdd(where);
      }}
      style={[
        spot,
        {
          width: 24,
          height: 24,
          marginLeft: -12,
          marginTop: -12,
          borderRadius: radius.full,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.lineStrong,
        },
      ]}
    >
      <Icon icon={Add01Icon} tone="ink3" size={12} />
    </Pressable>
  );
}

function addSpot(edge: FlowGraphEdge) {
  if (edge.kind === "merge") return { x: edge.from.x, y: edge.from.y + 16 };
  if (edge.kind === "path") return { x: edge.to.x, y: edge.to.y - 16 };
  return { x: edge.to.x, y: (edge.from.y + edge.to.y) / 2 };
}

function useCamera(width: number, height: number, graph: FlowGraph, ox: number, focus: string | null): Camera {
  const camera = { x: useSharedValue(0), y: useSharedValue(0), k: useSharedValue(1), start: useSharedValue({ x: 0, y: 0, k: 1, fx: 0, fy: 0 }) };
  const framed = useRef(false);
  useEffect(() => {
    if (!width || framed.current) return;
    framed.current = true;
    const zoom = Math.max(0.7, Math.min(1, width / (graph.bounds.width + PAD * 2)));
    const target = focus ? graph.nodes.find((node) => node.id === focus) : undefined;
    camera.k.set(zoom);
    camera.x.set(width / 2 - ((target ? target.x + target.width / 2 : 0) + ox) * zoom);
    camera.y.set(target ? Math.min(0, height * 0.45 - (target.y + PAD + target.height / 2) * zoom) : 0);
  }, [width, height, graph, ox, focus, camera.k, camera.x, camera.y]);
  return camera;
}

export function FlowCanvas({
  steps,
  trigger,
  subtitle,
  height,
  mark,
  runState,
  selected = null,
  focus = null,
  problems,
  onPress,
  onAdd,
  onInteract,
}: {
  steps: FlowStep[];
  trigger: { title: string; subtitle: string };
  subtitle: (step: FlowStep) => string;
  height: number;
  mark?: (id: string) => CanvasMark | undefined;
  runState?: Record<string, FlowStepRun>;
  selected?: string | null;
  focus?: string | null;
  problems?: ReadonlyMap<string, string>;
  onPress: (id: string) => void;
  onAdd?: (where: FlowPlace) => void;
  onInteract?: (active: boolean) => void;
}) {
  const { colors } = useTheme();
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const graph = useMemo(() => layoutFlow(steps, { sizes: SIZES, collapsed: folded }), [steps, folded]);
  const path = useMemo(() => (runState ? runPath(steps, runState) : null), [steps, runState]);
  const [width, setWidth] = useState(0);
  const ox = -graph.bounds.x + PAD;
  const camera = useCamera(width, height, graph, ox, focus);
  const moved = useAnimatedStyle(() => ({ transform: [{ translateX: camera.x.get() }, { translateY: camera.y.get() }, { scale: camera.k.get() }] }));
  const run = Boolean(mark);
  const reached = (id: string) => path?.reached.has(id) ?? false;
  const at = (left: number, top: number): Spot => ({ position: "absolute", left: left + ox, top: top + PAD });
  const toggle = (key: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const shared = { run, selected, mark, problems, onPress };

  return (
    <GestureDetector gesture={panZoomGesture(camera, onInteract)}>
      <View
        onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
        style={{ height, overflow: "hidden", borderRadius: radius.card, borderCurve: "continuous", backgroundColor: colors.canvas }}
      >
        <Animated.View
          style={[
            { position: "absolute", left: 0, top: 0, width: graph.bounds.width + PAD * 2, height: graph.bounds.height + PAD * 2 + 40, transformOrigin: "0 0" },
            moved,
          ]}
        >
          <Lines graph={graph} ox={ox} run={run} reached={reached} runState={runState} />
          {graph.merges.map((merge) => (
            <View
              key={merge.id}
              style={[
                at(merge.x - 4, merge.y - 4),
                {
                  width: 8,
                  height: 8,
                  borderRadius: radius.full,
                  backgroundColor: colors.ink4,
                  opacity: run && !reached(merge.id) ? DISABLED_OPACITY.control : 1,
                },
              ]}
            />
          ))}
          {graph.edges.map((edge) => {
            if (edge.kind !== "path") return null;
            const key = `${edge.from.id}:${edge.branch}`;
            const decided = Boolean(path?.takenPaths.has(`${edge.from.id}:yes`) || path?.takenPaths.has(`${edge.from.id}:otherwise`));
            return (
              <CanvasPathLabel
                key={`label:${key}`}
                branch={edge.branch === "yes" ? "yes" : "otherwise"}
                spot={at(edge.to.x - (edge.branch === "yes" ? 24 : 42), edge.from.y + 12)}
                taken={path?.takenPaths.has(key) ?? false}
                faded={run && decided && !(path?.takenPaths.has(key) ?? false)}
                folded={folded.has(key)}
                onToggle={() => toggle(key)}
              />
            );
          })}
          {graph.nodes.map((node) => {
            const spot = at(node.x, node.y);
            if (node.kind === "condition") return <CanvasCondition key={node.id} node={node} spot={spot} {...shared} />;
            if (node.kind === "step" || node.kind === "trigger")
              return <CanvasStep key={node.id} node={node} spot={spot} trigger={trigger} subtitle={subtitle} {...shared} />;
            return <CanvasPath key={node.id} node={node} spot={spot} dim={run && !reached(node.id)} onAdd={onAdd} onToggle={toggle} />;
          })}
          {onAdd
            ? graph.edges.map((edge) =>
                edge.where ? <AddDot key={`add:${edge.id}`} where={edge.where} spot={at(addSpot(edge).x, addSpot(edge).y)} onAdd={onAdd} /> : null,
              )
            : null}
          {onAdd ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add a step at the end"
              onPress={() => {
                tap();
                onAdd(graph.end.where);
              }}
              style={[
                at(-60, graph.end.y),
                {
                  width: 120,
                  height: 32,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: space.sm,
                  borderRadius: radius.full,
                  borderWidth: 1,
                  borderStyle: "dashed",
                  borderColor: colors.lineStrong,
                  backgroundColor: colors.surface,
                },
              ]}
            >
              <Icon icon={Add01Icon} tone="ink3" size={12} />
              <Text style={{ color: colors.ink3, fontSize: type.footnote }}>Add a step</Text>
            </Pressable>
          ) : null}
        </Animated.View>
      </View>
    </GestureDetector>
  );
}
