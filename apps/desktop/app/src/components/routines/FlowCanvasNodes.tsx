import { createContext, useContext, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, ArrowDown01Icon, Invoice03Icon, PlusSignIcon, SplitIcon } from "@hugeicons/core-free-icons";
import type { NodeProps } from "@xyflow/react";
import type { FlowField, FlowStep, FlowStepKind, FlowStepRun } from "@milagre/shared/model";
import type { FlowPlace } from "@milagre/shared/routine-flow-graph";
import { conditionText, stepTitle } from "@milagre/shared/routine-flows";
import { FIELD_ICON, STEP_LOOK } from "./flow-look";
import { AddStepMenu, StepMenu } from "./FlowSteps";
import { usePopover } from "./FlowPopover";
import { StateIcon } from "./FlowRun";

export type RunMark = { status: string; state: FlowStepRun | null; text: string; tone: string };

export interface CanvasHandlers {
  mode: "edit" | "run";
  selected: string | null;
  select: (id: string) => void;
  lit: ReadonlySet<string>;
  badRefs: ReadonlySet<string>;
  problems: ReadonlyMap<string, string>;
  subtitle: (step: FlowStep) => string;
  trigger: { title: string; subtitle: string; fields: Array<{ ref: string; label: string; type: FlowField["type"] }> };
  mark?: (id: string) => RunMark | undefined;
  add?: (kind: FlowStepKind, where: FlowPlace) => void;
  move?: (id: string, by: -1 | 1) => void;
  remove?: (id: string) => void;
  siblings?: (where: FlowPlace) => number;
  toggleFold: (key: string) => void;
}

export const CanvasContext = createContext<CanvasHandlers | null>(null);

const useCanvas = () => {
  const value = useContext(CanvasContext);
  if (!value) throw new Error("Flow canvas parts need a CanvasContext");
  return value;
};

export type StepNodeData = { step: FlowStep; where: FlowPlace };
export type PathNodeData = { kind: "empty" | "collapsed"; count: number; where: FlowPlace; foldKey: string };

const pathHeading = (where: FlowPlace) => (where.parentId === null ? "Add a step here" : `Add to the ${where.branch === "yes" ? "Yes" : "Otherwise"} path`);

export function AddButton({ where, label, className = "", children }: { where: FlowPlace; label?: string; className?: string; children?: ReactNode }) {
  const canvas = useCanvas();
  const popover = usePopover(360);
  if (!canvas.add) return null;
  const heading = label ?? pathHeading(where);
  return (
    <>
      <button
        ref={popover.trigger}
        type="button"
        aria-label={heading}
        aria-haspopup="menu"
        aria-expanded={popover.open}
        data-flow-add-here={`${where.parentId ?? "top"}:${where.branch ?? ""}:${where.index}`}
        onClick={(event) => {
          event.stopPropagation();
          popover.toggle();
        }}
        className={`nodrag nopan pointer-events-auto ${className} ${popover.open ? "is-open" : ""}`}
      >
        {children ?? <HugeiconsIcon icon={PlusSignIcon} size={10} strokeWidth={2.4} color="currentColor" />}
      </button>
      <AddStepMenu heading={heading} state={popover} onPick={(kind) => canvas.add?.(kind, where)} />
    </>
  );
}

function FieldPorts({ owner, fields }: { owner: string; fields: Array<{ name: string; label?: string; type: FlowField["type"] }> }) {
  const canvas = useCanvas();
  if (fields.length === 0) return null;
  return (
    <span data-flow-ports className="flow-canvas-detail pointer-events-none absolute top-full left-1/2 flex -translate-x-1/2 -translate-y-1/2 gap-1">
      {fields.slice(0, 4).map((field) => {
        const ref = `${owner}.${field.name}`;
        const lit = canvas.lit.has(ref);
        const bad = canvas.badRefs.has(ref);
        return (
          <span
            key={field.name}
            data-flow-port={ref}
            data-lit={lit || undefined}
            className={`inline-flex h-5 items-center gap-1 rounded-chip px-1.5 font-mono text-11 whitespace-nowrap transition-colors ${
              bad ? "bg-surface text-red-ink ring-1 ring-red" : lit ? "bg-ink text-surface" : "bg-surface text-ink-2 ring-1 ring-line-strong"
            }`}
          >
            <HugeiconsIcon
              icon={FIELD_ICON[field.type] ?? FIELD_ICON.text}
              size={12}
              strokeWidth={1.6}
              color="currentColor"
              className={lit ? "" : "text-ink-3"}
            />
            {field.label ?? field.name}
          </span>
        );
      })}
      {fields.length > 4 && (
        <span className="inline-flex h-5 items-center rounded-chip bg-surface px-1.5 text-11 text-ink-3 ring-1 ring-line-strong">+{fields.length - 4}</span>
      )}
    </span>
  );
}

