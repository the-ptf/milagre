export const PROBE_TIMEOUT: number;
export function connectDeviceRoutes<T>(options: {
  primary: string;
  direct?: string[];
  probe(endpoint: string): Promise<boolean>;
  connect(endpoint: string): Promise<T>;
  stopped?(): boolean;
  final?(error: unknown): boolean;
}): Promise<{ connection: T; endpoint: string }>;
/** An endpoint that answered its probe but would not open waits this long before it is tried again. */
export const HOLD_MS: number;
/** How a computer is reached on its local network: its relay id and box key, and its addresses there. */
export type LanRoute = {
  hostId: string;
  key: string;
  endpoints: string[];
  learnedAt: number;
};
/** What the supervisor needs of a LAN connection: whether it still works, and a way to close it. */
export type RouteTransport = { ready(): Promise<void>; close(): void };
export type ActiveRoute<T extends RouteTransport = RouteTransport> = { kind: "primary" } | { kind: "lan"; endpoint: string; transport: T };
export type RouteSupervisor<T extends RouteTransport = RouteTransport> = {
  current(): ActiveRoute<T>;
  /** Moves to the best route that works now: a LAN endpoint if one answers and opens, else the paired route. */
  check(): Promise<ActiveRoute<T>>;
  /** Closes the LAN socket and falls back to the paired route; the next check reopens it. */
  suspend(): void;
  subscribe(listener: (route: ActiveRoute<T>) => void): () => void;
  close(): void;
};
export type RouteSupervisorOptions<T extends RouteTransport = RouteTransport> = {
  lan: () => LanRoute | undefined;
  probe: (endpoint: string, hostId: string) => Promise<boolean>;
  openLan: (endpoint: string, lan: LanRoute, onLost: () => void) => Promise<T>;
  now?: () => number;
};
export function createRouteSupervisor<T extends RouteTransport>(options: RouteSupervisorOptions<T>): RouteSupervisor<T>;
