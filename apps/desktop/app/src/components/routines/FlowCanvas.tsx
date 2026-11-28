import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { ReactFlow, ReactFlowProvider, Panel, ViewportPortal, useReactFlow, useStore, useViewport, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { FlowStep } from "@milagre/shared/model";
import { layoutFlow, runPath, type FlowGraph, type FlowGraphEdge, type FlowGraphPoint } from "@milagre/shared/routine-flow-graph";
import { flattenSteps, stepReads } from "@milagre/shared/routine-flows";
import { ZoomBar } from "../primitives/ZoomBar";
import { AddButton, CanvasContext, ConditionNode, PathNode, StepNode, TriggerNode, type CanvasHandlers } from "./FlowCanvasNodes";

const nodeTypes = { trigger: TriggerNode, step: StepNode, condition: ConditionNode, path: PathNode };
const ZOOM_MS = 180;
const FAR = 0.6;
const CORNER = 8;

export type FlowCanvasProps = Omit<CanvasHandlers, "lit" | "badRefs" | "toggleFold"> & {
  steps: FlowStep[];
  runState?: Record<string, { status: string; taken?: "yes" | "otherwise" }>;
  focus?: string | null;
  viewKey: string;
};

function route(edge: FlowGraphEdge): string {
  const { from: a, to: b } = edge;
  if (Math.abs(a.x - b.x) < 1) return `M${a.x} ${a.y} L${b.x} ${b.y}`;
  const d = b.x > a.x ? CORNER : -CORNER;
  const turn = edge.kind === "merge" ? b.y : edge.kind === "path" ? a.y + 18 : b.y - 18;
  const down = edge.kind === "merge" ? "" : ` Q${b.x} ${turn} ${b.x} ${turn + CORNER} L${b.x} ${b.y}`;
  const end = edge.kind === "merge" ? ` L${b.x} ${b.y}` : "";
  return `M${a.x} ${a.y} L${a.x} ${turn - CORNER} Q${a.x} ${turn} ${a.x + d} ${turn} L${b.x - (edge.kind === "merge" ? 0 : d)} ${turn}${down}${end}`;
}

function wire(from: FlowGraphPoint, to: FlowGraphPoint): string {
  const bend = Math.min(-96, to.x - from.x - 64);
  return `M${from.x} ${from.y} C${from.x + bend} ${from.y + 48}, ${to.x - 120} ${to.y}, ${to.x - 4} ${to.y}`;
}

function toNodes(graph: FlowGraph): Node[] {
  return graph.nodes.map((node) => {
    const base = { id: node.id, position: { x: node.x, y: node.y }, draggable: false, connectable: false, selectable: false };
    if (node.kind === "trigger") return { ...base, type: "trigger", data: {}, width: node.width, height: node.height };
    if (node.kind === "step" || node.kind === "condition")
      return { ...base, type: node.kind, data: { step: node.step, where: node.where }, width: node.width, height: node.height };
    const foldKey = node.id.slice(node.kind.length + 1);
    return { ...base, type: "path", data: { kind: node.kind, count: node.count, where: node.where, foldKey }, width: node.width, height: node.height };
  });
}

function Lines({
  graph,
  handlers,
  runState,
  path,
}: {
  graph: FlowGraph;
  handlers: CanvasHandlers;
  runState: FlowCanvasProps["runState"];
  path: ReturnType<typeof runPath> | null;
}) {
  const run = handlers.mode === "run";
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const selected = handlers.selected ? byId.get(handlers.selected) : undefined;
  const reads = run || !selected || selected.kind === "trigger" || !("step" in selected) ? [] : stepReads(selected.step);
  const foldable = new Map<string, { x: number; y: number; branch: "yes" | "otherwise"; ifId: string }>();
  for (const edge of graph.edges) {
    if (edge.kind !== "path") continue;
    const ifId = edge.from.id;
    foldable.set(`${ifId}:${edge.branch}`, { x: edge.to.x, y: edge.from.y + 22, branch: edge.branch!, ifId });
  }
  const reached = (id: string) => path?.reached.has(id) ?? false;
  return (
    <ViewportPortal>
      <svg data-flow-lines className="pointer-events-none absolute top-0 left-0 overflow-visible" width={1} height={1}>
        <defs>
          {(["muted", "on"] as const).map((tone) => (
            <marker key={tone} id={`flow-arrow-${tone}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto">
              <path
                d="M1 1 L7 4 L1 7"
                fill="none"
                stroke={tone === "on" ? "var(--green)" : "var(--ink-4)"}
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </marker>
          ))}
        </defs>
        {graph.edges.map((edge) => {
          const on = run && reached(edge.from.id) && reached(edge.to.id);
          const live = run && on && runState?.[edge.to.id]?.status === "running";
          const off = run && !on;
          return (
            <path
              key={edge.id}
              data-flow-line={edge.id}
              data-on={on || undefined}
              className={live ? "flow-line-live" : undefined}
              d={route(edge)}
              fill="none"
              stroke={on ? "var(--green)" : "var(--line-strong)"}
              strokeWidth={on ? 2 : 1.5}
              strokeDasharray={off ? "4 4" : undefined}
              opacity={off ? 0.6 : 1}
              markerEnd={edge.kind === "merge" ? undefined : `url(#flow-arrow-${on ? "on" : "muted"})`}
            />
          );
        })}
        {graph.end.from.id !== "trigger" && !run && <path d={`M0 ${graph.end.from.y} L0 ${graph.end.y - 2}`} stroke="var(--line-strong)" strokeWidth={1.5} />}
        {reads.map((ref, index) => {
          const owner = ref.split(".")[0]!;
          const source = byId.get(owner);
          if (!source || !selected) return null;
          const from = { id: owner, x: source.x + source.width / 2, y: source.y + source.height + 10 };
          const to = { id: selected.id, x: selected.x, y: selected.y + selected.height / 2 + (index - (reads.length - 1) / 2) * 8 };
          const bad = handlers.badRefs.has(ref);
          return (
            <g key={ref} data-flow-wire={ref}>
              <path d={wire(from, to)} fill="none" stroke={bad ? "var(--red)" : "var(--ink)"} strokeWidth={1.5} strokeDasharray="3 4" strokeLinecap="round" />
              <circle cx={to.x - 4} cy={to.y} r={3} fill={bad ? "var(--red)" : "var(--ink)"} />
            </g>
          );
        })}
      </svg>
      {graph.merges.map((merge) => (
        <span
          key={merge.id}
          aria-hidden
          className={`absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink-4 ${run && !reached(merge.id) ? "opacity-40" : ""}`}
          style={{ left: merge.x, top: merge.y }}
        />
      ))}
      {[...foldable].map(([key, spot]) => {
        const taken = path?.takenPaths.has(key) ?? false;
        const decided = run && Boolean(path?.takenPaths.has(`${spot.ifId}:yes`) || path?.takenPaths.has(`${spot.ifId}:otherwise`));
        const folded = graph.nodes.some((node) => node.id === `collapsed:${key}`);
        return (
          <button
            key={key}
            type="button"
            data-flow-path-label={key}
            aria-expanded={!folded}
            aria-label={`${folded ? "Unfold" : "Fold"} the ${spot.branch === "yes" ? "Yes" : "Otherwise"} path`}
            onClick={() => handlers.toggleFold(key)}
            className={`nodrag nopan pointer-events-auto absolute flex h-5 -translate-x-1/2 -translate-y-1/2 items-center gap-0.5 rounded-full px-2 text-11 font-semibold whitespace-nowrap transition-colors ${
              taken ? "bg-green-tint text-green-ink" : "bg-field text-ink-2 hover:bg-hover-2 hover:text-ink"
            } ${run && decided && !taken ? "opacity-50" : ""}`}
            style={{ left: spot.x, top: spot.y }}
          >
            {spot.branch === "yes" ? "Yes" : "Otherwise"}
            <HugeiconsIcon icon={folded ? ArrowRight01Icon : ArrowDown01Icon} size={12} strokeWidth={1.8} color="currentColor" />
          </button>
        );
      })}
      {!run &&
        graph.edges.map((edge) => {
          if (!edge.where) return null;
          const spot =
            edge.kind === "merge"
              ? { x: edge.from.x, y: edge.from.y + 16 }
              : edge.kind === "path"
                ? { x: edge.to.x, y: edge.to.y - 16 }
                : { x: edge.to.x, y: (edge.from.y + edge.to.y) / 2 };
          return (
            <span key={`add:${edge.id}`} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: spot.x, top: spot.y }}>
              <AddButton
                where={edge.where}
                className="flow-add flex size-4 items-center justify-center rounded-full bg-surface text-ink-4 ring-1 ring-line-strong transition-all"
              />
            </span>
          );
        })}
      {!run && (
        <span className="absolute -translate-x-1/2" style={{ left: 0, top: graph.end.y }}>
          <AddButton
            where={graph.end.where}
            label="Add a step at the end"
            className="flex h-7 items-center gap-1.5 rounded-full border border-dashed border-line-strong bg-surface px-3 text-12 whitespace-nowrap text-ink-3 transition-colors hover:border-ink-3 hover:text-ink"
          >
            <span aria-hidden>+</span> Add a step
          </AddButton>
        </span>
      )}
    </ViewportPortal>
  );
}

