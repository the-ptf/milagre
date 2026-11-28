import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowUp01Icon, Delete02Icon, MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import type { FlowStepKind } from "@milagre/shared/model";
import { FLOW_STEP_TYPES } from "@milagre/shared/routine-flows";
import { STEP_LOOK, type HugeIconData } from "./flow-look";
import { MenuRow, Popover, usePopover } from "./FlowPopover";

export function StepTile({ kind, dim = false }: { kind: FlowStepKind | "trigger"; dim?: boolean }) {
  const look = STEP_LOOK[kind];
  return (
    <span className={`flex size-8 shrink-0 items-center justify-center rounded-control ${look.tile} ${dim ? "opacity-60" : ""}`}>
      <HugeiconsIcon icon={look.icon} size={16} strokeWidth={1.8} color="currentColor" />
    </span>
  );
}

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

export function AddStepMenu({ heading, onPick, state }: { heading: string; onPick: (kind: FlowStepKind) => void; state: ReturnType<typeof usePopover> }) {
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
