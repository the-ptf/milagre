import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowRight01Icon, ListTodoIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { currentPhase, taskCounts } from "@milagre/shared/chat-plan";
import type { ChatPlan, ChatTask } from "../../model";
import { SpinnerRing } from "../primitives/SpinnerRing";
import { ScrollArea } from "../primitives/ScrollArea";
import Tooltip from "../primitives/Tooltip";
import { PHASE_LABELS, PhaseGraph } from "./PhaseGraph";
import { useAnchoredPopover } from "./useAnchoredPopover";

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

/** The Chat's plan: a "done/total" pill that opens its task tree and phase graph above the composer. */
export function TaskTrack({ plan }: { plan?: ChatPlan }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const [opened, setOpened] = useState(false);
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const bounds = useAnchoredPopover({ opened, setOpened, trigger, panel, width: 380, height: 520 });
  const empty = !plan || (!plan.tasks.length && !plan.phases.length);
  // The plan goes with its Chat; a later one starts closed.
  useEffect(() => {
    if (empty) setOpened(false);
  }, [empty]);
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
  return (
    <div className="flex" data-slot="task-track">
      <Tooltip label="Tasks" align="end">
        <button
          ref={trigger}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={opened}
          aria-controls={opened ? panelId : undefined}
          aria-label={total ? `Tasks, ${done} of ${total} done` : `Phase: ${label}`}
          onClick={() => setOpened(!opened)}
          className="flex h-6 items-center gap-1.5 rounded-full border border-line bg-surface px-2 text-[11px] text-ink-2 hover:bg-hover focus-visible:outline-2"
        >
          <HugeiconsIcon icon={ListTodoIcon} size={12} aria-hidden />
          <span className="tabular-nums">{label}</span>
        </button>
      </Tooltip>
      {opened &&
        createPortal(
          <div
            ref={panel}
            id={panelId}
            role="dialog"
            aria-label="Tasks"
            aria-modal="false"
            tabIndex={-1}
            data-slot="task-popover"
            style={bounds}
            className="fixed z-50 flex flex-col gap-2 overflow-hidden rounded-[10px] border border-line bg-surface p-1 text-ink shadow-raised focus:outline-none"
          >
            {plan.tasks.length > 0 && (
              <section aria-label="Tasks" className="flex min-h-0 flex-col gap-1">
                <h3 className="flex items-center justify-between px-2 pt-1 text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase">
                  <span className="flex items-center gap-2">
                    <span aria-hidden className="h-px w-3 bg-accent" />
                    Tasks
                  </span>
                  <span className="tabular-nums">{total}</span>
                </h3>
                <ScrollArea as="ul">
                  <TaskRows tasks={plan.tasks} depth={0} folded={folded} toggle={toggle} />
                </ScrollArea>
              </section>
            )}
            <PhaseGraph plan={plan} />
          </div>,
          document.body,
        )}
    </div>
  );
}
