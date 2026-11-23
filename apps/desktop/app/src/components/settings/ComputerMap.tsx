import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ComputerIcon, LaptopIcon, Search01Icon, SmartphoneIcon, Tablet01Icon } from "@hugeicons/core-free-icons";
import {
  MAP_ZOOM,
  fitZoom,
  layoutMachineMap,
  matchesMachine,
  zoomStep,
  type MapLineState,
  type MapMachine,
  type MapMachineKind,
  type MapPoint,
  type PlacedMachine,
} from "@milagre/shared/computer-map";
import { ZoomBar } from "../primitives/ZoomBar";
import { Icon } from "./settings-parts";

const KIND_ICON = { laptop: LaptopIcon, desktop: ComputerIcon, phone: SmartphoneIcon, tablet: Tablet01Icon } as const;
const STROKE: Record<MapLineState, string> = { active: "var(--green)", standby: "var(--ink-4)", offline: "var(--ink-4)", degraded: "var(--red)" };
const DOT: Record<MapLineState, string> = { active: "bg-green", standby: "bg-ink-4", offline: "bg-ink-4", degraded: "bg-red" };
const PILL: Record<MapLineState, string> = {
  active: "bg-green-tint text-green-ink",
  standby: "bg-field text-ink-2",
  offline: "bg-field text-ink-3",
  degraded: "bg-red-tint text-red-ink",
};
const DASH: Partial<Record<MapLineState, string>> = { offline: "4 4" };
const STATE_LABEL: Record<MapLineState, string> = { active: "in use", standby: "standby", offline: "offline", degraded: "refused" };
const LEGEND: { label: string; state: MapLineState }[] = [
  { label: "In use", state: "active" },
  { label: "Standby", state: "standby" },
  { label: "Offline", state: "offline" },
  { label: "Refused", state: "degraded" },
];

