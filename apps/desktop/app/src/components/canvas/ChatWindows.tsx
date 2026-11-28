import { useRef, useState } from "react";
import { BaseEdge, EdgeLabelRenderer, Handle, NodeResizer, Position, useReactFlow, type Edge, type EdgeProps, type NodeProps } from "@xyflow/react";
import { WINDOW, bentLine, lineSides, type WindowRecord } from "@/lib/canvas-open";
import { preferenceStorage } from "@/lib/preference-storage";
import { CanvasChat as OpenCanvasChat } from "./CanvasChat";
import { WINDOW_Z, type CanvasNode, type WindowNode } from "./graph";

type WindowEdgeData = {
  chatKey: string;
  sides: string;
  bend: { x: number; y: number } | null;
  onBend: (key: string, offset: { x: number; y: number } | null) => void;
};

export function WindowEdge({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<Edge<WindowEdgeData>>) {
  const flow = useReactFlow();
  const [dragging, setDragging] = useState<{ x: number; y: number } | null>(null);
  const held = useRef(false);
  const from = { x: sourceX, y: sourceY };
  const to = { x: targetX, y: targetY };
  const { path, point } = bentLine(from, to, dragging ?? data?.bend ?? null);
  const offsetAt = (event: { clientX: number; clientY: number }) => {
    const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    return { x: at.x - (from.x + to.x) / 2, y: at.y - (from.y + to.y) / 2 };
  };
  return (
    <>
      <BaseEdge id={id} path={path} style={{ stroke: "var(--color-accent)", strokeWidth: 1.5, strokeDasharray: "5 4" }} />
      {data && (
        <EdgeLabelRenderer>
          <button
            type="button"
            aria-label="Bend this line (double click to straighten)"
            title="Drag to bend this line. Double click to straighten it."
            data-canvas-line={data.chatKey}
            data-sides={data.sides}
            data-bent={data.bend ? "" : undefined}
            className={`nodrag nopan pointer-events-auto absolute size-3 cursor-grab rounded-full border-2 border-accent bg-surface transition-opacity duration-fast active:cursor-grabbing ${
              data.bend || dragging ? "opacity-100" : "opacity-40 hover:opacity-100"
            }`}
            style={{ transform: `translate(-50%, -50%) translate(${point.x}px, ${point.y}px)`, zIndex: WINDOW_Z }}
            onPointerDown={(event) => {
              event.stopPropagation();
              try {
                event.currentTarget.setPointerCapture(event.pointerId);
              } catch {}
              held.current = true;
              setDragging(offsetAt(event));
            }}
            onPointerMove={(event) => {
              if (held.current) setDragging(offsetAt(event));
            }}
            onPointerUp={(event) => {
              if (!held.current) return;
              held.current = false;
              data.onBend(data.chatKey, offsetAt(event));
              setDragging(null);
            }}
            onPointerCancel={() => {
              held.current = false;
              setDragging(null);
            }}
            onDoubleClick={() => data.onBend(data.chatKey, null)}
          />
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export function LineHandles({ type }: { type: "source" | "target" }) {
  return (
    <>
      {([Position.Left, Position.Right, Position.Top, Position.Bottom] as const).map((position) => (
        <Handle key={position} type={type} position={position} id={`line-${position}`} isConnectable={false} className="!pointer-events-none !opacity-0" />
      ))}
    </>
  );
}

export function ChatWindow({ data }: NodeProps<WindowNode>) {
  const waiting = data.row.mark === "waiting";
  return (
    <div
      data-canvas-window={data.chatKey}
      className={`group/window milagre-canvas-card flex h-full w-full flex-col overflow-hidden rounded-card border bg-surface shadow-card ring-1 ${
        waiting ? "border-orange ring-orange" : "border-accent ring-accent"
      }`}
    >
      <NodeResizer
        minWidth={WINDOW.minWidth}
        minHeight={WINDOW.minHeight}
        lineClassName="!border-transparent"
        handleClassName="!size-2.5 !rounded-full !border-accent !bg-surface opacity-0 transition-opacity duration-fast group-hover/window:opacity-100"
        onResizeEnd={(_event, box) => data.onResize(data.chatKey, box)}
      />
      <LineHandles type="target" />
      <OpenCanvasChat chatKey={data.chatKey} row={data.row} branch={data.branch} />
    </div>
  );
}

const WINDOW_RECORDS_KEY = "milagre.canvasChatWindows";
const REMEMBERED_WINDOWS = 200;
const isPoint = (value: unknown): value is { x: number; y: number } =>
  Boolean(value) && Number.isFinite((value as { x?: unknown }).x) && Number.isFinite((value as { y?: unknown }).y);
export function readWindowRecords(): Record<string, WindowRecord> {
  try {
    const saved = JSON.parse(preferenceStorage.getItem(WINDOW_RECORDS_KEY) ?? "{}") as Record<string, Record<string, unknown> | null>;
    const records: Record<string, WindowRecord> = {};
    for (const [key, value] of Object.entries(saved)) {
      if (!value) continue;
      const record: WindowRecord = {};
      const { width, height, bend } = value;
      if (isPoint(value)) Object.assign(record, { x: value.x, y: value.y });
      if (Number.isFinite(width) && Number.isFinite(height)) Object.assign(record, { width, height });
      if (isPoint(bend)) record.bend = { x: bend.x, y: bend.y };
      if (Object.keys(record).length) records[key] = record;
    }
    return records;
  } catch {
    return {};
  }
}
export function saveWindowRecords(records: Record<string, WindowRecord>): Record<string, WindowRecord> {
  try {
    preferenceStorage.setItem(WINDOW_RECORDS_KEY, JSON.stringify(records));
  } catch {}
  return records;
}
export function patchRecord(records: Record<string, WindowRecord>, key: string, patch: Partial<WindowRecord>): Record<string, WindowRecord> {
  const { [key]: old, ...rest } = records;
  const merged: WindowRecord = { ...old, ...patch };
  for (const field of Object.keys(merged) as Array<keyof WindowRecord>) if (merged[field] === undefined) delete merged[field];
  const round = (value: number) => Math.round(value);
  const record: WindowRecord = {
    ...(merged.x !== undefined && merged.y !== undefined ? { x: round(merged.x), y: round(merged.y) } : {}),
    ...(merged.width !== undefined && merged.height !== undefined ? { width: round(merged.width), height: round(merged.height) } : {}),
    ...(merged.bend ? { bend: { x: round(merged.bend.x), y: round(merged.bend.y) } } : {}),
  };
  const entries = Object.entries(rest);
  if (Object.keys(record).length) entries.push([key, record]);
  return saveWindowRecords(Object.fromEntries(entries.slice(-REMEMBERED_WINDOWS)));
}

export function windowEdges(
  nodes: readonly CanvasNode[],
  nodeById: ReadonlyMap<string, CanvasNode>,
  records: Readonly<Record<string, WindowRecord>>,
  onBend: (key: string, offset: { x: number; y: number } | null) => void,
) {
  const boxOf = (node: CanvasNode) => {
    const parent = node.parentId ? nodeById.get(node.parentId) : undefined;
    return {
      x: node.position.x + (parent?.position.x ?? 0),
      y: node.position.y + (parent?.position.y ?? 0),
      width: Number(node.width ?? node.style?.width ?? 0),
      height: Number(node.height ?? node.style?.height ?? 0),
    };
  };
  return nodes.flatMap((node) => {
    const card = node.type === "chatwindow" ? nodeById.get(node.data.cardId) : undefined;
    if (node.type !== "chatwindow" || !card) return [];
    const sides = lineSides(boxOf(card), boxOf(node));
    return [
      {
        id: `chatwindow-edge:${node.id}`,
        source: card.id,
        target: node.id,
        sourceHandle: `line-${sides.card}`,
        targetHandle: `line-${sides.window}`,
        type: "chatwindow" as const,
        selectable: false,
        deletable: false,
        zIndex: 0,
        data: { chatKey: node.data.chatKey, sides: `${sides.card}-${sides.window}`, bend: records[node.data.chatKey]?.bend ?? null, onBend },
      },
    ];
  });
}
