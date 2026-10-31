import { useEffect, useState, type KeyboardEvent } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, ArrowRight01Icon, ComputerIcon, HardDriveIcon, LaptopIcon, Loading03Icon, RamMemoryIcon } from "@hugeicons/core-free-icons";
import {
  BREAKDOWN_TITLE,
  MEASURING_TOOLTIP,
  RESOURCES_REFRESH_MS,
  UNREADABLE,
  partOpacity,
  resourceGauges,
  type ComputerResources,
  type ResourceGauge,
} from "@milagre/shared/computer-resources";
import { ipcErrorMessage } from "@milagre/shared/result";
import Tooltip from "../primitives/Tooltip";
import type { MilagreBridge } from "../../electron";

type IconData = Parameters<typeof HugeiconsIcon>[0]["icon"];
const Icon = ({ icon, size = 16, className = "" }: { icon: IconData; size?: number; className?: string }) => (
  <HugeiconsIcon icon={icon} size={size} strokeWidth={1.8} color="currentColor" className={className} />
);

type ResourcesState = { resources: ComputerResources | null; error: string | null };

/** A computer's memory and disk, read again every 15 seconds while shown. */
function useComputerResources(bridge: Pick<MilagreBridge, "readComputerResources">, enabled = true): ResourcesState {
  const [state, setState] = useState<ResourcesState>({ resources: null, error: null });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const read = () =>
      bridge.readComputerResources().then(
        (resources) => live && setState({ resources, error: null }),
        (error) => live && setState((current) => ({ resources: current.resources, error: ipcErrorMessage(error) })),
      );
    void read();
    const timer = window.setInterval(() => void read(), RESOURCES_REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [bridge, enabled]);
  return state;
}

/** One computer on the Devices page. `detail` is its second line: This Mac, its route, or Offline. */
export type ResourceComputer = {
  id: string;
  name: string;
  detail: string;
  bridge: Pick<MilagreBridge, "readComputerResources">;
  online: boolean;
  /** "Seen 2h ago", for an offline computer. */
  seen?: string | null;
};

const COLUMNS = "grid grid-cols-[130px_minmax(0,1fr)_minmax(0,1fr)_14px] items-center gap-5";

