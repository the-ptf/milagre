/** How a line on the computer map is drawn: green in use, gray standby, dashed offline, red refused. */
export type MapLineState = "active" | "standby" | "offline" | "degraded";
export type MapMachineKind = "laptop" | "desktop" | "phone" | "tablet";
/** Who drives whom: `out` the hub drives the machine, `in` the machine drives the hub, `both` each drives the other. */
export type MapDirection = "out" | "in" | "both";

export type MapMachine = {
  id: string;
  name: string;
  kind: MapMachineKind;
  state: MapLineState;
  /** The pill on the machine's line: the route in use, or the one it would use. */
  route: string;
  detail: string;
  direction: MapDirection;
};

export type MapPoint = { x: number; y: number };
export type MapRect = MapPoint & { width: number; height: number };
export type PlacedMachine = MapMachine & { rect: MapRect; side: "left" | "right" };
export type MapEdge = {
  id: string;
  state: MapLineState;
  label: string;
  /** SVG path data, drawn in the direction the hub is driven or drives. */
  path: string;
  mid: MapPoint;
  arrowStart: boolean;
};
export type MachineMapLayout = { width: number; height: number; hub: MapRect; machines: PlacedMachine[]; edges: MapEdge[] };
export type MachineMapSizes = {
  hub: { width: number; height: number };
  card: { width: number; height: number };
  columnGap: number;
  rowGap: number;
  padding: number;
};

export const MAP_SIZES: MachineMapSizes = { hub: { width: 176, height: 64 }, card: { width: 240, height: 64 }, columnGap: 168, rowGap: 16, padding: 40 };

const TAILNET = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/;

export const isTailnetAddress = (address: string | null | undefined): boolean => !!address && TAILNET.test(address);

/** A route as the map names it: Tailscale for a tailnet address, LAN for any other private one, else the relay's host. */
export function routeName(route: "lan" | "relay" | null, { address, relayHost }: { address?: string | null; relayHost?: string | null }): string {
  if (route === "lan") return isTailnetAddress(address) ? "Tailscale" : "LAN";
  const host = (relayHost ?? "").replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "");
  return host || "Relay";
}

export function machineKindOf(name: string, { phone = false }: { phone?: boolean } = {}): MapMachineKind {
  if (/ipad|tablet/i.test(name)) return "tablet";
  if (phone || /iphone|pixel|galaxy|android/i.test(name)) return "phone";
  return /studio|mini|imac|desktop|tower/i.test(name) ? "desktop" : "laptop";
}

export const routeCount = (count: number) => (count === 1 ? "1 route" : `${count} routes`);

