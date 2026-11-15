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

function closeQuietly(transport) {
  try {
    transport.close();
  } catch {}
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
    // oxlint-disable-next-line unicorn/no-useless-spread -- a listener may (un)subscribe during notification; a live Set would revisit it.
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch {}
    }
    if (previous.kind === "lan") closeQuietly(previous.transport);
  }

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
      if (active === current) {
        if (answered) {
          const ready = await current.transport.ready().then(
            () => true,
            () => false,
          );
          if (closed) return active;
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
