// Which way one computer is reached: its LAN endpoints when they work, its paired route (Cloudflare or the relay)
// otherwise. The phone (apps/mobile/src/routes-native.ts) and the desktop's computers (apps/desktop/electron/computers.cjs)
// both run it. Pure: probing, opening a LAN transport and the clock are passed in. Moved from apps/mobile/src/routes.ts.
export const PROBE_TIMEOUT = 2_500;
/** An endpoint that answered its probe but would not open waits this long before it is tried again. */
export const HOLD_MS = 5 * 60_000;
const PRIMARY = { kind: "primary" };

/** Try reachable private routes in advertised order, then the saved fallback. Only handshake failures may fall back. */
export async function connectDeviceRoutes({ primary, direct = [], probe, connect, stopped = () => false, final = () => false }) {
  const endpoints = [...new Set(direct)];
  const probes = endpoints.map((endpoint) =>
    Promise.resolve()
      .then(() => probe(endpoint))
      .catch(() => false),
  );
  let primaryFailure;
  for (const [index, endpoint] of endpoints.entries()) {
    if (!(await probes[index])) continue;
    if (stopped()) throw new Error("Connection cancelled");
    try {
      return { connection: await connect(endpoint), endpoint };
    } catch (error) {
      if (final(error) || stopped()) throw error;
      if (endpoint === primary) primaryFailure = error;
    }
  }
  if (stopped()) throw new Error("Connection cancelled");
  if (primaryFailure) throw primaryFailure;
  return { connection: await connect(primary), endpoint: primary };
}

/** A transport that fails to close must not stop the supervisor from moving on. */
function closeQuietly(transport) {
  try {
    transport.close();
  } catch {
    /* already going away */
  }
}

export function createRouteSupervisor({ lan, probe, openLan, now = Date.now }) {
  let active = PRIMARY;
  let walking = null;
  let closed = false;
  const held = new Map();
  const listeners = new Set();

  function set(next) {
    const previous = active;
    if (previous === next) return;
    active = next;
    // The copy is deliberate: a listener may (un)subscribe during notification, and a live Set would revisit it.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch {
        /* a listener must not stop the switch */
      }
    }
    if (previous.kind === "lan") closeQuietly(previous.transport);
  }

  /** Falls back to the paired route and, unless the supervisor is closed, tries the advertised endpoints again. */
  function lost() {
    set(PRIMARY);
    if (!closed) void supervisor.check().catch(() => {});
  }

  async function walk() {
    const route = lan();
    if (active.kind === "lan") {
      const current = active;
      const { endpoint } = current;
      const answered = route?.endpoints.includes(endpoint) && (await probe(endpoint, route.hostId).catch(() => false));
      if (closed) return active;
      // Demoted while probing (suspend or a lost socket): that transport is closed, and ready() would reopen it.
      // The endpoint did nothing wrong, so it is neither asked nor held; the walk below tries it like any other.
      if (active === current) {
        if (answered) {
          // A socket that answers its probe can still be dead: the supervisor only counts it once its hello has finished.
          const ready = await current.transport.ready().then(
            () => true,
            () => false,
          );
          if (closed) return active;
          // Demoted during ready() too: its failure is the demotion's doing, not the endpoint's.
          if (active === current) {
            if (ready) return active;
            held.set(endpoint, now() + HOLD_MS);
          }
        }
        if (active === current) set(PRIMARY);
      }
    }
    if (!route) return active;
    const candidates = route.endpoints.filter((endpoint) => (held.get(endpoint) ?? 0) <= now());
    const probes = candidates.map((endpoint) => probe(endpoint, route.hostId).catch(() => false));
    for (const [index, endpoint] of candidates.entries()) {
      if (!(await probes[index]) || closed) continue;
      let opened;
      try {
        opened = await openLan(endpoint, route, () => {
          // Only the transport that was opened for this callback can demote the route: a replaced one reports late.
          if (opened && active.kind === "lan" && active.transport === opened) lost();
        });
      } catch {
        held.set(endpoint, now() + HOLD_MS);
        continue;
      }
      if (closed) {
        closeQuietly(opened);
        return active;
      }
      set({ kind: "lan", endpoint, transport: opened });
      return active;
    }
    return active;
  }

  const supervisor = {
    current: () => active,
    check() {
      if (closed) return Promise.resolve(active);
      walking ??= walk().finally(() => {
        walking = null;
      });
      return walking;
    },
    suspend() {
      set(PRIMARY);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      listeners.clear();
      const previous = active;
      active = PRIMARY;
      if (previous.kind === "lan") closeQuietly(previous.transport);
    },
  };
  return supervisor;
}
