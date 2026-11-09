// The canvas section: a copy of the app's canvas (apps/desktop/app/src/components/CanvasView.tsx) on a fixed demo state.
// Projects are tinted sections with a card per Chat, Links run between cards, and the bar keeps the app's filters and
// zoom. While it's in view, one agent negotiates a change with the other across the Link; the first touch stops that,
// and the visitor can drag, pan, zoom, draw a Link between two cards or click one to remove it.
import {
  addEdge,
  Background,
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  Handle,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useViewport,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
// Loaded with the canvas, not inlined into every page: React holds the first render until both have loaded.
import flowCss from "@xyflow/react/dist/style.css?url";
import canvasCss from "./live-canvas.css?url";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

// The app's marks and the status line each one gives a card (packages/shared/src/canvas.ts canvasStatus).
type Mark = "waiting" | "running" | "delegated" | "unread" | "idle";
type Provider = "claude" | "codex";
type CardData = { title: string; mark: Mark; ago?: string; branch: string; provider: Provider; diff?: [number, number]; note?: { from: string; text: string } };
type SectionData = { name: string; icon: string; tone: string; chats: number };
type CanvasNode = Node<CardData, "card"> | Node<SectionData, "section">;
/** pulse sends a message dot along the Link (forward: source to target); agreed shows the negotiation's end. */
type LinkData = { activity?: string; pulse?: { way: "forward" | "back"; at: number }; agreed?: boolean };
/** Stops what travels along a Link, as its Stop button does in the app. */
const StopActivity = createContext<(id: string) => void>(() => {});

// CanvasView.tsx's geometry: 276px cards in two columns, 16px padding, a 52px header, 12px between cards.
const CARD = { width: 276, height: 62, gap: 12 };
const PAD = 16;
const HEADER = 52;

const PROJECTS: { id: string; section: SectionData; x: number; cards: (CardData & { id: string })[] }[] = [
  {
    id: "milagre",
    x: 0,
    section: { name: "milagre", icon: "/app-icon-64.webp", tone: "var(--accent)", chats: 5 },
    cards: [
      { id: "link", title: "Link Worktrees and share context", mark: "unread", ago: "2h", branch: "milagre/link-worktrees", provider: "claude" },
      { id: "timer", title: "Keep the Chat timer running", mark: "idle", ago: "1h", branch: "milagre/chat-timer", provider: "codex" },
      { id: "find", title: "Find Projects from the phone", mark: "unread", ago: "3h", branch: "milagre/find-projects", provider: "claude" },
      { id: "pairing", title: "Phone pairing follow-ups", mark: "idle", ago: "5m", branch: "milagre/phone-pairing", provider: "claude", diff: [48, 6] },
      { id: "swipe", title: "Swipe between Chat and Changes", mark: "waiting", branch: "milagre/swipe", provider: "claude", diff: [3, 1] },
    ],
  },
  {
    id: "relay",
    x: 700,
    section: { name: "relay", icon: "/demo/relay-icon.webp", tone: "var(--green)", chats: 2 },
    cards: [
      { id: "rate", title: "Rate-limit pairing attempts", mark: "idle", ago: "20m", branch: "relay/rate-limit", provider: "codex", diff: [22, 4] },
      { id: "sleep", title: "Reconnect after the Mac sleeps", mark: "unread", ago: "1d", branch: "relay/reconnect", provider: "claude" },
    ],
  },
];

function initialNodes(): CanvasNode[] {
  return PROJECTS.flatMap((project) => {
    const columns = [HEADER, HEADER];
    const cards = project.cards.map(({ id, ...card }, index) => {
      const column = project.cards.length > 1 ? index % 2 : 0;
      const position = { x: PAD + column * (CARD.width + PAD), y: columns[column]! };
      columns[column]! += CARD.height + CARD.gap;
      return {
        id: `${project.id}:${id}`,
        type: "card",
        parentId: project.id,
        extent: "parent",
        position,
        data: card,
        style: { width: CARD.width, height: CARD.height },
      } satisfies CanvasNode;
    });
    const width = PAD + (project.cards.length > 1 ? 2 : 1) * (CARD.width + PAD);
    const height = Math.max(...columns) - CARD.gap + PAD;
    return [
      {
        id: project.id,
        type: "section",
        position: { x: project.x, y: 0 },
        data: project.section,
        style: { width, height },
        dragHandle: ".canvas-drag-handle",
      } satisfies CanvasNode,
      ...cards,
    ];
  });
}

// The phone pairing Chat and the relay's rate limit agree on the pairing API, as linked agents do.
const ASKER = "milagre:pairing";
const ANSWERER = "relay:rate";
const LINK_ID = `link:${ASKER}:${ANSWERER}`;
function initialEdges(): Edge<LinkData>[] {
  return [link({ source: ASKER, target: ANSWERER })];
}

function link(connection: Pick<Connection, "source" | "target">, data: LinkData = {}): Edge<LinkData> {
  return {
    id: `link:${connection.source}:${connection.target}`,
    source: connection.source,
    target: connection.target,
    sourceHandle: "right",
    targetHandle: "left",
    type: "link",
    data,
  };
}

/** One dot per side; either end of a new Link can start at either dot. */
function LinkHandles() {
  return (
    <>
      <Handle type="source" position={Position.Left} id="left" className="canvas-handle" />
      <Handle type="source" position={Position.Right} id="right" className="canvas-handle" />
    </>
  );
}

function SectionNode({ data }: NodeProps<Node<SectionData, "section">>) {
  return (
    <div className="canvas-section" style={{ ["--section" as string]: data.tone }}>
      <div className="canvas-drag-handle canvas-section-header">
        <img src={data.icon} alt="" width="20" height="20" />
        <strong>{data.name}</strong>
        <span>{data.chats === 1 ? "1 Chat" : `${data.chats} Chats`}</span>
      </div>
    </div>
  );
}

const STATUS: Record<Mark, (ago?: string) => { label: string; tone: string }> = {
  waiting: () => ({ label: "Waiting for you", tone: "orange" }),
  running: () => ({ label: "Running", tone: "accent" }),
  delegated: () => ({ label: "Working on a Delegation", tone: "accent" }),
  unread: (ago) => ({ label: `Finished${ago === "now" ? " · just now" : ago ? ` · ${ago} ago` : ""}`, tone: "accent" }),
  idle: (ago) => ({ label: `Idle${ago === "now" ? " · just now" : ago ? ` · ${ago} ago` : ""}`, tone: "muted" }),
};

function CardNode({ data }: NodeProps<Node<CardData, "card">>) {
  const status = STATUS[data.mark](data.ago);
  return (
    <div className={`canvas-card ${data.mark === "waiting" ? "waiting" : ""}`}>
      <LinkHandles />
      <span className="canvas-card-row">
        <span className={`canvas-mark mark-${data.mark}`} />
        <strong>{data.title}</strong>
        {data.diff && (
          <span className="canvas-diff">
            <span className="add">+{data.diff[0]}</span> <span className="remove">−{data.diff[1]}</span>
          </span>
        )}
      </span>
      <span className="canvas-card-status">
        <span className={`tone-${status.tone}`}>{status.label}</span>
        <span className="canvas-branch">· {data.branch}</span>
        <img src={`/logos/${data.provider}.svg`} alt="" width="12" height="12" />
      </span>
      {data.note && (
        <p key={data.note.text} className="canvas-note">
          <strong>{data.note.from}</strong> {data.note.text}
        </p>
      )}
    </div>
  );
}

function LinkEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, data }: EdgeProps<Edge<LinkData>>) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 10 });
  const activity = data?.activity;
  const stop = useContext(StopActivity);
  const pulse = data?.pulse;
  return (
    <>
      <BaseEdge id={id} path={path} className={`canvas-link ${activity ? "active" : ""} ${selected ? "selected" : ""}`} />
      {pulse && <Pulse key={pulse.at} path={path} back={pulse.way === "back"} />}
      {activity && (
        <EdgeLabelRenderer>
          <div className="nodrag nopan canvas-activity" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            <span className={`canvas-activity-dot ${data?.agreed ? "agreed" : ""}`} />
            <span>{activity}</span>
            {!data?.agreed && (
              <button type="button" onClick={() => stop(id)}>
                Stop
              </button>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/** A message on its way along a Link: a dot that runs the path once. */
function Pulse({ path, back }: { path: string; back: boolean }) {
  const motion = useRef<SVGAnimateMotionElement>(null);
  // Added after the page's animation clock started, so it starts itself.
  useEffect(() => motion.current?.beginElement(), []);
  return (
    <circle r="5" className="canvas-pulse">
      <animateMotion ref={motion} begin="indefinite" dur="1.1s" fill="freeze" path={path} keyPoints={back ? "1;0" : "0;1"} keyTimes="0;1" calcMode="linear" />
    </circle>
  );
}

/** The app's zoom bar: out, the level, in, fit. */
function ZoomBar() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const { zoom } = useViewport();
  return (
    <div className="nodrag nopan canvas-zoom">
      <button type="button" aria-label="Zoom out" onClick={() => void zoomOut()}>
        −
      </button>
      <span>{Math.round(zoom * 100)}%</span>
      <button type="button" aria-label="Zoom in" onClick={() => void zoomIn()}>
        +
      </button>
      <button type="button" aria-label="Fit the canvas" onClick={() => void fitView({ padding: 0.12 })}>
        ⇿
      </button>
    </div>
  );
}

// The tour: milagre's pairing Chat asks relay's for a change across the Link, relay's makes it and answers, and the
// two agree. It plays while the canvas is in view and stops for good at the visitor's first touch.
type Step = { wait: number; link?: LinkData; cards?: Record<string, Partial<CardData>> };
const TOUR: Step[] = [
  {
    wait: 1300,
    link: { activity: "Negotiation · round 1 of 10", pulse: { way: "forward", at: 1 } },
    cards: { [ASKER]: { mark: "running" } },
  },
  {
    wait: 1600,
    cards: { [ANSWERER]: { mark: "delegated", note: { from: "milagre", text: "Can a refused pairing say when to retry?" } } },
  },
  { wait: 1300, cards: { [ANSWERER]: { diff: [31, 4] } } },
  {
    wait: 1500,
    link: { activity: "Negotiation · round 2 of 10", pulse: { way: "back", at: 2 } },
    cards: { [ANSWERER]: { mark: "unread", ago: "now" } },
  },
  { wait: 1500, cards: { [ASKER]: { note: { from: "relay", text: "Done: 429 with Retry-After: 30" } } } },
  { wait: 1300, cards: { [ASKER]: { diff: [57, 6] } } },
  { wait: 3000, link: { activity: "Contract agreed", agreed: true }, cards: { [ASKER]: { mark: "unread", ago: "now" } } },
];

const nodeTypes = { section: SectionNode, card: CardNode };
const edgeTypes = { link: LinkEdge };

export default function LiveCanvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(initialNodes());
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge<LinkData>>(initialEdges());
  const stop = useCallback((id: string) => setEdges((current) => current.map((edge) => (edge.id === id ? { ...edge, data: {} } : edge))), [setEdges]);
  const [selected, setSelected] = useState<string | null>(null);
  const section = useRef<HTMLElement>(null);
  const counts = nodes.reduce(
    (sum, node) => {
      if (node.type !== "card") return sum;
      const mark = (node.data as CardData).mark;
      return { all: sum.all + 1, needs: sum.needs + (mark === "waiting" ? 1 : 0), running: sum.running + (mark === "running" || mark === "delegated" ? 1 : 0) };
    },
    { all: 0, needs: 0, running: 0 },
  );

  // Back to the demo's own data, keeping wherever the visitor dragged things.
  const restore = useCallback(() => {
    const original = new Map(initialNodes().map((node) => [node.id, node.data]));
    setNodes((current) => current.map((node) => ({ ...node, data: original.get(node.id) ?? node.data }) as CanvasNode));
    setEdges((current) => current.map((edge) => (edge.id === LINK_ID ? { ...edge, data: {} } : edge)));
  }, [setNodes, setEdges]);

  useEffect(() => {
    const host = section.current;
    if (!host || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let run = 0;
    let visible = false;
    let playing = false;
    let finished = false;
    const wait = (ms: number, id: number) =>
      new Promise<void>((resolve, reject) => setTimeout(() => (id === run ? resolve() : reject(new Error("stopped"))), ms));
    const play = async () => {
      const id = ++run;
      playing = true;
      try {
        await wait(700, id);
        for (const step of TOUR) {
          if (step.link)
            setEdges((current) => current.map((edge) => (edge.id === LINK_ID ? { ...edge, data: { ...edge.data, pulse: undefined, ...step.link } } : edge)));
          if (step.cards)
            setNodes((current) =>
              current.map((node) => (step.cards![node.id] ? ({ ...node, data: { ...node.data, ...step.cards![node.id] } } as CanvasNode) : node)),
            );
          await wait(step.wait, id);
        }
        restore();
        await wait(1600, id);
        playing = false;
        if (visible && !finished) void play();
      } catch {
        playing = false;
      }
    };
    const halt = () => {
      if (finished) return;
      finished = true;
      run++;
      restore();
    };
    const types = ["pointerdown", "keydown", "wheel"] as const;
    for (const type of types) host.addEventListener(type, halt, { once: true, passive: true });
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = !!entry?.isIntersecting;
        if (finished) return;
        if (visible && !playing) void play();
        else if (!visible && playing) {
          run++;
          playing = false;
          restore();
        }
      },
      { threshold: 0.5 },
    );
    observer.observe(host);
    return () => {
      run++;
      observer.disconnect();
      for (const type of types) host.removeEventListener(type, halt);
    };
  }, [restore, setEdges, setNodes]);

  return (
    <StopActivity value={stop}>
      <link rel="stylesheet" href={flowCss} precedence="default" />
      <link rel="stylesheet" href={canvasCss} precedence="default" />
      <section data-canvas className="canvas-window" ref={section}>
        <span className="canvas-lights" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <div className="canvas-bar">
          <a className="canvas-back" href="#designs">
            ← Back
          </a>
          <span className="canvas-spacer" />
          {selected && (
            <button
              type="button"
              className="canvas-remove"
              onClick={() => {
                setEdges((current) => current.filter((edge) => edge.id !== selected));
                setSelected(null);
              }}
            >
              Remove Link
            </button>
          )}
          <div className="canvas-filters" aria-label="Chats on the canvas">
            <span className="on">
              All <b>{counts.all}</b>
            </span>
            <span>
              <i className="needs" />
              Needs you <b>{counts.needs}</b>
            </span>
            <span>
              <i className="running" />
              Running <b>{counts.running}</b>
            </span>
          </div>
        </div>
        <div className="canvas-flow">
          <ReactFlow
            className="milagre-canvas-flow"
            colorMode="dark"
            nodes={nodes}
            edges={edges.map((edge) => ({ ...edge, selected: edge.id === selected }))}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            connectionMode={"loose" as never}
            onConnect={(connection) => {
              if (connection.source === connection.target) return;
              setEdges((current) => addEdge(link(connection), current));
            }}
            onEdgeClick={(_event, edge) => setSelected(edge.id)}
            onPaneClick={() => setSelected(null)}
            fitView
            fitViewOptions={{ padding: 0.12 }}
            nodesConnectable
            edgesReconnectable={false}
            deleteKeyCode={null}
            // The page keeps its scroll: zoom with the buttons, a pinch, or ⌘/Ctrl and the wheel.
            zoomOnScroll={false}
            proOptions={{ hideAttribution: true }}
            preventScrolling={false}
            minZoom={0.3}
            maxZoom={1.6}
          >
            <Background gap={24} size={1} color="oklch(0.44 0.03 258)" />
            <ZoomBar />
          </ReactFlow>
        </div>
      </section>
    </StopActivity>
  );
}