function Toolbar({ step, where }: { step: FlowStep; where: FlowPlace }) {
  const canvas = useCanvas();
  if (canvas.mode !== "edit" || canvas.selected !== step.id || !canvas.add) return null;
  const count = canvas.siblings?.(where) ?? 1;
  const button =
    "flex h-6 items-center gap-1 rounded-chip px-1.5 text-12 font-medium whitespace-nowrap text-ink-2 transition-colors hover:bg-hover hover:text-ink";
  const plus = <HugeiconsIcon icon={PlusSignIcon} size={12} strokeWidth={2} color="currentColor" />;
  return (
    <div
      data-flow-toolbar-step={step.id}
      className="nodrag nopan absolute top-0 right-2 z-10 flex -translate-y-1/2 items-center gap-0.5 rounded-control bg-surface p-0.5 shadow-raised"
      onClick={(event) => event.stopPropagation()}
    >
      {step.kind === "if" ? (
        <>
          <AddButton where={{ parentId: step.id, branch: "yes", index: step.yes.length }} className={button}>
            {plus}Yes
          </AddButton>
          <AddButton where={{ parentId: step.id, branch: "otherwise", index: step.otherwise.length }} className={button}>
            {plus}Otherwise
          </AddButton>
        </>
      ) : (
        <AddButton where={{ ...where, index: where.index + 1 }} label="Add a step after this one" className={button}>
          {plus}Add after
        </AddButton>
      )}
      <span aria-hidden className="mx-0.5 h-4 w-px bg-line" />
      <StepMenu
        inline
        name={step.name}
        canUp={where.index > 0}
        canDown={where.index < count - 1}
        onMove={(by) => canvas.move?.(step.id, by)}
        onDelete={() => canvas.remove?.(step.id)}
      />
    </div>
  );
}

function ringFor(selected: boolean, mark: RunMark | undefined) {
  if (mark?.status === "failed") return "ring-2 ring-red";
  if (mark?.status === "waiting" && mark.state?.approval && !mark.state.approval.decision) return "ring-2 ring-orange";
  return selected ? "ring-2 ring-ink" : "";
}

function Card({
  id,
  kind,
  title,
  subtitle,
  subtitleTone = "text-ink-3",
  trailing,
  children,
}: {
  id: string;
  kind: FlowStepKind | "trigger";
  title: string;
  subtitle: string;
  subtitleTone?: string;
  trailing?: ReactNode;
  children?: ReactNode;
}) {
  const canvas = useCanvas();
  const mark = canvas.mark?.(id);
  const dim = canvas.mode === "run" && (!mark || ["pending", "not-taken", "not-run"].includes(mark.status));
  const look = STEP_LOOK[kind];
  return (
    <div className="relative" data-flow-node={id} data-flow-kind={kind} data-flow-run-status={mark?.status}>
      {kind === "trigger" && <span className="absolute -top-5 left-0.5 text-11 font-medium text-ink-3">Trigger</span>}
      <div
        className={`flex h-16 w-[264px] items-center gap-3 rounded-card bg-surface px-3 shadow-card transition-[box-shadow,opacity] hover:shadow-raised ${ringFor(
          canvas.selected === id,
          mark,
        )} ${dim ? "opacity-40" : ""}`}
      >
        <span className={`flex size-8 shrink-0 items-center justify-center rounded-control ${look.tile}`}>
          <HugeiconsIcon icon={look.icon} size={16} strokeWidth={1.8} color="currentColor" />
        </span>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="truncate text-13 font-semibold text-ink">{title}</span>
          <span className={`flow-canvas-detail truncate text-12 ${subtitleTone}`}>{subtitle}</span>
        </span>
        {trailing && <span className="flex shrink-0 items-center gap-1">{trailing}</span>}
      </div>
      {children}
    </div>
  );
}

export function TriggerNode() {
  const canvas = useCanvas();
  const mark = canvas.mark?.("trigger");
  return (
    <Card
      id="trigger"
      kind="trigger"
      title={canvas.trigger.title}
      subtitle={mark?.text ?? canvas.trigger.subtitle}
      trailing={mark && <StateIcon status="done" />}
    >
      <FieldPorts
        owner="trigger"
        fields={canvas.trigger.fields.map((field) => ({ name: field.ref.slice("trigger.".length), label: field.label, type: field.type }))}
      />
    </Card>
  );
}