export function matchesMachine(machine: Pick<MapMachine, "name" | "route" | "detail">, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = `${machine.name} ${machine.route} ${machine.detail}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

/**
 * Folds a computer that drives the hub into the computer the hub drives under the same name, as one two-way machine.
 * Paired devices and driven computers have no shared id, so the name each one gives is the only join.
 */
export function mergeTwoWay(driven: MapMachine[], drivers: MapMachine[]): MapMachine[] {
  const byName = new Map(driven.map((machine) => [machine.name.trim().toLowerCase(), machine]));
  const joined = new Set<string>();
  const left = drivers.filter((driver) => {
    const match = driver.kind === "phone" || driver.kind === "tablet" ? undefined : byName.get(driver.name.trim().toLowerCase());
    if (!match || joined.has(match.id)) return true;
    joined.add(match.id);
    return false;
  });
  return [...driven.map((machine) => (joined.has(machine.id) ? { ...machine, direction: "both" as const } : machine)), ...left];
}

const ORDER: Record<MapLineState, number> = { active: 0, degraded: 1, standby: 2, offline: 3 };
const byState = (a: MapMachine, b: MapMachine) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name);

function curve(from: MapPoint, to: MapPoint): string {
  const bend = (to.x - from.x) / 2;
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
}

/** A point on `curve(from, to)` at `t`. */
export function curvePoint(from: MapPoint, to: MapPoint, t: number): MapPoint {
  const bend = (to.x - from.x) / 2;
  const u = 1 - t;
  const [a, b, c, d] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return { x: a * from.x + b * (from.x + bend) + c * (to.x - bend) + d * to.x, y: (a + b) * from.y + (c + d) * to.y };
}

/** Where the route pill sits along a line: past the fan-out at the hub, where neighbouring lines have spread apart. */
export const PILL_AT = 0.62;

/**
 * Places the hub between the machines that drive it (left) and the ones it drives (right), each column centred on the
 * hub, and joins them with curves whose midpoint carries the route pill. Without drivers the hub sits on the left.
 */
export function layoutMachineMap(machines: MapMachine[], sizes: MachineMapSizes = MAP_SIZES): MachineMapLayout {
  const { hub: hubSize, card, columnGap, rowGap, padding } = sizes;
  const leftColumn = machines.filter((machine) => machine.direction === "in").sort(byState);
  const rightColumn = machines.filter((machine) => machine.direction !== "in").sort(byState);
  const columnHeight = (count: number) => (count ? count * card.height + (count - 1) * rowGap : 0);
  const inner = Math.max(hubSize.height, columnHeight(leftColumn.length), columnHeight(rightColumn.length));
  const height = inner + padding * 2;
  const hubX = padding + (leftColumn.length ? card.width + columnGap : 0);
  const rightX = hubX + hubSize.width + columnGap;
  const width = (rightColumn.length ? rightX + card.width : hubX + hubSize.width) + padding;
  const hub = { x: hubX, y: padding + (inner - hubSize.height) / 2, width: hubSize.width, height: hubSize.height };
  const hubMid = hub.y + hub.height / 2;
  const place = (column: MapMachine[], x: number, side: "left" | "right"): PlacedMachine[] => {
    const top = padding + (inner - columnHeight(column.length)) / 2;
    return column.map((machine, index) => ({ ...machine, side, rect: { x, y: top + index * (card.height + rowGap), width: card.width, height: card.height } }));
  };
  const placed = [...place(leftColumn, padding, "left"), ...place(rightColumn, rightX, "right")];
  const edges = placed.map((machine): MapEdge => {
    const cardMid = machine.rect.y + machine.rect.height / 2;
    const [from, to] =
      machine.side === "left"
        ? [
            { x: machine.rect.x + machine.rect.width, y: cardMid },
            { x: hub.x, y: hubMid },
          ]
        : [
            { x: hub.x + hub.width, y: hubMid },
            { x: machine.rect.x, y: cardMid },
          ];
    return {
      id: machine.id,
      state: machine.state,
      label: machine.route,
      path: curve(from, to),
      mid: curvePoint(from, to, machine.side === "left" ? 1 - PILL_AT : PILL_AT),
      arrowStart: machine.direction === "both",
    };
  });
  return { width, height, hub, machines: placed, edges };
}

/** The zoom that fits the whole map in a viewport, never past 100%. */
export const fitZoom = (layout: Pick<MachineMapLayout, "width" | "height">, viewport: { width: number; height: number }, max = 1) =>
  Math.max(0.25, Math.min(max, viewport.width / layout.width, viewport.height / layout.height));

export const MAP_ZOOM = { min: 0.25, max: 2, step: 1.25 } as const;
export const zoomStep = (zoom: number, direction: 1 | -1) =>
  Math.min(MAP_ZOOM.max, Math.max(MAP_ZOOM.min, direction > 0 ? zoom * MAP_ZOOM.step : zoom / MAP_ZOOM.step));

export type MachineRowsSizes = { hubHeight: number; cardHeight: number; gutter: number; rowGap: number; padding: number; trunkInset: number; corner: number };
export const ROW_SIZES: MachineRowsSizes = { hubHeight: 56, cardHeight: 56, gutter: 172, rowGap: 12, padding: 12, trunkInset: 28, corner: 12 };

/**
 * The phone's map: the hub across the top and every machine in a row below it, each line dropping from a trunk under
 * the hub and turning into its card, with the route pill on the turn's straight part. Fits any width without zooming;
 * the upper rows' lines are listed last so they draw over the trunk they share.
 */
export function layoutMachineRows(machines: MapMachine[], width: number, sizes: MachineRowsSizes = ROW_SIZES): MachineMapLayout {
  const { hubHeight, cardHeight, gutter, rowGap, padding, trunkInset, corner } = sizes;
  const hub = { x: padding, y: padding, width: width - padding * 2, height: hubHeight };
  const trunkX = hub.x + trunkInset;
  const cardX = hub.x + gutter;
  const top = hub.y + hub.height + rowGap * 2;
  const placed = [...machines].sort(byState).map((machine, index): PlacedMachine => ({
    ...machine,
    side: "right",
    rect: { x: cardX, y: top + index * (cardHeight + rowGap), width: Math.max(cardHeight, width - padding - cardX), height: cardHeight },
  }));
  const edges = placed
    .map((machine): MapEdge => {
      const y = machine.rect.y + cardHeight / 2;
      return {
        id: machine.id,
        state: machine.state,
        label: machine.route,
        path: `M ${trunkX} ${hub.y + hub.height} L ${trunkX} ${y - corner} Q ${trunkX} ${y} ${trunkX + corner} ${y} L ${cardX} ${y}`,
        mid: { x: (trunkX + corner + cardX) / 2, y },
        arrowStart: machine.direction === "both",
      };
    })
    .toReversed();
  const bottom = placed.length ? placed.at(-1)!.rect.y + cardHeight : hub.y + hub.height;
  return { width, height: bottom + padding, hub, machines: placed, edges };
}
