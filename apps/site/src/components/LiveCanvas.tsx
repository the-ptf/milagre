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
import { createContext, useCallback, useContext, useState } from "react";

type Mark = "waiting" | "running" | "unread" | "idle";
type Chat = { title: string; mark: Mark };
type ProjectData = { kind: "project"; name: string };
type WorktreeData = { kind: "worktree"; branch: string; diff?: string; chats: Chat[] };
type CanvasNode = Node<ProjectData | WorktreeData>;
type LinkData = { activity?: string };
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
    </div>
  );
}

function LinkEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, data }: EdgeProps<Edge<LinkData>>) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const activity = data?.activity;
  const stop = useContext(StopActivity);
  return (
    <>
      <BaseEdge id={id} path={path} style={style} className={activity ? "milagre-link-active" : undefined} />
      {activity && (
        <EdgeLabelRenderer>
          <div className="nodrag nopan canvas-activity" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
            <span className="canvas-activity-dot" />
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

const nodeTypes = { project: ProjectNode, worktree: WorktreeNode };
const edgeTypes = { link: LinkEdge };

export default function LiveCanvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(initialNodes());
  const [edges, setEdges] = useEdgesState<Edge<LinkData>>(initialEdges());
  const stop = useCallback((id: string) => setEdges((current) => current.map((edge) => (edge.id === id ? { ...edge, data: {} } : edge))), [setEdges]);
  const [selected, setSelected] = useState<string | null>(null);
  const shown = edges.map((edge) => ({
    ...edge,
    selected: edge.id === selected,
    style: { ...edge.style, stroke: edge.id === selected ? "var(--accent)" : "var(--ink-3)" },
  }));

  return (
    <StopActivity value={stop}>
      <link rel="stylesheet" href={flowCss} precedence="default" />
      <link rel="stylesheet" href={canvasCss} precedence="default" />
      <section data-canvas className="canvas-window">
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