function Zoom() {
  const flow = useReactFlow();
  const { zoom } = useViewport();
  return (
    <ZoomBar
      data-flow-zoom
      zoom={zoom}
      onZoomOut={() => void flow.zoomOut({ duration: ZOOM_MS })}
      onReset={() => void flow.zoomTo(1, { duration: ZOOM_MS })}
      onZoomIn={() => void flow.zoomIn({ duration: ZOOM_MS })}
      onFit={() => void flow.fitView({ padding: 0.12, duration: ZOOM_MS, minZoom: 0.2 })}
      fitLabel="Show the whole flow"
    />
  );
}

function Camera({
  graph,
  focus,
  viewKey,
  box,
}: {
  graph: FlowGraph;
  focus: string | null | undefined;
  viewKey: string;
  box: RefObject<HTMLDivElement | null>;
}) {
  const flow = useReactFlow();
  const initialized = useStore((state) => state.width > 0 && state.height > 0 && state.panZoom !== null);
  const framed = useRef<string | null>(null);
  useEffect(() => {
    if (!initialized || framed.current === viewKey) return;
    framed.current = viewKey;
    const width = box.current?.clientWidth || 800;
    const height = box.current?.clientHeight || 600;
    const target = focus ? graph.nodes.find((node) => node.id === focus) : undefined;
    const across = Math.min(1, (width - 48) / Math.max(1, graph.bounds.width + 120));
    const zoom = Math.max(FAR, across);
    const centerX = width / 2 - (graph.bounds.x + graph.bounds.width / 2) * zoom;
    if (target) {
      const x = across >= FAR ? centerX : width / 2 - (target.x + target.width / 2) * zoom;
      void flow.setViewport({ x, y: Math.min(56, height * 0.55 - (target.y + target.height / 2) * zoom), zoom });
      return;
    }
    void flow.setViewport({ x: across >= FAR ? centerX : width / 2, y: 40, zoom });
  }, [initialized, viewKey]);
  return null;
}