function Bar({ gauge, open }: { gauge: ResourceGauge; open: boolean }) {
  const { milagre, other, free } = gauge.shares;
  return (
    <Tooltip label={gauge.tooltip} className="w-full">
      <div
        role="meter"
        aria-label={`${gauge.kind === "memory" ? "Memory" : "Disk"} in use. ${gauge.tooltip}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round((1 - free) * 100)}
        data-resource-bar={gauge.kind}
        className="flex h-1 w-full gap-px overflow-hidden rounded-full bg-inset"
      >
        {open && gauge.parts.length > 0 ? (
          gauge.parts.map((part, index) => (
            <div key={part.kind} className="h-full bg-accent" style={{ width: `${part.share * 100}%`, opacity: partOpacity(index) }} />
          ))
        ) : (
          <div className="h-full rounded-full bg-accent" style={{ width: `${milagre * 100}%` }} />
        )}
        <div className={`h-full rounded-full ${gauge.low ? "bg-orange" : "bg-ink-4"}`} style={{ width: `${other * 100}%` }} />
      </div>
    </Tooltip>
  );
}

function Gauge({ gauge, open }: { gauge: ResourceGauge; open: boolean }) {
  return (
    <div data-resource-meter={gauge.kind} className="grid min-w-0 gap-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className={gauge.low ? "text-orange-ink" : "text-ink-2"}>
          <Icon icon={gauge.kind === "memory" ? RamMemoryIcon : HardDriveIcon} />
        </span>
        <span className={`text-13 font-semibold tabular-nums ${gauge.low ? "text-orange-ink" : "text-ink"}`}>{gauge.free}</span>
        <span className="min-w-0 flex-1 truncate text-12 tabular-nums text-ink-3">{gauge.of}</span>
        {gauge.measuring && (
          <Tooltip label={MEASURING_TOOLTIP}>
            <span data-resource-measuring className="flex text-ink-3">
              <Icon icon={Loading03Icon} size={14} className="animate-spin" />
            </span>
          </Tooltip>
        )}
      </div>
      <Bar gauge={gauge} open={open} />
    </div>
  );
}

function Parts({ gauge }: { gauge: ResourceGauge | null }) {
  if (!gauge) return <div />;
  if (gauge.measuring) return <span className="self-start text-12 text-ink-3">{MEASURING_TOOLTIP}…</span>;
  return (
    <ul data-resource-parts={gauge.kind} className="grid gap-1.5 self-start">
      {gauge.parts.map((part, index) => (
        <li key={part.kind} className="flex items-center gap-2 text-12">
          <span aria-hidden className="size-2 shrink-0 rounded-inline bg-accent" style={{ opacity: partOpacity(index) }} />
          <span className="min-w-0 flex-1 truncate text-ink-2">{part.label}</span>
          <span className="tabular-nums text-ink">{part.value}</span>
        </li>
      ))}
    </ul>
  );
}

function Who({ computer, icon, warning }: { computer: ResourceComputer; icon: IconData; warning?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span className={computer.online ? "text-ink-2" : "text-ink-4"}>
        <Icon icon={icon} />
      </span>
      <div className="grid min-w-0">
        <span className={`truncate text-13 font-semibold ${computer.online ? "text-ink" : "text-ink-2"}`}>{computer.name}</span>
        <span className={`truncate text-12 ${warning ? "text-orange-ink" : "text-ink-3"}`}>{warning ?? computer.detail}</span>
      </div>
    </div>
  );
}

function Skeleton({ icon }: { icon: IconData }) {
  return (
    <div className="grid gap-1.5" aria-hidden>
      <div className="flex items-center gap-2 text-ink-4">
        <Icon icon={icon} />
        <span className="h-3 w-24 animate-pulse rounded-inline bg-hover" />
      </div>
      <span className="h-1 w-full animate-pulse rounded-full bg-hover" />
    </div>
  );
}

const isDesktop = (name: string) => /studio|mini|imac/i.test(name);

function ComputerResourceRow({ computer, open, onToggle }: { computer: ResourceComputer; open: boolean; onToggle: () => void }) {
  const { resources, error } = useComputerResources(computer.bridge, computer.online);
  const gauges = resources ? resourceGauges(resources) : null;
  const icon = isDesktop(computer.name) ? ComputerIcon : LaptopIcon;
  // An older Milagre answers with an unknown command.
  const older = error !== null && /unknown|not (available|allowed|supported)|no handler/i.test(error);
  const unreadable = resources !== null && gauges === null;
  if (!computer.online || (!gauges && (error || unreadable))) {
    return (
      <div data-computer-resources={computer.name} className={`${COLUMNS} px-4 py-3 ${computer.online ? "" : "opacity-70"}`}>
        <Who computer={computer} icon={icon} />
        <span className="col-span-2 truncate text-12 text-ink-3">
          {!computer.online
            ? (computer.seen ?? "Offline")
            : unreadable
              ? UNREADABLE
              : older
                ? `Milagre on ${computer.name} can't report memory and disk yet. Update it to see them.`
                : `Couldn't read: ${error}`}
        </span>
        <span />
      </div>
    );
  }
  if (!gauges) {
    return (
      <div data-computer-resources={computer.name} data-resources-reading className={`${COLUMNS} px-4 py-3`}>
        <Who computer={computer} icon={icon} warning={undefined} />
        <Skeleton icon={RamMemoryIcon} />
        <Skeleton icon={HardDriveIcon} />
        <span />
      </div>
    );
  }
  const toggle = (event?: KeyboardEvent) => {
    if (event && event.key !== "Enter" && event.key !== " ") return;
    event?.preventDefault();
    onToggle();
  };
  return (
    <div data-computer-resources={computer.name} data-open={open ? "" : undefined} className={open ? "bg-hover/50" : undefined}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`${computer.name}: ${BREAKDOWN_TITLE.toLowerCase()}`}
        onClick={() => toggle()}
        onKeyDown={toggle}
        className={`${COLUMNS} cursor-default px-4 py-3 outline-none hover:bg-hover/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent`}
      >
        <Who computer={computer} icon={icon} warning={gauges.memory.low ? "Low on memory" : undefined} />
        <Gauge gauge={gauges.memory} open={open} />
        {gauges.disk ? <Gauge gauge={gauges.disk} open={open} /> : <span />}
        <span className="text-ink-3">
          <Icon icon={open ? ArrowDown01Icon : ArrowRight01Icon} size={14} />
        </span>
      </div>
      {open && (
        <div data-resource-breakdown className={`${COLUMNS} items-start px-4 pb-4 pt-1`}>
          <span />
          <Parts gauge={gauges.memory} />
          <Parts gauge={gauges.disk} />
          <span />
        </div>
      )}
    </div>
  );
}

/** The Devices page's memory and disk rows. Clicking a row opens what Milagre uses there; one row opens at a time. */
export function ComputerResourceList({ computers, initiallyOpen = null }: { computers: ResourceComputer[]; initiallyOpen?: string | null }) {
  const [open, setOpen] = useState<string | null>(initiallyOpen);
  return (
    <>
      {computers.map((computer) => (
        <ComputerResourceRow
          key={computer.id}
          computer={computer}
          open={open === computer.id}
          onToggle={() => setOpen((current) => (current === computer.id ? null : computer.id))}
        />
      ))}
    </>
  );
}
