import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon, Cancel01Icon, PaintBoardIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { agentActivityLabel, subagentActivityLabel, subagentRoleLabel } from "@milagre/shared/agent-activity";
import type { Subagent, SubagentCommunication } from "@milagre/shared/model";
import { subagentActive, subagentFinished } from "../../lib/subagents";
import { ScrollArea } from "../primitives/ScrollArea";
import { DiffBar } from "../changes/ChangesChrome";
import { SubagentTranscript } from "./SubagentTrack";
import { useDesignsOpener } from "./ArtifactCard";
import type { SubagentDesign } from "./subagent-designs";
import {
  COMMUNICATION_TTL_MS,
  MAIN_AGENT,
  agentNodeId,
  canvasAgentName,
  subagentColor,
  fitAgents,
  initialAgentPosition,
  moveAgentWithCollisions,
  nextCommunicationChange,
  recentCommunications,
  type Point,
  type Viewport,
} from "./subagent-canvas-layout";
import "./subagent-canvas.css";

type Gesture = { pointerId: number; start: Point; origin: Point; nodeId?: string; moved: boolean };

/** Keep the arrangement while switching between the chat and its canvas. */
export const SubagentCanvas = memo(function SubagentCanvas({
  chatKey,
  opened,
  agents,
  working,
  waiting,
  activity,
  onClose,
  onStop,
  onRetry,
  designs,
}: {
  /** The Chat the subagents belong to (see SubagentTranscript). */
  chatKey?: string | null;
  opened: boolean;
  agents: Subagent[];
  working: boolean;
  waiting: boolean;
  activity?: string;
  onClose: () => void;
  onStop?: (id: string) => void;
  onRetry?: (id: string) => void;
  /** Each subagent's design work (subagentDesigns), shown on its bot; it opens the Designs on that design. */
  designs?: ReadonlyMap<string, SubagentDesign>;
}) {
  const openDesigns = useDesignsOpener();
  const panel = useRef<HTMLElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const transcriptClose = useRef<HTMLButtonElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const hasView = useRef(false);
  const [positions, setPositions] = useState<Record<string, Point>>({ [MAIN_AGENT]: { x: 0, y: 0 } });
  const [view, setView] = useState<Viewport>({ x: 0, y: 0, scale: 1 });
  const [clock, setClock] = useState(0);
  const now = useMemo(() => Date.now(), [opened, agents, clock]);
  const [inspected, setInspected] = useState<string | null>(null);
  const [godGaze, setGodGaze] = useState<Point | null>(null);
  const sleepTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastMainMessage = useRef<SubagentCommunication | undefined>(undefined);
  const helpId = useId();
  const visible = useMemo(() => (opened ? agents.filter((agent) => !agent.archived) : []), [agents, opened]);
  const indices = useMemo(() => new Map(agents.map((agent, index) => [agent.id, index])), [agents]);
  const points = useMemo(() => {
    const next: Record<string, Point> = { [MAIN_AGENT]: positions[MAIN_AGENT] };
    visible.forEach((agent) => {
      next[agent.id] = positions[agent.id] ?? initialAgentPosition(indices.get(agent.id)!);
    });
    return next;
  }, [positions, visible, indices]);
  const communications = useMemo(() => recentCommunications(visible, now), [visible, now]);
  const messagesBySender = useMemo(() => new Map(communications.map((message) => [agentNodeId(message.fromId), message])), [communications]);
  const currentMainMessage = useMemo(() => {
    let latest: SubagentCommunication | undefined;
    if (opened)
      for (const agent of agents)
        for (const message of agent.communications ?? []) {
          if (message.fromId !== null || message.toId === null || now - message.at > COMMUNICATION_TTL_MS || message.at > now + 1000) continue;
          if (!latest || message.at >= latest.at) latest = message;
        }
    return latest;
  }, [agents, now, opened]);
  const latestMainMessage =
    currentMainMessage && (!lastMainMessage.current || currentMainMessage.at >= lastMainMessage.current.at) ? currentMainMessage : lastMainMessage.current;
  const mainMessage = useMemo(() => communications.find((message) => message.id === latestMainMessage?.id), [communications, latestMainMessage?.id]);
  const inspectedAgent = visible.find((agent) => agent.id === inspected);

  // Removing the latest recipient must release the gaze, not replay an older exchange.
  useEffect(() => {
    lastMainMessage.current = latestMainMessage;
  }, [latestMainMessage]);

  const godAwake = godGaze !== null && !working;
  function clearSleepTimer() {
    if (sleepTimer.current !== null) clearTimeout(sleepTimer.current);
    sleepTimer.current = null;
  }
  function sleepSoon() {
    clearSleepTimer();
    sleepTimer.current = setTimeout(() => {
      sleepTimer.current = null;
      setGodGaze(null);
    }, 6000);
  }
  function lookAt(client: Point, position: Point): Point {
    const rect = surface.current!.getBoundingClientRect();
    const dx = (client.x - rect.left - view.x) / view.scale - position.x;
    const dy = (client.y - rect.top - view.y) / view.scale - position.y;
    return { x: Math.tanh(dx / 45) * 7, y: Math.tanh(dy / 45) * 4 };
  }

  useEffect(() => {
    if (!opened || working) {
      clearSleepTimer();
      setGodGaze(null);
    }
    return clearSleepTimer;
  }, [opened, working]);

  useEffect(() => {
    if (!opened || !godAwake) return;
    const followPointer = (event: PointerEvent) => {
      if (gesture.current?.nodeId === MAIN_AGENT) return;
      setGodGaze(lookAt({ x: event.clientX, y: event.clientY }, positions[MAIN_AGENT]));
    };
    window.addEventListener("pointermove", followPointer);
    return () => window.removeEventListener("pointermove", followPointer);
  }, [opened, godAwake, positions, view]);

  useLayoutEffect(() => {
    if (opened && inspectedAgent) transcriptClose.current?.focus();
  }, [opened, inspectedAgent?.id]);

  // Keep existing positions on updates; new arrivals push only bots in their space.
  useEffect(() => {
    if (!opened) return;
    setPositions((previous) => {
      const arrivals = visible.filter((agent) => !previous[agent.id]);
      if (!arrivals.length) return previous;
      let layout: Record<string, Point> = {
        [MAIN_AGENT]: previous[MAIN_AGENT],
        ...Object.fromEntries(visible.map((agent) => [agent.id, previous[agent.id] ?? initialAgentPosition(indices.get(agent.id)!)])),
      };
      arrivals.forEach((agent) => {
        layout = moveAgentWithCollisions(layout, agent.id, layout[agent.id]);
      });
      return { ...previous, ...layout };
    });
  }, [opened, visible, indices]);

  useLayoutEffect(() => {
    if (!opened) return;
    panel.current?.querySelector<HTMLButtonElement>("[data-diff-back]")?.focus();
    if (!hasView.current && surface.current) {
      setView(fitAgents(Object.values(points), surface.current.clientWidth, surface.current.clientHeight));
      hasView.current = true;
    }
    const observer = new ResizeObserver(() => {
      // Keep the same world center on resize without losing a custom layout.
      const rect = surface.current?.getBoundingClientRect();
      if (!rect) return;
      if (rect.width === size.width && rect.height === size.height) return;
      setView((previous) => ({ ...previous, x: previous.x + (rect.width - size.width) / 2, y: previous.y + (rect.height - size.height) / 2 }));
      size = rect;
    });
    let size = surface.current!.getBoundingClientRect();
    observer.observe(surface.current!);
    return () => {
      observer.disconnect();
      gesture.current = null;
    };
  }, [opened]);

  useEffect(() => {
    if (!opened) return;
    const next = nextCommunicationChange(visible, now, communications);
    if (next === undefined) return;
    const timer = window.setTimeout(() => setClock((value) => value + 1), Math.min(2 ** 31 - 1, Math.max(1, next - Date.now())));
    return () => window.clearTimeout(timer);
  }, [opened, visible, now, communications]);

  // A non-passive wheel listener keeps trackpad gestures inside the canvas.
  useEffect(() => {
    if (!opened) return;
    const element = surface.current!;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) zoom(Math.exp(-event.deltaY * 0.01), { x: event.clientX - rect.left, y: event.clientY - rect.top });
      else setView((previous) => ({ ...previous, x: previous.x - event.deltaX, y: previous.y - event.deltaY }));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [opened]);

  function zoom(factor: number, anchor?: Point) {
    const center = anchor ?? { x: surface.current!.clientWidth / 2, y: surface.current!.clientHeight / 2 };
    setView((previous) => {
      const scale = Math.max(0.15, Math.min(2, previous.scale * factor));
      return { scale, x: center.x - ((center.x - previous.x) * scale) / previous.scale, y: center.y - ((center.y - previous.y) * scale) / previous.scale };
    });
  }

  function fit(reset = false) {
    const next = reset
      ? { [MAIN_AGENT]: { x: 0, y: 0 }, ...Object.fromEntries(visible.map((agent) => [agent.id, initialAgentPosition(indices.get(agent.id)!)])) }
      : points;
    if (reset) setPositions(next);
    setView(fitAgents(Object.values(next), surface.current!.clientWidth, surface.current!.clientHeight));
  }

  function startDrag(event: ReactPointerEvent<HTMLElement>, nodeId?: string) {
    if (event.button !== 0 || gesture.current) return;
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    suppressClick.current = false;
    gesture.current = {
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      origin: nodeId ? points[nodeId] : view,
      nodeId,
      moved: false,
    };
  }

  function moveNode(nodeId: string, target: Point) {
    setPositions((previous) => {
      const layout = Object.fromEntries(Object.keys(points).map((id) => [id, previous[id] ?? points[id]]));
      return { ...previous, ...moveAgentWithCollisions(layout, nodeId, target) };
    });
  }

  function moveDrag(event: ReactPointerEvent<HTMLElement>) {
    const drag = gesture.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.start.x;
    const dy = event.clientY - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    if (drag.nodeId) {
      const position = { x: drag.origin.x + dx / view.scale, y: drag.origin.y + dy / view.scale };
      moveNode(drag.nodeId, position);
      if (drag.nodeId === MAIN_AGENT && !working) {
        clearSleepTimer();
        setGodGaze(lookAt({ x: event.clientX, y: event.clientY }, position));
      }
    } else setView((previous) => ({ ...previous, x: drag.origin.x + dx, y: drag.origin.y + dy }));
  }

  function endDrag() {
    if (!gesture.current) return;
    if (gesture.current.nodeId === MAIN_AGENT && gesture.current.moved && !working) sleepSoon();
    suppressClick.current = Boolean(gesture.current.nodeId && gesture.current.moved);
    gesture.current = null;
  }

  function closeTranscript() {
    setInspected(null);
    const bot = [...(panel.current?.querySelectorAll<HTMLButtonElement>("[data-canvas-agent]") ?? [])].find(
      (button) => button.dataset.canvasAgent === inspected,
    );
    bot?.focus();
  }

  if (!opened) return null;
  const nodes = [
    {
      id: MAIN_AGENT,
      title: "God",
      status: waiting && working ? "Waiting" : working ? agentActivityLabel(activity) : godAwake ? "Awake" : "Sleeping",
      activity: waiting && working ? "Waiting for subagent results" : working ? "Working on your request" : "No turn in progress",
      active: working,
      sleeping: !working,
      dead: false,
      color: "boss",
      agent: null,
    },
    ...visible.map((agent) => ({
      id: agent.id,
      title: canvasAgentName(indices.get(agent.id)!),
      status: subagentActivityLabel(agent),
      activity: `${subagentRoleLabel(agent) ? subagentRoleLabel(agent) + "\n" : ""}${agent.title}\n${agent.latestActivity || subagentActivityLabel(agent)}`,
      active: subagentActive(agent),
      sleeping: false,
      dead: subagentFinished(agent),
      color: subagentColor(indices.get(agent.id)!),
      agent,
    })),
  ];
  const name = (id: string | null) => (id === null ? "God" : canvasAgentName(indices.get(id)!));

  return (
    <section
      ref={panel}
      aria-label="Subagent canvas"
      data-slot="subagent-canvas"
      className="subagent-canvas"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          event.preventDefault();
          if (inspectedAgent) closeTranscript();
          else onClose();
        }
      }}
    >
      <DiffBar open onBack={onClose} />
      <p id={helpId} className="sr-only">
        Drag bots or use their arrow keys to move them. Drag the background or scroll to pan. Pinch to zoom. Press 0 to fit all agents, or R to reset the
        layout. Click a bot to read its transcript.
      </p>
      <div
        ref={surface}
        tabIndex={0}
        role="group"
        aria-label="Agent canvas. Drag the background to pan."
        aria-describedby={helpId}
        className="subagent-canvas-surface"
        data-canvas-surface
        onPointerDown={(event) => startDrag(event)}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey) return;
          const delta = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] }[event.key];
          if (delta) {
            event.preventDefault();
            setView((previous) => ({ ...previous, x: previous.x + delta[0], y: previous.y + delta[1] }));
          }
          if (event.key === "+" || event.key === "=") zoom(1.2);
          if (event.key === "-") zoom(1 / 1.2);
          if (event.key === "0") fit();
          if (event.key.toLowerCase() === "r") fit(true);
        }}
      >
        <div className="subagent-canvas-world" data-canvas-world style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
          <svg className="subagent-canvas-wires" aria-hidden="true">
            {visible.map((agent) => {
              const parent = points[agent.parentId ?? MAIN_AGENT];
              const child = points[agent.id];
              return (
                parent && (
                  <path key={agent.id} className="subagent-canvas-parent-wire" d={`M ${parent.x} ${parent.y} Q ${parent.x} ${child.y} ${child.x} ${child.y}`} />
                )
              );
            })}
            {communications.map((message) => {
              const from = points[agentNodeId(message.fromId)];
              const to = points[agentNodeId(message.toId)];
              return (
                <path
                  key={`${message.fromId}:${message.toId}`}
                  data-communication-from={message.fromId ?? "main"}
                  data-communication-to={message.toId ?? "main"}
                  className="subagent-canvas-message-wire"
                  d={`M ${from.x} ${from.y} Q ${(from.x + to.x) / 2} ${Math.min(from.y, to.y) - 80} ${to.x} ${to.y}`}
                />
              );
            })}
          </svg>
          {nodes.map((node, index) => {
            const message = node.id === MAIN_AGENT ? mainMessage : messagesBySender.get(node.id);
            // Follow the latest real outgoing message, using world positions so dragging
            // either bot changes the gaze without letting pan or zoom change its direction.
            const recipientId = node.id === MAIN_AGENT && node.active ? message?.toId : null;
            const recipient = recipientId ? points[recipientId] : undefined;
            const dx = recipient ? recipient.x - points[node.id].x : 0;
            const dy = recipient ? recipient.y - points[node.id].y : 0;
            const length = Math.max(1, Math.hypot(dx, dy));
            const gaze = recipient ? { x: (dx / length) * 7, y: (dy / length) * 4 } : node.id === MAIN_AGENT && godAwake ? godGaze : null;
            return (
              <div
                key={node.id}
                className="subagent-canvas-node"
                data-color={node.color}
                data-status={node.agent?.status ?? (working ? "running" : "completed")}
                style={{ left: points[node.id].x, top: points[node.id].y }}
              >
                {node.sleeping && !(node.id === MAIN_AGENT && godAwake) && (
                  <span className="subagent-sleep" aria-hidden="true">
                    <i>z</i>
                    <i>Z</i>
                    <i>z</i>
                  </span>
                )}
                <button
                  type="button"
                  data-canvas-agent={node.id === MAIN_AGENT ? "main" : node.id}
                  title={message ? `To ${name(message.toId)}: ${message.text}` : node.activity}
                  aria-label={`${node.title}. ${node.status}. Drag or use arrow keys to move.${node.agent ? " Press Enter to read transcript." : ""}`}
                  aria-describedby={helpId}
                  className="subagent-bot-handle"
                  onPointerDown={(event) => startDrag(event, node.id)}
                  onClick={(event) => {
                    if (suppressClick.current && event.detail !== 0) {
                      suppressClick.current = false;
                      return;
                    }
                    if (node.agent) setInspected(node.id);
                  }}
                  onKeyDown={(event) => {
                    if (event.metaKey || event.ctrlKey || event.altKey) return;
                    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
                    if (!delta) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const step = event.shiftKey ? 40 : 12;
                    moveNode(node.id, { x: points[node.id].x + delta[0] * step, y: points[node.id].y + delta[1] * step });
                    if (node.id === MAIN_AGENT && !working) {
                      setGodGaze({ x: delta[0] * 7, y: delta[1] * 4 });
                      sleepSoon();
                    }
                  }}
                >
                  {node.id === MAIN_AGENT && (
                    <span className="subagent-boss-spark" aria-hidden="true">
                      ✦
                    </span>
                  )}
                  <span
                    className="subagent-bot"
                    data-active={node.active}
                    data-talking={Boolean(message)}
                    data-looking={Boolean(recipient)}
                    data-looking-at={recipientId ?? undefined}
                    data-dead={node.dead}
                    data-angry={node.id === MAIN_AGENT && godAwake}
                    style={{ "--bot-delay": `${-index * 0.7}s`, ...(gaze ? { "--gaze-x": `${gaze.x}px`, "--gaze-y": `${gaze.y}px` } : {}) } as CSSProperties}
                    aria-hidden="true"
                  >
                    <span className="subagent-bot-face">
                      <i />
                      <i />
                    </span>
                  </span>
                  {node.agent?.status === "failed" && (
                    <span className="subagent-outcome" aria-hidden="true">
                      <HugeiconsIcon icon={AlertCircleIcon} size={18} />
                    </span>
                  )}
                </button>
                <span className="subagent-bot-name" title={node.agent?.title ?? "Main agent"}>
                  {node.title}
                  {node.agent?.status === "completed" && (
                    <HugeiconsIcon className="subagent-name-check" icon={Tick02Icon} size={12} strokeWidth={1.8} aria-hidden="true" />
                  )}
                </span>
                {node.agent?.status !== "completed" && (node.agent || working) && (
                  <span className="subagent-bot-status">
                    <span />
                    {node.status}
                  </span>
                )}
                {(() => {
                  const design = node.agent ? designs?.get(node.agent.id) : undefined;
                  if (!design || !openDesigns) return null;
                  const label = design.designing ? `Designing${design.title ? ` ${design.title}` : "…"}` : design.title;
                  return (
                    <button
                      type="button"
                      data-slot="subagent-design"
                      data-designing={design.designing || undefined}
                      className="subagent-bot-design"
                      title={design.designing ? `Open the Designs to watch ${node.title} design` : `Open ${design.title} in the Designs`}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => openDesigns(design.id)}
                    >
                      <HugeiconsIcon icon={PaintBoardIcon} size={11} strokeWidth={1.8} aria-hidden="true" />
                      <span>{label}</span>
                    </button>
                  );
                })()}
              </div>
            );
          })}
        </div>
        {!visible.length && <p className="subagent-canvas-empty">The crew is offstage. New subagents will appear here.</p>}
      </div>
      {inspectedAgent && (
        <aside
          className="absolute inset-y-16 right-3 z-30 flex w-[min(420px,calc(100%-24px))] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-raised"
          aria-label={`${name(inspectedAgent.id)} transcript`}
        >
          <header className="flex items-center gap-2 border-b border-line p-3">
            <h2 className="min-w-0 flex-1 truncate text-[13px]">
              {name(inspectedAgent.id)} · {inspectedAgent.title}
            </h2>
            <button
              ref={transcriptClose}
              type="button"
              aria-label="Close transcript"
              className="rounded p-1 text-ink-2 hover:bg-hover"
              onClick={closeTranscript}
            >
              <HugeiconsIcon icon={Cancel01Icon} size={16} />
            </button>
          </header>
          <ScrollArea>
            <SubagentTranscript chatKey={chatKey} agent={inspectedAgent} onStop={onStop} onRetry={onRetry} />
          </ScrollArea>
        </aside>
      )}
    </section>
  );
});
