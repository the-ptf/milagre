import { useEffect, useId, useState } from "react";
import { ArrowDown01Icon, ArrowRight01Icon, ArrowShrink02Icon, ListTodoIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { currentPhase, taskCounts } from "@milagre/shared/chat-plan";
import type { ChatPlan, ChatTask } from "../../model";
import { SpinnerRing } from "../primitives/SpinnerRing";
import { ScrollArea } from "../primitives/ScrollArea";
import { Icon } from "../primitives/Icon";
import { IconButton } from "../primitives/Button";
import { SectionLabel } from "../primitives/SectionLabel";
import { PillMorph } from "../motion/PillMorph";
import { PHASE_LABELS, PhaseGraph } from "./PhaseGraph";

const statusLabels: Record<ChatTask["status"], string> = { pending: "Pending", in_progress: "In progress", completed: "Completed" };

function TaskMarker({ status }: { status: ChatTask["status"] }) {
  if (status === "in_progress") return <SpinnerRing size={12} />;
  if (status === "completed") return <Icon icon={Tick02Icon} size={14} />;
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
          style={{ paddingLeft: 8 + depth * 16 }}
          className={`flex items-start gap-2 rounded-control py-1.5 pr-2 text-13 ${
            task.status === "in_progress" && !parent ? "bg-hover ring-1 ring-accent/50" : ""
          }`}
        >
          {parent ? (
            <button
              type="button"
              aria-expanded={open}
              aria-label={open ? `Collapse ${task.title}` : `Expand ${task.title}`}
              onClick={() => toggle(task.id)}
              className="relative mt-0.5 rounded-inline text-ink-3 before:absolute before:-inset-1.5 hover:text-ink"
            >
              <Icon icon={open ? ArrowDown01Icon : ArrowRight01Icon} size={12} />
            </button>
          ) : (
            <span aria-hidden className="w-3" />
          )}
          <span aria-hidden className="mt-0.5 min-w-4 rounded-inline bg-hover px-1 text-center text-11 text-ink-3 tabular-nums">
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

// The panel is never wider than this nor taller than this (PillMorph also caps it at a share of the window).
const PANEL_WIDTH = 380;
const PANEL_HEIGHT = 520;

/**
 * The Chat's plan: a "done/total" pill that grows in place into its task tree and phase graph (see PillMorph).
 */
export function TaskTrack({ plan }: { plan?: ChatPlan }) {
  const panelId = useId();
  const [opened, setOpened] = useState(false);
  // Each opening draws a fresh phase graph, so its Now is the moment the panel opened.
  const [opening, setOpening] = useState(0);
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const empty = !plan || (!plan.tasks.length && !plan.phases.length);
  // The plan goes with its Chat; a later one starts closed.
  useEffect(() => {
    if (empty) setOpened(false);
  }, [empty]);
  const { done, total } = plan ? taskCounts(plan.tasks) : { done: 0, total: 0 };
  const phase = plan ? currentPhase(plan) : undefined;
  const toggle = (id: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <PillMorph
      shown={!empty}
      slot="task-track"
      panelSlot="task-popover"
      title="Tasks"
      tooltip="Tasks"
      opened={opened}
      onOpenChange={(next) => {
        if (next) setOpening((count) => count + 1);
        setOpened(next);
      }}
      width={PANEL_WIDTH}
      height={PANEL_HEIGHT}
      pill={{
        icon: ListTodoIcon,
        "aria-label": total ? `Tasks, ${done} of ${total} done` : `Phase: ${phase ? PHASE_LABELS[phase] : ""}`,
        ...(total ? { count: done, total } : { label: phase ? PHASE_LABELS[phase] : "" }),
      }}
    >
      {(close) => {
        if (!plan) return null;
        const collapse = (
          <IconButton label="Collapse tasks" icon={ArrowShrink02Icon} size={24} onClick={close} className="-my-1 focus-visible:-outline-offset-2" />
        );
        return (
          <div className="flex min-h-0 flex-col gap-1 p-1">
            {plan.tasks.length > 0 && (
              <div className="flex shrink-0 items-center gap-2 px-2 pt-1">
                <SectionLabel as="h3" id={`${panelId}-tasks`} className="flex flex-1 items-center justify-between">
                  <span>Tasks</span>
                  <span className="tabular-nums">{total}</span>
                </SectionLabel>
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
          </div>
        );
      }}
    </PillMorph>
  );
}
