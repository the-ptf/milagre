import { useEffect, useState } from "react";
import { RESOURCES_REFRESH_MS, resourceMeters, type ComputerResources, type ResourceMeter } from "@milagre/shared/computer-resources";
import { ipcErrorMessage } from "@milagre/shared/result";
import type { MilagreBridge } from "../../electron";

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

function Meter({ meter }: { meter: ResourceMeter }) {
  const { milagre, other, free } = meter.shares;
  return (
    <div data-resource-meter={meter.label.toLowerCase()} className="grid grid-cols-[52px_minmax(80px,180px)_1fr] items-center gap-3">
      <span className="text-12 text-ink-2">{meter.label}</span>
      <div
        role="meter"
        aria-label={`${meter.label} in use`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round((1 - free) * 100)}
        className="flex h-1.5 overflow-hidden rounded-full bg-inset"
      >
        <div className="h-full bg-accent" style={{ width: `${milagre * 100}%` }} />
        <div className="h-full bg-ink-4" style={{ width: `${other * 100}%` }} />
      </div>
      <span className="min-w-0 truncate text-12 tabular-nums text-ink-3">
        {meter.summary}
        {meter.milagre && (
          <>
            {" · "}
            <span className="text-ink-2">{meter.milagre}</span>
          </>
        )}
      </span>
    </div>
  );
}

/** One computer's row: its name, then a meter for memory and one for disk, Milagre's share in the accent colour. */
export function ComputerResourcesRow({
  name,
  detail,
  bridge,
  enabled = true,
}: {
  name: string;
  detail?: string;
  bridge: Pick<MilagreBridge, "readComputerResources">;
  /** Off while the computer is offline: nothing answers, so nothing is asked. */
  enabled?: boolean;
}) {
  const { resources, error } = useComputerResources(bridge, enabled);
  // An older Milagre answers with an unknown command.
  const older = error !== null && /unknown|not (available|allowed|supported)|no handler/i.test(error);
  return (
    <div data-computer-resources={name} className="grid gap-2 px-4 py-3">
      <div className="flex items-baseline gap-2">
        <span className="text-13 font-medium text-ink">{name}</span>
        {detail && <span className="text-12 text-ink-3">{detail}</span>}
      </div>
      {!enabled ? (
        <span className="text-12 text-ink-3">Offline</span>
      ) : resources ? (
        resourceMeters(resources).map((meter) => <Meter key={meter.label} meter={meter} />)
      ) : error ? (
        <span className="text-12 text-ink-3">{older ? `Update Milagre on ${name} to see its memory and disk.` : `Couldn't read: ${error}`}</span>
      ) : (
        <span className="text-12 text-ink-3">Reading…</span>
      )}
    </div>
  );
}
