// The canvas section: the app's own React Flow canvas (apps/desktop/app/src/components/CanvasView.tsx), with its Project
// and Worktree nodes, Link handles, Links and Controls, on a fixed demo state. Drag a Project, pan, zoom, drag from a
// blue handle to another node to Link it, or click a Link to remove it.
import {
  addEdge,
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getSmoothStepPath,
  Handle,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
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

type Mark = "waiting" | "running" | "unread" | "idle";
type Chat = { title: string; mark: Mark };
type ProjectData = { kind: "project"; name: string };
type WorktreeData = { kind: "worktree"; branch: string; diff?: string; chats: Chat[]; note?: { from: string; text: string } };
type CanvasNode = Node<ProjectData | WorktreeData>;
/** pulse sends a message dot along the Link (forward: source to target); agreed marks the negotiation done. */
type LinkData = { activity?: string; pulse?: { way: "forward" | "back"; at: number }; agreed?: boolean };
/** Stops what travels along a Link, as its Stop button does in the app. */
const StopActivity = createContext<(id: string) => void>(() => {});

const PROJECT_WIDTH = 330;
const WORKTREE = { width: 290, height: 178, gap: 194, top: 64 };

// Same Chats and branches as the sidebar above.
const PROJECTS: { id: string; name: string; x: number; worktrees: Omit<WorktreeData, "kind">[] }[] = [
  {
    id: "milagre",
    name: "milagre",
    x: 0,
    worktrees: [
      { branch: "main", chats: [{ title: "Release notes", mark: "idle" }] },
      { branch: "milagre/victor", diff: "+3 −1", chats: [{ title: "Swipe between Chat and Changes", mark: "waiting" }] },
      { branch: "milagre/marcos", diff: "+48 −6", chats: [{ title: "Phone pairing follow-ups", mark: "running" }] },
    ],
  },
  {
    id: "relay",
    name: "relay",
    x: 440,
    worktrees: [
      { branch: "main", chats: [{ title: "Release notes", mark: "idle" }] },
      { branch: "milagre/marcos", diff: "+22 −4", chats: [{ title: "Rate-limit pairing attempts", mark: "unread" }] },
    ],
  },
];

function initialNodes(): CanvasNode[] {
  return PROJECTS.flatMap((project) => [
    {
      id: project.id,
      type: "project",
      position: { x: project.x, y: 0 },
      data: { kind: "project", name: project.name },
      style: { width: PROJECT_WIDTH, height: 74 + project.worktrees.length * WORKTREE.gap },
      dragHandle: ".canvas-drag-handle",
    } satisfies CanvasNode,
    ...project.worktrees.map(
      (worktree, index) =>
        ({
          id: `${project.id}:${index}`,
          type: "worktree",
          parentId: project.id,
          extent: "parent",
          position: { x: 20, y: WORKTREE.top + index * WORKTREE.gap },
          data: { kind: "worktree", ...worktree },
          style: { width: WORKTREE.width, height: WORKTREE.height },
          dragHandle: ".canvas-drag-handle",
        }) satisfies CanvasNode,
    ),
  ]);
}

// The pairing Worktree and the relay's rate limit agree on the pairing API, as linked agents do.
const NEGOTIATING = "Negotiating the pairing API";
function initialEdges(): Edge<LinkData>[] {
  return [link({ source: "milagre:2", target: "relay:1" }, NEGOTIATING)];
}

function link(connection: Pick<Connection, "source" | "target">, activity?: string): Edge<LinkData> {
  return {
    id: `link:${connection.source}:${connection.target}`,
    source: connection.source,
    target: connection.target,
    sourceHandle: "right-source",
    targetHandle: "left-target",
    type: "link",
    data: { activity },
    style: { stroke: "var(--ink-3)", strokeWidth: 2 },
  };
}

function LinkHandles() {
  return (
    <>
      <Handle type="target" position={Position.Left} id="left-target" className="canvas-handle" />
      <Handle type="source" position={Position.Left} id="left-source" className="canvas-handle" style={{ top: "65%" }} />
      <Handle type="target" position={Position.Right} id="right-target" className="canvas-handle" />
      <Handle type="source" position={Position.Right} id="right-source" className="canvas-handle" style={{ top: "65%" }} />
    </>
  );
}

function ProjectNode({ data }: NodeProps<Node<ProjectData>>) {
  return (
    <div className="canvas-project">
      <LinkHandles />
      <div className="canvas-drag-handle canvas-project-header">
        <span className="canvas-project-initial">{data.name.slice(0, 1).toUpperCase()}</span>
        <span className="canvas-project-name">{data.name}</span>
        <span className="canvas-kind">Project</span>
      </div>
    </div>
  );
}

function WorktreeNode({ data }: NodeProps<Node<WorktreeData>>) {
  return (
    <div className="canvas-worktree">
      <LinkHandles />
      <div className="canvas-drag-handle canvas-worktree-header">
        <div className="canvas-branch" title={data.branch}>
          {data.branch}
        </div>
        <div className="canvas-kind-row">
          <span>Worktree</span>
          <span>{data.diff ?? ""}</span>
        </div>
      </div>
      <ul className="nodrag nopan nowheel canvas-chats">
        {data.chats.map((chat) => (
          <li key={chat.title}>
            <button type="button" className="nodrag canvas-chat">
              <span className={`canvas-mark mark-${chat.mark}`} title={chat.mark} />
              <span className="canvas-chat-title">{chat.title}</span>
            </button>
          </li>
        ))}
      </ul>
      {data.note && (
        <p className="canvas-note">
          <strong>{data.note.from}</strong> {data.note.text}
        </p>
      )}
    </div>
  );
}

function LinkEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, data }: EdgeProps<Edge<LinkData>>) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const activity = data?.activity;
  const stop = useContext(StopActivity);
  const pulse = data?.pulse;
  return (
    <>
      <BaseEdge id={id} path={path} style={style} className={activity ? "milagre-link-active" : undefined} />
      {pulse && <Pulse key={pulse.at} path={path} back={pulse.way === "back"} />}
      {activity && (
        <EdgeLabelRenderer>
          <div className="nodrag nopan canvas-activity" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            <span className={`canvas-activity-dot ${data?.agreed ? "agreed" : ""}`} />
            <span>{activity}</span>
            <button type="button" onClick={() => stop(id)}>
              Stop
            </button>
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

// The tour: milagre's pairing agent asks relay's agent for a change across the Link, relay makes it and answers, and the
// two agree. It plays while the canvas is in view and stops for good at the visitor's first touch.
const ASKER = "milagre:2";
const ANSWERER = "relay:1";
type Step = { wait: number; link?: LinkData; nodes?: Record<string, Partial<WorktreeData>> };
const chat = (title: string, mark: Mark): Chat[] => [{ title, mark }];
const TOUR: Step[] = [
  { wait: 1200, link: { activity: "Asking relay for Retry-After", pulse: { way: "forward", at: 1 } } },
  {
    wait: 1500,
    link: { activity: "relay is adding Retry-After" },
    nodes: {
      [ANSWERER]: { note: { from: "milagre", text: "Can a refused pairing say when to retry?" }, chats: chat("Rate-limit pairing attempts", "running") },
    },
  },
  { wait: 1300, nodes: { [ANSWERER]: { diff: "+31 −4" } } },
  {
    wait: 1200,
    link: { activity: "relay replied", pulse: { way: "back", at: 2 } },
    nodes: { [ANSWERER]: { chats: chat("Rate-limit pairing attempts", "idle") } },
  },
  {
    wait: 1500,
    link: { activity: "Updating the phone's retry" },
    nodes: { [ASKER]: { note: { from: "relay", text: "Done: 429 with Retry-After: 30" }, chats: chat("Phone pairing follow-ups", "running") } },
  },
  { wait: 1300, nodes: { [ASKER]: { diff: "+57 −6" } } },
  { wait: 3200, link: { activity: "Contract agreed", agreed: true }, nodes: { [ASKER]: { chats: chat("Phone pairing follow-ups", "unread") } } },
];

const nodeTypes = { project: ProjectNode, worktree: WorktreeNode };
const edgeTypes = { link: LinkEdge };

export default function LiveCanvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(initialNodes());
  const [edges, setEdges] = useEdgesState<Edge<LinkData>>(initialEdges());
  const stop = useCallback((id: string) => setEdges((current) => current.map((edge) => (edge.id === id ? { ...edge, data: {} } : edge))), [setEdges]);
  const [selected, setSelected] = useState<string | null>(null);
  const section = useRef<HTMLElement>(null);
  // Back to the demo's own data, keeping wherever the visitor dragged things.
  const restore = useCallback(() => {
    const original = new Map(initialNodes().map((node) => [node.id, node.data]));
    setNodes((current) => current.map((node) => ({ ...node, data: original.get(node.id) ?? node.data })));
    setEdges((current) => current.map((edge) => (edge.id === initialEdges()[0]!.id ? { ...edge, data: { activity: NEGOTIATING } } : edge)));
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
        await wait(600, id);
        for (const step of TOUR) {
          if (step.link)
            setEdges((current) =>
              current.map((edge) =>
                edge.id === initialEdges()[0]!.id ? { ...edge, data: { ...edge.data, ...step.link, ...(step.link!.pulse ? {} : { pulse: undefined }) } } : edge,
              ),
            );
          if (step.nodes)
            setNodes((current) =>
              current.map((node) => (step.nodes![node.id] ? { ...node, data: { ...node.data, ...step.nodes![node.id] } as WorktreeData } : node)),
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
    const stop = () => {
      if (finished) return;
      finished = true;
      run++;
      restore();
    };
    for (const type of ["pointerdown", "keydown", "wheel"] as const) host.addEventListener(type, stop, { once: true, passive: true });
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
      for (const type of ["pointerdown", "keydown", "wheel"] as const) host.removeEventListener(type, stop);
    };
  }, [restore, setEdges, setNodes]);
  const shown = edges.map((edge) => ({
    ...edge,
    selected: edge.id === selected,
    style: { ...edge.style, stroke: edge.id === selected ? "var(--accent)" : "var(--ink-3)" },
  }));

  return (
    <StopActivity value={stop}>
      <link rel="stylesheet" href={flowCss} precedence="default" />
      <link rel="stylesheet" href={canvasCss} precedence="default" />
      <section data-canvas className="canvas-window" ref={section}>
        <div className="canvas-bar">
          <a className="canvas-bar-button" href="#parallel-work">
            Back to chat
          </a>
          <h3>Projects and Links</h3>
          {selected && (
            <button
              type="button"
              className="canvas-bar-outline"
              onClick={() => {
                setEdges((current) => current.filter((edge) => edge.id !== selected));
                setSelected(null);
              }}
            >
              Remove Link
            </button>
          )}
          <button
            type="button"
            className="canvas-bar-button small"
            onClick={() => {
              setNodes(initialNodes());
              setEdges(initialEdges());
              setSelected(null);
            }}
          >
            Refresh
          </button>
        </div>
        <div className="canvas-flow">
          <ReactFlow
            className="milagre-canvas-flow"
            colorMode="dark"
            nodes={nodes}
            edges={shown}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
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
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      </section>
    </StopActivity>
  );
}
