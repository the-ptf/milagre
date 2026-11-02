import { Fragment, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, ArrowDown01Icon, ArrowUp01Icon, Delete02Icon, Link01Icon, MoreHorizontalIcon, PlusSignIcon } from "@hugeicons/core-free-icons";
import type { FlowStep, FlowStepKind, ModelProvider } from "@milagre/shared/model";
import { FLOW_STEP_TYPES, insertStep, moveStep, newStep, removeStep, stepSubtitle, stepTitle } from "@milagre/shared/routine-flows";
import { FIELD_ICON, STEP_LOOK, type HugeIconData } from "./flow-look";
import { MenuRow, Popover, usePopover } from "./FlowPopover";

type Where = { parentId: string | null; branch: "yes" | "otherwise" | null; index: number };

/** A step type's tile: its icon on its color. */
export function StepTile({ kind, dim = false }: { kind: FlowStepKind | "trigger"; dim?: boolean }) {
  const look = STEP_LOOK[kind];
  return (
    <span className={`flex size-8 shrink-0 items-center justify-center rounded-control ${look.tile} ${dim ? "opacity-60" : ""}`}>
      <HugeiconsIcon icon={look.icon} size={16} strokeWidth={1.8} color="currentColor" />
    </span>
  );
}

/** A field a step gives, as a small chip on its card: its type's glyph and its name. */
export function FieldChip({ icon, label }: { icon: HugeIconData; label: string }) {
  return (
    <span
      data-flow-field-chip={label}
      className="inline-flex h-6 max-w-[140px] shrink-0 items-center gap-1 rounded-chip border border-line px-1.5 text-11 text-ink-2"
    >
      <HugeiconsIcon icon={icon} size={12} strokeWidth={1.6} color="currentColor" className="shrink-0 text-ink-3" />
      <span className="truncate">{label}</span>
    </span>
  );
}

/** The chips a step's card shows: an agent step's output fields, a pull request's link. */
function stepChips(step: FlowStep): Array<{ icon: HugeIconData; label: string }> {
  if (step.kind === "agent") return step.output.map((field) => ({ icon: FIELD_ICON[field.type] ?? FIELD_ICON.text, label: field.name || "field" }));
  if (step.kind === "pull-request") return [{ icon: Link01Icon, label: "url" }];
  return [];
}

/**
 * A card in the flow: tile, title and subtitle, then `trailing` (chips, state). The card's body selects it; `menu` sits
 * beside it, outside the button.
 */
export function FlowCard({
  kind,
  title,
  subtitle,
  subtitleTone = "text-ink-3",
  selected = false,
  ring,
  dim = false,
  trailing,
  menu,
  onSelect,
  ...data
}: {
  kind: FlowStepKind | "trigger";
  title: string;
  subtitle: string;
  subtitleTone?: string;
  selected?: boolean;
  /** A ring that says the card's state (waiting, failed), over the selected one's. */
  ring?: string;
  dim?: boolean;
  trailing?: ReactNode;
  menu?: ReactNode;
  onSelect: () => void;
} & Record<`data-${string}`, string | boolean | undefined>) {
  return (
    <div
      className={`group relative flex min-h-16 items-center rounded-card bg-surface shadow-card transition-shadow ${
        ring ?? (selected ? "ring-2 ring-accent" : "")
      }`}
      {...data}
    >
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className={`flex min-w-0 flex-1 items-center gap-3 rounded-card py-3 pl-3 text-left outline-none focus-visible:bg-hover ${menu ? "pr-1" : "pr-3"}`}
      >
        <StepTile kind={kind} dim={dim} />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className={`truncate text-13 font-semibold ${dim ? "text-ink-3" : "text-ink"}`}>{title}</span>
          <span className={`truncate text-12 ${subtitleTone}`}>{subtitle}</span>
        </span>
        {trailing && <span className="flex shrink-0 items-center gap-2">{trailing}</span>}
      </button>
      {menu && <span className="flex shrink-0 items-center pr-2">{menu}</span>}
    </div>
  );
}

/** The ⋯ on a step's card and in its inspector: Move up, Move down, Delete. */
export function StepMenu({
  name,
  canUp,
  canDown,
  onMove,
  onDelete,
  inline = false,
}: {
  name: string;
  canUp: boolean;
  canDown: boolean;
  onMove: (by: -1 | 1) => void;
  onDelete: () => void;
  /** In the inspector's header: always shown, not only on hover. */
  inline?: boolean;
}) {
  const popover = usePopover(180, "end");
  const pick = (work: () => void) => {
    popover.close(false);
    work();
  };
  return (
    <>
      <button
        ref={popover.trigger}
        type="button"
        aria-label={`Actions for ${name}`}
        aria-haspopup="menu"
        aria-expanded={popover.open}
        data-flow-step-more
        onClick={popover.toggle}
        className={`flex size-7 shrink-0 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-hover-2 hover:text-ink ${
          inline ? "" : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
        } ${popover.open ? "bg-hover-2 text-ink opacity-100" : ""}`}
      >
        <HugeiconsIcon icon={MoreHorizontalIcon} size={16} strokeWidth={1.8} color="currentColor" />
      </button>
      <Popover state={popover} label={`Actions for ${name}`} width={180} role="menu" className="p-1.5" data-flow-step-menu>
        <MenuRow icon={ArrowUp01Icon} label="Move up" disabled={!canUp} onSelect={() => pick(() => onMove(-1))} data-flow-action="up" />
        <MenuRow icon={ArrowDown01Icon} label="Move down" disabled={!canDown} onSelect={() => pick(() => onMove(1))} data-flow-action="down" />
        <MenuRow icon={Delete02Icon} label="Delete" danger onSelect={() => pick(onDelete)} data-flow-action="delete" />
      </Popover>
    </>
  );
}