function Surface(props: FlowCanvasProps) {
  const { steps, runState, focus, viewKey, ...handlers } = props;
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const graph = useMemo(() => layoutFlow(steps, { collapsed: folded }), [steps, folded]);
  const nodes = useMemo(() => toNodes(graph), [graph]);
  const path = useMemo(() => (runState ? runPath(steps, runState as never) : null), [steps, runState]);
  const box = useRef<HTMLDivElement>(null);
  const far = useStore((state) => state.transform[2] < FAR);
  const selectedStep = handlers.selected ? flattenSteps(steps).find((entry) => entry.step.id === handlers.selected)?.step : undefined;
  const reads = handlers.mode === "edit" && selectedStep ? stepReads(selectedStep) : [];
  const problem = selectedStep ? handlers.problems.get(selectedStep.id) : undefined;
  const { mark } = handlers;
  const value = useMemo<CanvasHandlers>(
    () => ({
      ...handlers,
      lit: new Set(reads),
      badRefs: new Set(reads.filter((ref) => problem?.includes(ref))),
      mark: mark && ((id: string) => mark(id) ?? (path?.reached.has(id) ? { status: "done", state: null, text: "", tone: "" } : undefined)),
      toggleFold: (key: string) =>
        setFolded((current) => {
          const next = new Set(current);
          if (!next.delete(key)) next.add(key);
          return next;
        }),
    }),
    [handlers, reads, problem, mark, path, setFolded],
  );
  return (
    <CanvasContext.Provider value={value}>
      <div
        ref={box}
        data-flow-canvas={handlers.mode}
        data-far={far || undefined}
        className="flow-canvas relative h-full w-full overflow-hidden rounded-window bg-canvas"
      >
        <ReactFlow
          nodes={nodes}
          edges={[]}
          nodeTypes={nodeTypes}
          onNodeClick={(_event, node) => {
            if (node.type !== "path") handlers.select(node.id);
          }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          minZoom={0.2}
          maxZoom={1.6}
          zoomOnDoubleClick={false}
          panOnScroll
          deleteKeyCode={null}
          proOptions={{ hideAttribution: true }}
        >
          <Lines graph={graph} handlers={value} runState={runState} path={path} />
          <Camera graph={graph} focus={focus} viewKey={viewKey} box={box} />
          <Panel position="bottom-left" style={{ margin: "0 0 12px 12px" }}>
            <Zoom />
          </Panel>
        </ReactFlow>
      </div>
    </CanvasContext.Provider>
  );
}

export function FlowCanvas(props: FlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <Surface {...props} />
    </ReactFlowProvider>
  );
}
