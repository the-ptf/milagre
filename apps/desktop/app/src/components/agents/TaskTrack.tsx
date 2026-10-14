import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowRight01Icon, ArrowShrink02Icon, ListTodoIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { currentPhase, taskCounts } from "@milagre/shared/chat-plan";
import type { ChatPlan, ChatTask } from "../../model";
import { SpinnerRing } from "../primitives/SpinnerRing";
import { ScrollArea } from "../primitives/ScrollArea";
import Tooltip from "../primitives/Tooltip";
import { useDismiss } from "../../lib/use-dismiss";
import { HIDDEN_FACE, MORPH_SURFACE, morphFace, useSize } from "../motion/morph";
import { PHASE_LABELS, PhaseGraph } from "./PhaseGraph";

const statusLabels: Record<ChatTask["status"], string> = { pending: "Pending", in_progress: "In progress", completed: "Completed" };

function TaskMarker({ status }: { status: ChatTask["status"] }) {
  if (status === "in_progress") return <SpinnerRing size={12} />;
  if (status === "completed") return <HugeiconsIcon icon={Tick02Icon} size={14} aria-hidden />;
  return <span aria-hidden className="size-3 rounded-full border-[1.5px] border-line-strong" />;
}

function TaskRows({ tasks, depth, folded, toggle }: { tasks: ChatTask[]; depth: number; folded: Set<string>; toggle: (id: string) => void }) {
  return tasks.map((task, index) => {
    const parent = Boolean(task.children?.length);
    const open = parent && !folded.has(task.id);
    return (
      <li key={task.id} className="flex flex-col">
        <div
          data-task-row
          data-depth={depth}
          data-status={task.status}
          style={{ paddingLeft: 8 + depth * 18 }}
          className={`flex items-start gap-2 rounded-md py-1.5 pr-2 text-[13px] ${
            task.status === "in_progress" && !parent ? "bg-hover ring-1 ring-accent/50" : ""
          }`}
        >
          {parent ? (
            <button
              type="button"
              aria-expanded={open}
              aria-label={open ? `Collapse ${task.title}` : `Expand ${task.title}`}
              onClick={() => toggle(task.id)}
              className="mt-0.5 text-ink-3"
            >
              <HugeiconsIcon icon={open ? ArrowDown01Icon : ArrowRight01Icon} size={12} aria-hidden />
            </button>
          ) : (
            <span aria-hidden className="w-3" />
          )}
          <span aria-hidden className="mt-0.5 min-w-4 rounded bg-hover px-1 text-center text-[11px] text-ink-3 tabular-nums">
            {index + 1}
          </span>
          <span className={`min-w-0 flex-1 break-words ${task.status === "completed" && !parent ? "text-ink-3" : ""}`}>
            <span className="sr-only">{statusLabels[task.status]}: </span>
            {task.status === "in_progress" && !parent && task.activeForm ? task.activeForm : task.title}
          </span>
          <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-ink-3">
            <TaskMarker status={task.status} />
          </span>
        </div>
        {open && (
          <ul>
            <TaskRows tasks={task.children!} depth={depth + 1} folded={folded} toggle={toggle} />
          </ul>
        )}
      </li>
    );
  });
}

// The panel is never wider than this nor taller than the smaller of these heights, and keeps this far from the window's edges.
const PANEL_WIDTH = 380;
const PANEL_HEIGHT = 520;
const PANEL_VIEWPORT_SHARE = 0.7;
const EDGE = 12;

/**
 * The Chat's plan: a "done/total" pill that grows in place into its task tree and phase graph. The pill and the panel
 * are the two faces of one surface anchored at the pill's bottom-right corner, so the panel opens up and to the left
 * over the transcript without moving the composer row.
 */