function Arrowheads({ id }: { id: string }) {
  return (
    <defs>
      {(Object.keys(STROKE) as MapLineState[]).map((state) => (
        <marker key={state} id={`${id}-${state}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 1 1 L 9 5 L 1 9" fill="none" stroke={STROKE[state]} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </marker>
      ))}
    </defs>
  );
}

function MachineCard({ machine, dimmed }: { machine: PlacedMachine; dimmed: boolean }) {
  const { rect } = machine;
  const label = `${machine.name}, ${machine.detail}, ${machine.route} ${STATE_LABEL[machine.state]}`;
  return (
    <div
      data-map-machine={machine.id}
      data-map-state={machine.state}
      role="listitem"
      aria-label={label}
      title={label}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      className={`absolute flex items-center gap-3 rounded-card bg-surface px-3 shadow-card transition-opacity ${dimmed ? "opacity-40" : ""}`}
    >
      <MachineTile kind={machine.kind} state={machine.state} />
      <span className="grid min-w-0 gap-0.5">
        <span className="truncate text-13 font-medium text-ink">{machine.name}</span>
        <span className="truncate text-11 text-ink-3">{machine.detail}</span>
      </span>
    </div>
  );
}

function MachineTile({ kind, state, hub = false }: { kind: MapMachineKind; state?: MapLineState; hub?: boolean }) {
  return (
    <span className={`relative flex size-8 shrink-0 items-center justify-center rounded-control ${hub ? "bg-ink text-on-ink" : "bg-field text-ink-2"}`}>
      <Icon icon={KIND_ICON[kind]} size={16} />
      {state && <span aria-hidden className={`absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-surface ${DOT[state]}`} />}
    </span>
  );
}

function LegendLine({ state, both = false }: { state: MapLineState; both?: boolean }) {
  const id = useId();
  return (
    <svg aria-hidden width="20" height="10" viewBox="0 0 20 10" className="shrink-0 overflow-visible">
      {both && <Arrowheads id={id} />}
      <path
        d="M 2 5 L 18 5"
        stroke={STROKE[state]}
        strokeWidth="1.6"
        strokeDasharray={DASH[state]}
        markerStart={both ? `url(#${id}-${state})` : undefined}
        markerEnd={both ? `url(#${id}-${state})` : undefined}
      />
    </svg>
  );
}

function useViewportSize(element: HTMLElement | null) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    if (!element) return;
    const read = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return size;
}

/**
 * The hub (this computer or this phone) between what drives it and what it drives, every line naming its route. Drag
 * to pan; ⌘-scroll or the zoom bar to zoom; Fit returns to the whole map, which it keeps until the person moves it.
 */
export function ComputerMap({
  hubName,
  hubKind,
  hubLabel,
  machines,
  empty,
}: {
  hubName: string;
  hubKind: MapMachineKind;
  hubLabel: string;
  machines: MapMachine[];
  empty?: string;
}) {
  const arrows = useId();
  const layout = useMemo(() => layoutMachineMap(machines), [machines]);
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const size = useViewportSize(viewport);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<{ zoom: number; pan: MapPoint } | null>(null);
  const fitted = useMemo(() => {
    if (!size) return null;
    const zoom = fitZoom(layout, size);
    return { zoom, pan: { x: (size.width - layout.width * zoom) / 2, y: (size.height - layout.height * zoom) / 2 } };
  }, [layout, size]);
  const shown = view ?? fitted;
  const zoomAt = useCallback(
    (next: number, point?: MapPoint) => {
      if (!shown || !size) return;
      const at = point ?? { x: size.width / 2, y: size.height / 2 };
      const scale = next / shown.zoom;
      setView({ zoom: next, pan: { x: at.x - (at.x - shown.pan.x) * scale, y: at.y - (at.y - shown.pan.y) * scale } });
    },
    [shown, size],
  );
  const drag = useRef<{ x: number; y: number; pan: MapPoint } | null>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !shown || (event.target as HTMLElement).closest("input,button")) return;
    drag.current = { x: event.clientX, y: event.clientY, pan: shown.pan };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || !shown) return;
    setView({ zoom: shown.zoom, pan: { x: start.pan.x + event.clientX - start.x, y: start.pan.y + event.clientY - start.y } });
  };
  const endDrag = () => {
    drag.current = null;
  };
  useEffect(() => {
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      const box = viewport.getBoundingClientRect();
      zoomAt(Math.min(MAP_ZOOM.max, Math.max(MAP_ZOOM.min, (shown?.zoom ?? 1) * Math.exp(-event.deltaY / 200))), {
        x: event.clientX - box.left,
        y: event.clientY - box.top,
      });
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [viewport, zoomAt, shown?.zoom]);
  const matching = useMemo(() => new Set(layout.machines.filter((machine) => matchesMachine(machine, query)).map((machine) => machine.id)), [layout, query]);
  const searching = query.trim().length > 0;
  return (
    <div
      ref={setViewport}
      data-computer-map
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className="relative h-[440px] cursor-grab touch-none overflow-hidden bg-canvas select-none active:cursor-grabbing"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 [background-size:20px_20px] [background-image:radial-gradient(var(--line-strong)_1px,transparent_1px)]"
        style={shown ? { backgroundPosition: `${shown.pan.x}px ${shown.pan.y}px`, backgroundSize: `${20 * shown.zoom}px ${20 * shown.zoom}px` } : undefined}
      />
      {shown && (
        <div
          role="list"
          aria-label="Computer map"
          className="absolute top-0 left-0 origin-top-left"
          style={{ width: layout.width, height: layout.height, transform: `translate(${shown.pan.x}px, ${shown.pan.y}px) scale(${shown.zoom})` }}
        >
          <svg aria-hidden width={layout.width} height={layout.height} className="absolute inset-0 overflow-visible">
            <Arrowheads id={arrows} />
            {layout.edges.map((edge) => (
              <path
                key={edge.id}
                data-map-edge={edge.id}
                d={edge.path}
                fill="none"
                stroke={STROKE[edge.state]}
                strokeWidth={edge.state === "active" ? 2 : 1.5}
                strokeDasharray={DASH[edge.state]}
                markerEnd={`url(#${arrows}-${edge.state})`}
                markerStart={edge.arrowStart ? `url(#${arrows}-${edge.state})` : undefined}
                className={`transition-opacity ${searching && !matching.has(edge.id) ? "opacity-30" : ""}`}
              />
            ))}
          </svg>
          {layout.edges.map((edge) => (
            <span
              key={edge.id}
              data-map-route={edge.id}
              style={{ left: edge.mid.x, top: edge.mid.y }}
              className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full bg-surface transition-opacity ${searching && !matching.has(edge.id) ? "opacity-30" : ""}`}
            >
              <span className={`flex h-5 items-center rounded-full px-2 text-11 font-medium whitespace-nowrap ${PILL[edge.state]}`}>{edge.label}</span>
            </span>
          ))}
          <div
            data-map-hub
            role="listitem"
            aria-label={`${hubName}, ${hubLabel}`}
            style={{ left: layout.hub.x, top: layout.hub.y, width: layout.hub.width, height: layout.hub.height }}
            className="absolute flex items-center gap-3 rounded-window bg-surface px-3 shadow-raised"
          >
            <MachineTile kind={hubKind} hub />
            <span className="grid min-w-0 gap-0.5">
              <span className="truncate text-13 font-medium text-ink">{hubName}</span>
              <span className="truncate text-11 text-ink-3">{hubLabel}</span>
            </span>
          </div>
          {layout.machines.map((machine) => (
            <MachineCard key={machine.id} machine={machine} dimmed={searching && !matching.has(machine.id)} />
          ))}
        </div>
      )}
      {machines.length > 0 ? (
        <label className="absolute top-3 left-3 flex h-8 w-56 items-center gap-2 rounded-control bg-surface px-2.5 text-ink-3 shadow-raised">
          <Icon icon={Search01Icon} size={14} />
          <input
            data-map-search
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.stopPropagation();
                setQuery("");
              }
            }}
            placeholder="Find a computer"
            aria-label="Find a computer"
            className="min-w-0 flex-1 bg-transparent text-12 text-ink outline-none placeholder:text-ink-3"
          />
        </label>
      ) : (
        empty && (
          <p data-map-empty className="absolute inset-x-0 bottom-16 text-center text-12 text-ink-3">
            {empty}
          </p>
        )
      )}
      <div
        data-map-legend
        className="absolute bottom-3 left-3 flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-control bg-surface px-3 py-2 text-11 text-ink-2 shadow-raised"
      >
        {LEGEND.map((item) => (
          <span key={item.state} className="flex items-center gap-1.5">
            <LegendLine state={item.state} />
            {item.label}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <LegendLine state="standby" both />
          Two-way
        </span>
      </div>
      <ZoomBar
        data-map-zoom
        className="absolute right-3 bottom-3"
        zoom={shown?.zoom ?? null}
        canZoomIn={(shown?.zoom ?? 1) < MAP_ZOOM.max}
        canZoomOut={(shown?.zoom ?? 1) > MAP_ZOOM.min}
        onZoomIn={() => shown && zoomAt(zoomStep(shown.zoom, 1))}
        onZoomOut={() => shown && zoomAt(zoomStep(shown.zoom, -1))}
        onReset={() => zoomAt(1)}
        onFit={() => setView(null)}
        fitLabel="Fit the map"
      />
    </div>
  );
}