/** The Add step menu: every step type with its tile and what it does. */
function AddStepMenu({ heading, onPick, state }: { heading: string; onPick: (kind: FlowStepKind) => void; state: ReturnType<typeof usePopover> }) {
  return (
    <Popover state={state} label={heading} width={360} role="menu" className="p-1.5" data-flow-add-menu>
      <p className="px-2 pt-1 pb-1.5 text-12 font-medium text-ink-3">{heading}</p>
      {FLOW_STEP_TYPES.map((type) => (
        <MenuRow
          key={type.kind}
          icon={STEP_LOOK[type.kind].icon}
          tile={STEP_LOOK[type.kind].tile}
          label={type.name}
          description={type.description}
          data-flow-add={type.kind}
          onSelect={() => {
            state.close(false);
            onPick(type.kind);
          }}
        />
      ))}
    </Popover>
  );
}

const pathHeading = (where: Where) => (where.parentId === null ? "Add a step here" : `Add to the ${where.branch === "yes" ? "Yes" : "Otherwise"} path`);

/** The rail between two cards, with its + that opens the Add step menu for that place. */
function Connector({ where, onAdd, tall = false }: { where: Where; onAdd: (kind: FlowStepKind, where: Where) => void; tall?: boolean }) {
  const popover = usePopover(360);
  return (
    <div className={`relative ${tall ? "h-8" : "h-6"}`} data-flow-connector={`${where.parentId ?? "top"}:${where.branch ?? ""}:${where.index}`}>
      <span aria-hidden className="absolute top-0 bottom-0 left-[27px] w-px bg-line-strong" />
      <button
        ref={popover.trigger}
        type="button"
        aria-label={pathHeading(where)}
        aria-haspopup="menu"
        aria-expanded={popover.open}
        data-flow-add-here
        onClick={popover.toggle}
        className="group/add absolute top-1/2 left-4 flex size-6 -translate-y-1/2 items-center justify-center rounded-full outline-none"
      >
        <span
          className={`flex size-4 items-center justify-center rounded-full border bg-surface transition-colors group-hover/add:border-accent group-hover/add:text-accent-ink group-focus-visible/add:border-accent ${
            popover.open ? "border-accent text-accent-ink" : "border-line-strong text-ink-3"
          }`}
        >
          <HugeiconsIcon icon={PlusSignIcon} size={12} strokeWidth={1.6} color="currentColor" />
        </span>
      </button>
      <AddStepMenu heading={pathHeading(where)} state={popover} onPick={(kind) => onAdd(kind, where)} />
    </div>
  );
}