export function StepNode({ data }: NodeProps & { data: StepNodeData }) {
  const canvas = useCanvas();
  const { step, where } = data;
  const mark = canvas.mark?.(step.id);
  const problem = canvas.mode === "edit" ? canvas.problems.get(step.id) : undefined;
  const fields = step.kind === "agent" ? step.output.map((field) => ({ name: field.name || "field", type: field.type })) : [];
  return (
    <Card
      id={step.id}
      kind={step.kind}
      title={stepTitle(step) || "Untitled step"}
      subtitle={mark ? mark.text : canvas.subtitle(step)}
      subtitleTone={mark?.tone}
      trailing={
        <>
          {mark?.state?.receipt && (
            <span role="img" aria-label="Receipt kept" className="flex size-5 items-center justify-center text-green-ink">
              <HugeiconsIcon icon={Invoice03Icon} size={14} strokeWidth={1.8} color="currentColor" />
            </span>
          )}
          {mark && <StateIcon status={mark.status} />}
          {problem && (
            <span role="img" aria-label={problem} title={problem} data-flow-step-problem className="flex size-5 items-center justify-center text-red-ink">
              <HugeiconsIcon icon={Alert02Icon} size={16} strokeWidth={1.8} color="currentColor" />
            </span>
          )}
        </>
      }
    >
      {!(canvas.mode === "run" && (!mark || mark.status === "not-taken")) && <FieldPorts owner={step.id} fields={fields} />}
      <Toolbar step={step} where={where} />
    </Card>
  );
}

export function ConditionNode({ data }: NodeProps & { data: StepNodeData }) {
  const canvas = useCanvas();
  const { step, where } = data;
  if (step.kind !== "if") return null;
  const mark = canvas.mark?.(step.id);
  const problem = canvas.mode === "edit" ? canvas.problems.get(step.id) : undefined;
  const dim = canvas.mode === "run" && (!mark || mark.status !== "done");
  const name = step.name && step.name !== "If" ? step.name : conditionText(step);
  return (
    <div className="flex w-[264px] justify-center" data-flow-node={step.id} data-flow-kind="if" data-flow-run-status={mark?.status}>
      <div className="relative">
        <div
          className={`flex h-10 max-w-[360px] items-center gap-2 rounded-full bg-surface pr-3.5 pl-1.5 whitespace-nowrap shadow-card transition-[box-shadow,opacity] hover:shadow-raised ${
            canvas.selected === step.id ? "ring-2 ring-ink" : ""
          } ${dim ? "opacity-40" : ""}`}
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-field text-ink-2">
            <HugeiconsIcon icon={SplitIcon} size={14} strokeWidth={1.8} color="currentColor" />
          </span>
          <span className="truncate text-13 font-semibold text-ink">{name}</span>
          {step.field && <span className="flow-canvas-detail truncate font-mono text-12 text-ink-3">{step.field}</span>}
          {mark?.status === "done" && <StateIcon status="done" />}
          {problem && (
            <span role="img" aria-label={problem} title={problem} data-flow-step-problem className="flex size-5 items-center justify-center text-red-ink">
              <HugeiconsIcon icon={Alert02Icon} size={16} strokeWidth={1.8} color="currentColor" />
            </span>
          )}
        </div>
        <Toolbar step={step} where={where} />
      </div>
    </div>
  );
}

export function PathNode({ data }: NodeProps & { data: PathNodeData }) {
  const canvas = useCanvas();
  const dim = canvas.mode === "run" && !canvas.mark?.(`${data.kind}:${data.foldKey}`);
  const shape = `flex h-7 w-[168px] items-center justify-center gap-1.5 rounded-full border border-dashed border-line-strong bg-surface px-3 text-12 whitespace-nowrap text-ink-3 transition-colors hover:border-ink-3 hover:text-ink ${dim ? "opacity-40" : ""}`;
  if (data.kind === "collapsed") {
    return (
      <button
        type="button"
        data-flow-collapsed={data.foldKey}
        className={`nodrag ${shape} border-solid font-medium`}
        onClick={(event) => {
          event.stopPropagation();
          canvas.toggleFold(data.foldKey);
        }}
      >
        {data.count === 1 ? "1 step" : `${data.count} steps`}
        <HugeiconsIcon icon={ArrowDown01Icon} size={12} strokeWidth={1.8} color="currentColor" />
      </button>
    );
  }
  if (canvas.mode !== "edit" || !canvas.add)
    return (
      <div data-flow-empty-path={data.foldKey} className={shape}>
        Goes straight on
      </div>
    );
  return (
    <AddButton where={data.where} className={shape}>
      <span data-flow-empty-path={data.foldKey} className="flex items-center gap-1.5">
        <HugeiconsIcon icon={PlusSignIcon} size={12} strokeWidth={2} color="currentColor" />
        Add a step, or skip
      </span>
    </AddButton>
  );
}
