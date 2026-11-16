const os = require("node:os");
const path = require("node:path");
const { randomBytes, randomUUID } = require("node:crypto");
const { helloName } = require("@milagre/shared/relay-crypto");
const { parsePairing, privateDeviceEndpoint } = require("@milagre/shared/pairing-link");
const { createRouteSupervisor, connectDeviceRoutes, PROBE_TIMEOUT } = require("@milagre/shared/route-supervisor");
const { computerName } = require("./mobile-pairing.cjs");
const { connectDesktopRuntime } = require("./runtime-client.cjs");
const { connectPeer, PeerError } = require("./peer-client.cjs");
const { computerProblem } = require("./computer-errors.cjs");
const { createComputersStore, lanRoutesFrom } = require("./computers-store.cjs");
const { createComputerKeys } = require("./computer-keys.cjs");
const { thisComputer } = require("@milagre/shared/host-computer");

const OFFLINE_AFTER_MS = 30_000;
const CHECK_EVERY_MS = 60_000;
const NETWORK_MS = 5_000;
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];
const OFFLINE_BACKOFF_MS = [60_000, 120_000, 300_000];
const SWITCH_WAIT_MS = 10_000;
const RECONNECT_WAIT_MS = 15_000;
const LAN_WAIT_MS = 500;
const SHOWN = new Set(["full", "outdated", "kind", "bad-hello", "busy"]);
const NOT_A_LINK = "That isn't a Milagre pairing link. Copy it from Settings › Phone & sharing on the other computer.";
const TUNNEL_LINK = "This link reaches its computer through a Cloudflare tunnel, which computers can't use yet.";

// A refusal retrying can't fix. A keychain that can't open this Mac's keys (an Error with code "keys", not a PeerError) is
// final only while adding: a computer already here keeps retrying, as the keychain may be unlocked or allowed later.
const isFinal = (error) => error instanceof PeerError && error.final;
const keychainProblem = (error) => (error?.code === "keys" && !(error instanceof PeerError) ? error.message : null);

const addressOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "") || null;
  } catch {
    return null;
  }
};
function atMost(promise, ms) {
  let timer;
  const waited = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise, waited]).finally(() => clearTimeout(timer));
}
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
const describe = (error) => (!error ? "" : error instanceof PeerError ? error.code : String(error.message ?? error).slice(0, 200));

const defaultNetworkSignature = () =>
  JSON.stringify(
    Object.values(os.networkInterfaces())
      .flat()
      .flatMap((address) => (address && !address.internal ? [address.address] : []))
      .toSorted(),
  );

function adopt(entry, client, route, endpoint = null) {
  entry.client = client;
  entry.route = route;
  entry.address = endpoint ? addressOf(endpoint) : null;
  client.once("close", () => {
    if (entry.client === client) entry.client = null;
  });
  return client;
}

function recovered(entry) {
  entry.recovery?.done();
  entry.recovery = null;
}

function released(entry) {
  // oxlint-disable-next-line unicorn/no-useless-spread
  for (const done of [...entry.waiting]) done();
}