/** An empty path's dashed row: it opens the Add step menu for the path. */
function EmptyPath({ where, onAdd }: { where: Where; onAdd: (kind: FlowStepKind, where: Where) => void }) {
  const popover = usePopover(360);
  return (
    <>
      <button
        ref={popover.trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={popover.open}
        data-flow-empty-path={`${where.parentId}:${where.branch}`}
        onClick={popover.toggle}
        className={`flex h-9 w-full items-center gap-2 rounded-control border border-dashed px-3 text-left text-12 transition-colors hover:border-accent hover:bg-accent-tint hover:text-accent-ink ${
          popover.open ? "border-accent bg-accent-tint text-accent-ink" : "border-line-strong text-ink-3"
        }`}
      >
        <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={1.8} color="currentColor" className="shrink-0" />
        <span className="truncate">Add step to this path, or leave it empty to go straight on</span>
      </button>
      <AddStepMenu heading={pathHeading(where)} state={popover} onPick={(kind) => onAdd(kind, where)} />
    </>
  );
}

/** A path's label on the rail under its If: "Yes", "Otherwise", or in the Run view "Yes, taken". */
export function PathLabel({ text, tone = "bg-field text-ink-2" }: { text: string; tone?: string }) {
  return (
    <div className="relative flex h-8 items-center pl-9" data-flow-path-label={text}>
      <span aria-hidden className="absolute top-1/2 left-[27px] h-px w-[9px] bg-line-strong" />
      <span className={`inline-flex h-6 items-center rounded-chip px-2 text-12 font-medium ${tone}`}>{text}</span>
    </div>
  );
}

/** Under an If: its two paths, indented on a rail that runs down from the If. */
function PathsBlock({ children }: { children: ReactNode }) {
  return (
    <div className="relative">
      <span aria-hidden className="absolute top-0 bottom-0 left-[27px] w-px bg-line-strong" />
      {children}
    </div>
  );
}

/**
 * The draft as a list: the trigger's card, then each step's card with a + on the rail between them, an If's paths
 * indented under it. A card selects its step; its ⋯ moves or deletes it. Adding a step selects it.
 */
export function FlowStepList({
  steps,
  selectedId,
  problems,
  trigger,
  modelName,
  onSelect,
  onChange,
}: {
  steps: FlowStep[];
  selectedId: string | null;
  /** The first problem of each step that has one, by step id. */
  problems: ReadonlyMap<string, string>;
  /** The trigger's card, first in the list. */
  trigger: ReactNode;
  modelName: (provider: ModelProvider | undefined, model: string) => string;
  onSelect: (id: string) => void;
  onChange: (steps: FlowStep[], select?: string | null) => void;
}) {
  const add = (kind: FlowStepKind, where: Where) => {
    const step = newStep(kind, steps);
    onChange(insertStep(steps, where, step), step.id);
  };
  const card = (step: FlowStep, index: number, count: number) => {
    const problem = problems.get(step.id);
    const chips = stepChips(step);
    return (
      <FlowCard
        kind={step.kind}
        title={stepTitle(step) || "Untitled step"}
        subtitle={stepSubtitle(step, { modelName })}
        selected={step.id === selectedId}
        onSelect={() => onSelect(step.id)}
        data-flow-step={step.id}
        data-flow-kind={step.kind}
        trailing={
          <>
            {chips.slice(0, 3).map((chip) => (
              <FieldChip key={chip.label} icon={chip.icon} label={chip.label} />
            ))}
            {chips.length > 3 && <span className="text-11 text-ink-3">+{chips.length - 3}</span>}
            {problem && (
              <span role="img" aria-label={problem} title={problem} data-flow-step-problem className="flex size-5 items-center justify-center text-red-ink">
                <HugeiconsIcon icon={Alert02Icon} size={14} strokeWidth={1.8} color="currentColor" />
              </span>
            )}
          </>
        }
        menu={
          <StepMenu
            name={step.name}
            canUp={index > 0}
            canDown={index < count - 1}
            onMove={(by) => onChange(moveStep(steps, step.id, by))}
            onDelete={() => onChange(removeStep(steps, step.id), null)}
          />
        }
      />
    );
  };
  const list = (items: FlowStep[], parentId: string | null, branch: "yes" | "otherwise" | null): ReactNode =>
    items.map((step, index) => (
      <Fragment key={step.id}>
        {(index > 0 || parentId === null) && <Connector where={{ parentId, branch, index }} onAdd={add} />}
        {card(step, index, items.length)}
        {step.kind === "if" && (
          <PathsBlock>
            {(["yes", "otherwise"] as const).map((path) => (
              <Fragment key={path}>
                <PathLabel text={path === "yes" ? "Yes" : "Otherwise"} />
                <div className="pl-11" data-flow-path={`${step.id}:${path}`}>
                  {step[path].length === 0 ? (
                    <EmptyPath where={{ parentId: step.id, branch: path, index: 0 }} onAdd={add} />
                  ) : (
                    <>
                      {list(step[path], step.id, path)}
                      <Connector where={{ parentId: step.id, branch: path, index: step[path].length }} onAdd={add} />
                    </>
                  )}
                </div>
              </Fragment>
            ))}
            <div className="h-2" />
          </PathsBlock>
        )}
      </Fragment>
    ));

  return (
    <div data-flow-step-list>
      {trigger}
      {list(steps, null, null)}
      <Connector where={{ parentId: null, branch: null, index: steps.length }} onAdd={add} tall />
    </div>
  );
}

/** A flow with no steps yet: under the trigger, a tile for each step type. */
export function NextStepTiles({ onAdd }: { onAdd: (kind: FlowStepKind) => void }) {
  return (
    <section data-flow-empty className="rounded-card bg-accent-tint p-4">
      <h3 className="text-15 font-semibold text-ink">What should happen next?</h3>
      <p className="mt-1 text-12 text-ink-2">Each step can read what the trigger and earlier steps give.</p>
      <div className="mt-4 grid grid-cols-3 gap-2">
        {FLOW_STEP_TYPES.map((type) => (
          <button
            key={type.kind}
            type="button"
            data-flow-tile={type.kind}
            title={type.description}
            onClick={() => onAdd(type.kind)}
            className="flex h-20 flex-col items-center justify-center gap-2 rounded-control bg-surface shadow-card transition-colors hover:bg-hover"
          >
            <StepTile kind={type.kind} />
            <span className="text-12 font-medium text-ink">{type.short}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