export function TaskTrack({ plan }: { plan?: ChatPlan }) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const reduce = useReducedMotion();
  const [opened, setOpened] = useState(false);
  // Each opening draws a fresh phase graph, so its Now is the moment the panel opened.
  const [opening, setOpening] = useState(0);
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  // The panel's size, and how far its right edge moves past the pill's so a narrow window still fits it.
  const [room, setRoom] = useState({ width: PANEL_WIDTH, height: PANEL_HEIGHT, shift: 0 });
  const [pillSize, measurePill] = useSize();
  const [panelSize, measurePanel] = useSize();
  // Closing from the keyboard or the collapse control hands focus back to the pill.
  const refocus = useRef(false);
  const empty = !plan || (!plan.tasks.length && !plan.phases.length);
  const fit = () => {
    const box = root.current?.getBoundingClientRect();
    if (!box) return;
    const width = Math.round(Math.max(0, Math.min(PANEL_WIDTH, window.innerWidth - 2 * EDGE)));
    const height = Math.round(Math.max(0, Math.min(PANEL_HEIGHT, window.innerHeight * PANEL_VIEWPORT_SHARE, box.bottom - EDGE)));
    // Anchored to the pill's right edge when that fits; otherwise moved right just enough to clear the window's left padding.
    const shift = Math.max(0, EDGE - (box.right - width));
    setRoom((current) => (current.width === width && current.height === height && current.shift === shift ? current : { width, height, shift }));
  };
  const show = () => {
    fit();
    setOpening((count) => count + 1);
    setOpened(true);
  };
  const close = (returnFocus: boolean) => {
    refocus.current = returnFocus;
    setOpened(false);
  };
  useDismiss(
    opened,
    () => close(false),
    (target) => !!root.current?.contains(target),
    fit,
  );
  // The plan goes with its Chat; a later one starts closed.
  useEffect(() => {
    if (empty) setOpened(false);
  }, [empty]);
  useEffect(() => {
    if (!opened) return;
    const frame = requestAnimationFrame(() => (panel.current?.querySelector<HTMLButtonElement>("button") ?? panel.current)?.focus());
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      refocus.current = true;
      setOpened(false);
    };
    document.addEventListener("keydown", escape, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", escape, true);
    };
  }, [opened]);
  useLayoutEffect(() => {
    if (opened || !refocus.current) return;
    refocus.current = false;
    trigger.current?.focus();
  }, [opened]);
  if (empty) return null;
  const { done, total } = taskCounts(plan.tasks);
  const phase = currentPhase(plan);
  const label = total ? `${done}/${total}` : phase ? PHASE_LABELS[phase] : "";
  const toggle = (id: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const collapse = (
    <button
      type="button"
      aria-label="Collapse tasks"
      onClick={() => close(true)}
      className="-my-1 shrink-0 rounded-md p-1 text-ink-3 transition-colors hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink"
    >
      <HugeiconsIcon icon={ArrowShrink02Icon} size={14} aria-hidden />
    </button>
  );
  const size = opened ? panelSize : pillSize;
  return (
    // Holds the pill's spot in the composer row; the surface hangs from its bottom-right corner.
    <div ref={root} data-slot="task-track" className="relative shrink-0" style={pillSize ? { width: pillSize.width, height: pillSize.height } : undefined}>
      {/* One surface morphs between the pill and the panel; both faces stay mounted and crossfade over it. */}
      <div
        data-slot="task-surface"
        style={size ? { width: size.width, height: size.height, right: opened ? -room.shift : 0, borderRadius: opened ? 10 : size.height / 2 } : undefined}
        className={`absolute bottom-0 z-10 overflow-hidden bg-surface text-ink ${MORPH_SURFACE} ${opened ? "shadow-raised" : "shadow-hairline"}`}
      >
        <motion.div
          ref={(node: HTMLDivElement | null) => {
            panel.current = node;
            return measurePanel(node);
          }}
          id={panelId}
          role="dialog"
          aria-label="Tasks"
          aria-modal="false"
          tabIndex={-1}
          data-slot="task-popover"
          data-state={opened ? "open" : "closed"}
          {...morphFace(opened, reduce)}
          style={{ width: room.width, maxHeight: room.height }}
          className={`absolute right-0 bottom-0 flex flex-col gap-1 p-1 focus:outline-none ${opened ? "visible" : HIDDEN_FACE}`}
        >
          {plan.tasks.length > 0 && (
            <div className="flex shrink-0 items-center gap-2 px-2 pt-1">
              <h3 id={`${panelId}-tasks`} className="flex flex-1 items-center justify-between text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase">
                <span className="flex items-center gap-2">
                  <span aria-hidden className="h-px w-3 bg-accent" />
                  Tasks
                </span>
                <span className="tabular-nums">{total}</span>
              </h3>
              {collapse}
            </div>
          )}
          {/* The tree and the graph scroll as one body under the fixed header, so a short window never squeezes the tree. */}
          <ScrollArea data-slot="task-body" className="flex flex-col gap-2">
            {plan.tasks.length > 0 && (
              <ul aria-labelledby={`${panelId}-tasks`} className="shrink-0">
                <TaskRows tasks={plan.tasks} depth={0} folded={folded} toggle={toggle} />
              </ul>
            )}
            <PhaseGraph key={opening} plan={plan} action={plan.tasks.length ? undefined : collapse} />
          </ScrollArea>
        </motion.div>
      </div>
      {/* The pill face sits over the surface at the pill's spot, so it never travels when the panel is moved right. */}
      <motion.div
        ref={measurePill}
        data-face="pill"
        {...morphFace(!opened, reduce)}
        className={`absolute right-0 bottom-0 z-10 flex ${opened ? HIDDEN_FACE : "visible"}`}
      >
        <Tooltip label="Tasks" align="end">
          <button
            ref={trigger}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={opened}
            aria-controls={panelId}
            aria-label={total ? `Tasks, ${done} of ${total} done` : `Phase: ${label}`}
            onClick={show}
            className="flex h-6 items-center gap-1.5 rounded-full px-2 text-[11px] whitespace-nowrap text-ink-2 hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2"
          >
            <HugeiconsIcon icon={ListTodoIcon} size={12} aria-hidden />
            <span className="tabular-nums">{label}</span>
          </button>
        </Tooltip>
      </motion.div>
    </div>
  );
}