function whenOnline(entry, ms) {
  return new Promise((/** @type {(value?: any) => void} */ resolve) => {
    const done = () => {
      clearTimeout(timer);
      entry.waiting.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    entry.waiting.add(done);
  });
}

function moveToLan(entry) {
  const client = entry.client;
  const route = entry.supervisor.current();
  if (!client || client !== entry.live || entry.route !== "relay" || route.kind !== "lan" || route.transport.used || route.transport.client.closed) return;
  client.closeWhenIdle(() => {
    entry.switching = true;
    if (!entry.recovery) {
      /** @type {(() => void) | undefined} */
      let resolve;
      const promise = /** @type {Promise<void>} */ (new Promise((settle) => (resolve = settle)));
      entry.recovery = { promise, done: () => resolve?.() };
    }
  });
}

async function stop(entry) {
  entry.stopped = true;
  entry.abort.abort();
  recovered(entry);
  released(entry);
  clearTimeout(entry.retryTimer);
  clearTimeout(entry.offlineTimer);
  const runtime = entry.runtime;
  entry.runtime = null;
  await entry.starting?.catch(() => {});
  await runtime?.close().catch(() => {});
  entry.supervisor.close();
  entry.client?.close();
}

/**
 * The other Macs this desktop drives (spec "This Mac (Electron main) › Computers"). Each saved computer, while
 * `setEnabled(true)` (Settings › Phone & sharing › Other computers), gets one runtime (daemon-runtime.cjs) whose connections
 * are paired-desktop channels (peer-client.cjs) on the route the shared supervisor picks: a LAN address the computer
 * gave (peer:routes) when it answers, the relay otherwise; checked on every connect, every 60 s and when this Mac's
 * network changes. A refusal retrying can't fix (removed, reset, denied) stops it until it is paired again.
 * @param {{
 *   dataDir: string; safeStorage?: any; credentials?: any; name?: () => string; onChange?: (computers: any[]) => void;
 *   emit?: (id: string, channel: string, payload: unknown) => void; ownHostId?: () => Promise<string | null>;
 *   allowLocalRelay?: boolean; createSocket?: (url: string) => any; fetch?: typeof globalThis.fetch;
 *   now?: () => number; random?: (n: number) => Uint8Array; reconnectMs?: number; switchWaitMs?: number;
 *   offlineAfterMs?: number; checkEveryMs?: number; networkMs?: number; backoffMs?: number[]; offlineBackoffMs?: number[];
 *   lanWaitMs?: number;
 *   networkSignature?: () => string; reconnectWaitMs?: number; log?: (line: string) => void; acceptStream?: (target: string, port: number) => import("node:net").Socket;
 * }} options
 */
function createComputers({
  dataDir,
  safeStorage,
  credentials,
  name = computerName,
  onChange = () => {},
  emit = () => {},
  ownHostId = async () => null,
  allowLocalRelay = false,
  createSocket,
  fetch = globalThis.fetch,
  now = Date.now,
  random = (n) => new Uint8Array(randomBytes(n)),
  reconnectMs = 3000,
  switchWaitMs = SWITCH_WAIT_MS,
  offlineAfterMs = OFFLINE_AFTER_MS,
  checkEveryMs = CHECK_EVERY_MS,
  networkMs = NETWORK_MS,
  backoffMs = BACKOFF_MS,
  offlineBackoffMs = OFFLINE_BACKOFF_MS,
  lanWaitMs = LAN_WAIT_MS,
  networkSignature = defaultNetworkSignature,
  reconnectWaitMs = RECONNECT_WAIT_MS,
  log = () => {},
  acceptStream,
}) {
  const store = createComputersStore({ file: path.join(dataDir, "computers.json"), now, allowLocalRelay });
  const keys = credentials ?? createComputerKeys({ file: path.join(dataDir, "computer-keys.json"), safeStorage, random });
  const ready = store.load();
  const entries = new Map();
  const pairingEndpoints = new WeakMap();
  let enabled = false;
  let closed = false;
  let focused = false;
  /** @type {AbortController | null} */
  let adding = null;
  let checkTimer = null;
  let networkTimer = null;
  const socketOption = { ...(createSocket ? { createSocket } : {}), ...(acceptStream ? { acceptStream } : {}) };

  function view(computer) {
    const entry = entries.get(computer.id);
    const state = enabled ? (entry?.state ?? "connecting") : "off";
    return {
      id: computer.id,
      name: computer.name,
      hostId: computer.hostId,
      relayHost: hostOf(computer.relay),
      state,
      route: state === "online" ? (entry?.route ?? null) : null,
      address: state === "online" && entry?.route === "lan" ? (entry.address ?? null) : null,
      lastSeen: computer.lastSeen,
      message: enabled ? (entry?.message ?? null) : null,
      lan: computer.lanRoutes.length > 0,
      lanRoutes: [...computer.lanRoutes],
      addedAt: computer.addedAt,
    };
  }
  const list = () => store.list().map(view);
  function changed() {
    try {
      onChange(list());
    } catch {}
  }
  void ready.then(changed, () => {});

  async function probe(endpoint, hostId) {
    try {
      const response = await fetch(`${endpoint.replace(/^ws:/, "http:")}/v1/hello`, { signal: AbortSignal.timeout(PROBE_TIMEOUT) });
      if (!response.ok) return false;
      const body = await response.json();
      return body?.v === 1 && body.hostId === hostId;
    } catch {
      return false;
    }
  }

  async function dial(entry, url) {
    const computer = store.get(entry.id);
    if (!computer || !entry.secrets) throw new PeerError("keys");
    return connectPeer({
      url,
      hostId: computer.hostId,
      hostKey: entry.secrets.hostKey,
      token: entry.secrets.token,
      identity: await keys.identity(),
      name: name(),
      random,
      signal: entry.abort.signal,
      ...socketOption,
    });
  }

  async function openLan(entry, endpoint, onLost) {
    const client = await dial(entry, endpoint);
    client.once("close", onLost);
    return {
      client,
      used: false,
      ready: async () => {
        if (client.closed) throw new Error("The LAN connection closed");
      },
      close: () => client.close(),
    };
  }

  function entryFor(id) {
    const found = entries.get(id);
    if (found) return found;
    const entry = {
      id,
      /** @type {any} */
      runtime: null,
      /** @type {any} */
      client: null,
      /** @type {any} */
      live: null,
      route: null,
      /** @type {string | null} */
      address: null,
      state: "connecting",
      message: null,
      lastError: null,
      /** @type {{ hostKey: string; token: string } | null} */
      secrets: null,
      /** @type {Promise<any> | null | undefined} */
      starting: null,
      retryTimer: null,
      offlineTimer: null,
      /** @type {(() => void) | null} */
      wake: null,
      attempts: 0,
      failures: 0,
      refused: false,
      stopped: false,
      switching: false,
      /** @type {{ promise: Promise<void>; done: () => void } | null} */
      recovery: null,
      waiting: new Set(),
      abort: new AbortController(),
    };
    const supervisor = createRouteSupervisor({
      lan: () => {
        const computer = store.get(id);
        if (!computer?.lanRoutes.length || !entry.secrets) return undefined;
        return { hostId: computer.hostId, key: entry.secrets.hostKey, endpoints: computer.lanRoutes, learnedAt: 0 };
      },
      probe,
      openLan: (endpoint, _lan, onLost) => openLan(entry, endpoint, onLost),
      now,
    });
    entry.supervisor = supervisor;
    supervisor.subscribe((route) => {
      const client = entry.client;
      if (!client || entry.route !== "relay") return;
      if (route.kind !== "lan") {
        client.keepOpen?.();
        return;
      }
      moveToLan(entry);
    });
    entries.set(id, entry);
    return entry;
  }

  function redialWait(n, error) {
    if (n < backoffMs.length || !(error instanceof PeerError && error.code === "offline")) return backoffMs[Math.min(n, backoffMs.length - 1)];
    return offlineBackoffMs[Math.min(n - backoffMs.length, offlineBackoffMs.length - 1)];
  }

  function backoff(entry) {
    const wait = redialWait(entry.failures - 1, entry.lastError);
    const { signal } = entry.abort;
    return new Promise((/** @type {(value?: any) => void} */ resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (entry.wake === finish) entry.wake = null;
      };
      const onAbort = () => {
        finish();
        reject(new Error("This computer is no longer connected."));
      };
      const timer = setTimeout(() => {
        finish();
        resolve();
      }, wait);
      entry.wake = () => {
        finish();
        resolve();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async function connectRoute(entry) {
    if (entry.stopped || entry.refused) throw new Error("This computer is no longer connected.");
    await atMost(
      entry.supervisor.check().catch(() => {}),
      lanWaitMs,
    );
    const route = entry.supervisor.current();
    if (route.kind === "lan" && !route.transport.used && !route.transport.client.closed) {
      route.transport.used = true;
      return adopt(entry, route.transport.client, "lan", route.endpoint);
    }
    const computer = store.get(entry.id);
    if (!computer) throw new Error("This computer was removed.");
    if (entry.runtime) {
      if (entry.failures > 0) await backoff(entry);
      entry.failures++;
    }
    try {
      return adopt(entry, await dial(entry, computer.relay), "relay");
    } catch (error) {
      entry.switching = false;
      if (isFinal(error)) refuse(entry, error);
      else entry.lastError = error;
      throw error;
    }
  }

  function note(entry, state, detail) {
    try {
      const computer = store.get(entry.id);
      log(`${new Date(now()).toISOString()} ${computer?.name ?? entry.id} ${state}${detail ? ` ${detail}` : ""}`);
    } catch {}
  }

  function online(entry) {
    clearTimeout(entry.offlineTimer);
    if (entry.state !== "online") note(entry, "online", `${entry.route ?? ""}${entry.address ? ` ${entry.address}` : ""}`.trim());
    entry.state = "online";
    entry.live = entry.client;
    entry.message = null;
    entry.lastError = null;
    entry.failures = 0;
    entry.switching = false;
    recovered(entry);
    released(entry);
    void store.seen(entry.id).catch(() => {});
    void learnRoutes(entry);
    changed();
    moveToLan(entry);
  }

  function down(entry, error, why = "") {
    if (entry.switching) {
      entry.switching = false;
      return;
    }
    recovered(entry);
    const computer = store.get(entry.id);
    entry.message =
      error instanceof PeerError && SHOWN.has(error.code) && computer ? computerProblem(error.code, { name: computer.name }) : keychainProblem(error);
    if (entry.state !== "reconnecting" && entry.state !== "offline") {
      note(entry, "reconnecting", `from ${entry.route ?? "no route"}: ${describe(error) || why || "unknown"}`);
      entry.state = "reconnecting";
      clearTimeout(entry.offlineTimer);
      entry.offlineTimer = setTimeout(() => {
        if (entry.state !== "reconnecting") return;
        note(entry, "offline", describe(entry.lastError));
        entry.state = "offline";
        released(entry);
        changed();
      }, offlineAfterMs);
    }
    changed();
  }

  function refuse(entry, error) {
    if (entry.refused) return;
    const computer = store.get(entry.id);
    entry.refused = true;
    entry.switching = false;
    recovered(entry);
    released(entry);
    note(entry, "refused", describe(error));
    entry.state = "refused";
    entry.message = computerProblem(error.code, { name: computer?.name ?? "That computer" });
    clearTimeout(entry.offlineTimer);
    clearTimeout(entry.retryTimer);
    const runtime = entry.runtime;
    entry.runtime = null;
    void runtime?.close().catch(() => {});
    entry.supervisor.close();
    changed();
  }

  async function learnRoutes(entry) {
    const runtime = entry.runtime;
    const computer = store.get(entry.id);
    if (!runtime || !computer || !entry.secrets) return;
    let answer;
    try {
      answer = await runtime.invoke("peer:routes");
    } catch {
      return;
    }
    const routes = lanRoutesFrom(answer, { hostId: computer.hostId, hostKey: entry.secrets.hostKey, allowLocalRelay });
    if (!routes || entry.stopped) return;
    await store.setLanRoutes(entry.id, routes).catch(() => {});
    changed();
    void entry.supervisor.check().catch(() => {});
  }

  function runtimeEvent(entry, channel, payload) {
    if (entry.stopped || entry.refused) return;
    if (channel === "runtime:connection") {
      if (payload?.connected) online(entry);
      else down(entry, entry.lastError, typeof payload?.message === "string" ? payload.message : "");
      return;
    }
    try {
      emit(entry.id, channel, payload);
    } catch {}
  }

  function start(entry, first = /** @type {any} */ (null)) {
    if (!enabled || closed || entry.stopped || entry.refused || entry.runtime || entry.starting) {
      first?.close();
      return entry.starting;
    }
    clearTimeout(entry.retryTimer);
    entry.wake = null;
    let handed = first;
    entry.starting = (async () => {
      try {
        entry.secrets ??= await keys.secretsOf(entry.id);
        const runtime = await connectDesktopRuntime({
          dataDir,
          reconnectMs,
          connect: () => {
            if (!handed) return connectRoute(entry);
            const client = handed;
            handed = null;
            const endpoint = pairingEndpoints.get(client);
            const direct = endpoint && privateDeviceEndpoint(endpoint, { allowLocalRelay });
            return Promise.resolve(adopt(entry, client, direct ? "lan" : "relay", direct ? endpoint : null));
          },
          emit: (channel, payload) => runtimeEvent(entry, channel, payload),
        });
        if (!enabled || closed || entry.stopped || entry.refused) {
          await runtime.close().catch(() => {});
          return;
        }
        entry.runtime = runtime;
        entry.attempts = 0;
        if (focused) void runtime.setFocused(true).catch(() => {});
        online(entry);
      } catch (error) {
        handed?.close();
        if (!entry.runtime) entry.client?.close();
        if (!enabled || closed || entry.stopped || entry.refused) return;
        if (isFinal(error)) {
          refuse(entry, error);
          return;
        }
        down(entry, error);
        const wait = redialWait(entry.attempts++, error);
        entry.retryTimer = setTimeout(() => void start(entry), wait);
        entry.wake = () => {
          entry.wake = null;
          void start(entry);
        };
      } finally {
        entry.starting = null;
      }
    })();
    return entry.starting;
  }

  async function redialFor(entry) {
    if (entry.state === "offline" && entry.wake) {
      entry.wake();
      await whenOnline(entry, reconnectWaitMs);
    } else if (entry.state === "connecting" || entry.state === "reconnecting") await whenOnline(entry, reconnectWaitMs);
  }

  function checkRoutes() {
    for (const entry of entries.values()) if (!entry.stopped && !entry.refused) void entry.supervisor.check().catch(() => {});
  }
  function watch() {
    let network = networkSignature();
    checkTimer = setInterval(checkRoutes, checkEveryMs);
    networkTimer = setInterval(() => {
      const next = networkSignature();
      if (next === network) return;
      network = next;
      checkRoutes();
    }, networkMs);
    checkTimer.unref?.();
    networkTimer.unref?.();
  }
  function unwatch() {
    clearInterval(checkTimer);
    clearInterval(networkTimer);
    checkTimer = null;
    networkTimer = null;
  }

  async function read(link) {
    let pairing;
    try {
      pairing = parsePairing(String(link ?? ""), { allowLocalRelay });
    } catch {
      throw new Error(NOT_A_LINK);
    }
    const relay = pairing.relay;
    if (!relay) throw new Error(TUNNEL_LINK);
    let own = null;
    try {
      own = await ownHostId();
    } catch {}
    if (relay.hostId === own) throw new Error(`That's ${thisComputer}'s own link. Copy the one on the other computer.`);
    const existing = store.list().find((computer) => computer.hostId === relay.hostId);
    if (existing && !entries.get(existing.id)?.refused) throw new Error(`${existing.name} is already in your computers.`);
    return { pairing, relay, replaces: existing?.id ?? null };
  }

  async function removeComputer(id) {
    const entry = entries.get(id);
    entries.delete(id);
    if (entry) await stop(entry);
    await store.remove(id);
    await keys.forget(id).catch(() => {});
  }

  return {
    loaded: ready.then(() => undefined),
    list,
    async preview(link) {
      await ready;
      const { pairing, relay } = await read(link);
      return { name: pairing.name, hostId: relay.hostId, relayHost: hostOf(relay.url) };
    },
    /**
     * @param {string} link
     * @param {{ name?: string }} [options]
     * @param {{ onPending?: () => void }} [hooks]
     */
    async add(link, { name: label } = {}, { onPending } = {}) {
      await ready;
      if (closed) throw new Error("Milagre is quitting.");
      if (adding) throw new Error("Another computer is being added.");
      const abort = new AbortController();
      adding = abort;
      try {
        const { pairing, relay, replaces } = await read(link);
        const shown = helloName(label) ?? helloName(pairing.name) ?? "Computer";
        let client;
        try {
          const identity = await keys.identity();
          const selected = await connectDeviceRoutes({
            primary: relay.url,
            direct: relay.direct,
            probe: (endpoint) => probe(endpoint, relay.hostId),
            stopped: () => abort.signal.aborted,
            final: isFinal,
            connect: (url) =>
              connectPeer({
                url,
                hostId: relay.hostId,
                hostKey: relay.key,
                token: pairing.token,
                identity,
                name: name(),
                random,
                onPending,
                signal: abort.signal,
                ...socketOption,
              }),
          });
          client = selected.connection;
          pairingEndpoints.set(client, selected.endpoint);
        } catch (error) {
          const failure = /** @type {any} */ (error);
          const code = error instanceof PeerError ? error.code : (failure?.code ?? "lost");
          // A keychain failure is worded by the keys module; a refusal by what the computer said.
          const words =
            code === "cancelled" ? "Cancelled." : error instanceof PeerError ? computerProblem(code, { name: pairing.name, pairing: true }) : failure.message;
          throw Object.assign(new Error(words), { code });
        }
        if (replaces) await removeComputer(replaces);
        const id = randomUUID();
        try {
          await keys.save(id, { hostKey: relay.key, token: pairing.token });
          const direct = [...new Set([...(relay.direct ?? []), ...(privateDeviceEndpoint(relay.url, { allowLocalRelay }) ? [relay.url] : [])])];
          await store.add({
            id,
            hostId: relay.hostId,
            name: shown,
            relay: relay.url,
            lanRoutes: direct,
          });
        } catch (error) {
          client.close();
          await keys.forget(id).catch(() => {});
          throw error;
        }
        if (enabled) {
          const entry = entryFor(id);
          entry.secrets = { hostKey: relay.key, token: pairing.token };
          void start(entry, client);
        } else client.close();
        changed();
        return view(store.get(id));
      } finally {
        if (adding === abort) adding = null;
      }
    },
    cancelAdd() {
      adding?.abort();
    },
    async rename(id, label) {
      await ready;
      await store.rename(id, label);
      changed();
      return list();
    },
    async remove(id) {
      await ready;
      await removeComputer(id);
      changed();
      return list();
    },
    async invoke(id, method, args = []) {
      const entry = entries.get(id);
      if (entry?.recovery) {
        let timer;
        await Promise.race([entry.recovery.promise, new Promise((resolve) => (timer = setTimeout(resolve, switchWaitMs)))]);
        clearTimeout(timer);
      }
      if (entry) await redialFor(entry);
      if (!entry?.runtime || entry.state !== "online") throw new Error(`${store.get(id)?.name ?? "That computer"} is offline.`);
      return entry.runtime.invoke(method, args);
    },
    async openStream(id, target, port) {
      const entry = entries.get(id);
      if (entry) await redialFor(entry);
      if (!entry?.runtime || entry.state !== "online")
        throw Object.assign(new Error(`${store.get(id)?.name ?? "That computer"} is offline.`), { code: "offline" });
      return entry.runtime.openStream(target, port);
    },
    setFocused(value) {
      if (focused === (value === true)) return;
      focused = value === true;
      for (const entry of entries.values()) void entry.runtime?.setFocused(focused).catch(() => {});
    },
    async setEnabled(on) {
      await ready;
      if (closed || enabled === (on === true)) return;
      enabled = on === true;
      if (enabled) {
        for (const computer of store.list()) void start(entryFor(computer.id));
        watch();
      } else {
        unwatch();
        adding?.abort();
        const stopping = [...entries.values()];
        entries.clear();
        await Promise.all(stopping.map(stop));
      }
      changed();
    },
    async close() {
      if (closed) return;
      closed = true;
      adding?.abort();
      unwatch();
      const stopping = [...entries.values()];
      entries.clear();
      await Promise.all(stopping.map(stop));
    },
  };
}

module.exports = { createComputers };
