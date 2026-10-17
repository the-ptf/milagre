const { preparePrivateDirectory, assertPrivate } = require("@milagre/core/private-files");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const QRCode = require("qrcode");
const { startMobileBridge } = require("./mobile-bridge.cjs");
const { readCloudflare } = require("./mobile-cloudflare.cjs");
const { pairingLink, relayPairingLink, computerName } = require("./mobile-pairing.cjs");
const { startRelayHost } = require("./relay-host.cjs");
const { readIdentity, rotateIdentity, readRetired, readDraining, dropDraining } = require("./relay-identity.cjs");
const { createDevices } = require("./devices.cjs");
const { b64url } = require("@milagre/shared/relay-crypto");
const defaultTunnels = require("./mobile-tunnel.cjs");
const { startLanHost, LAN_PORT } = require("./lan-host.cjs");
const { lanAddresses } = require("./lan-addresses.cjs");

// Without a Cloudflare tunnel the bridge only answers on this Mac's loopback. 8797 is the port `mobile:cloudflare` also defaults to.
const LOCAL_PORT = 8797;
const RELAY_URL = "wss://relay.milagre.cloud";
// A phone that is not yet known may pair only for this long after the QR was shown, so a leaked link is not a standing invitation.
const PAIRING_WINDOW_MS = 10 * 60 * 1000;
// After a Reset, the old relay room keeps answering for this long, so a phone paired before hears "this Mac was reset".
const RETIRED_MS = 14 * 24 * 60 * 60 * 1000;
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
// After a Reset the old room may still hold webhook deliveries; the relay keeps one 24 h, so the Mac stops trying after this.
const DRAIN_MS = 25 * 60 * 60 * 1000;
const TOKEN = /^[a-f0-9]{64}$/;
const PHONE_KEY = /^[A-Za-z0-9_-]{43}$/;
// Computers waiting for Allow at once; more are turned away ("busy") so a leaked link can't flood the window's prompt.
const MAX_PENDING_COMPUTERS = 4;
const NOT_WAITING = "That computer is no longer waiting. Ask it to pair again.";
const message = (error) => (error instanceof Error ? error.message : String(error));

/**
 * The Phone setting, run by the daemon: the HTTP bridge and its tunnel, started and stopped on request. State lives in
 * `<dataDir>/mobile.json` ({ enabled, token, lan }, 0600). Transitions run one at a time. `setEnabled`, `reset` and `start`
 * return once the new state is saved and the change has begun (`status().state` is then 'starting' or 'off'); `settled()`
 * resolves when it has finished, and every change goes to `onChange`. A start that fails is an 'error' state, not a throw.
 * Without a Cloudflare tunnel the Mac reaches the phone through the public relay (`remote: 'relay'`). With one, phones
 * use the tunnel and the relay runs as well, since computers pair only through it: `pairingLink` is the tunnel's and
 * `computerLink` always the relay's. `status()` also carries the relay's `relay` state, `pairingUntil` (ms epoch), the
 * end of the window in which new devices may pair, and `pairedPhones`, how many phones have paired since the last Reset. `onPaired({ pairedPhones })` runs when a phone pairs
 * for the first time. `devices()` lists every paired device with the route it uses now, and `removeDevice(key)` forgets
 * one and closes its channels. A phone's pairing is kept for the desktop until one takes it with `takeDeviceNotices()`
 * (so a phone that paired while no desktop was open is still announced, once), and the phone is listed `isNew` until
 * `acknowledgeDevices(keys)` says the owner saw it. While the phone is on, identities a Reset replaced keep their old relay rooms for RETIRED_MS, only
 * to tell the phones that dial them that this Mac was reset.
 * Whatever the remote route, a running phone also listens on the local network (`lanPort`, unless `lan` is switched off
 * with `setLan` or the phone is confined): `status().lan` reports it, and a phone asks `routes` for the Mac's addresses.
 * A LAN port that cannot be bound never stops phone access; it shows up as `lan.error`.
 * `allowedRoot` confines a paired phone to one folder (see the bridge); the owner's app never sets it.
 * `openPeer` (server.cjs) opens a paired desktop's daemon connection; the relay and LAN hosts get it unless phone access
 * is confined, since a desktop drives the daemon directly, past the bridge's confinement. `peerRoutes()` tells a paired
 * desktop where to reach this Mac.
 * A computer's first pairing waits for its owner: `allowComputer` (handed to the relay host with `openPeer`) holds the
 * request until `allowDevice` or `denyDevice`, the end of the pairing window it arrived in, or its channel closing.
 * `onPending(requests)` hears the list of waiting `{ key, name, at }` after each change; `pendingDevices()` reads it.
 * `hooks` ({ ids, receive, refused, owners }, see relay-host.cjs) are the Mac's webhook Routines: the relay host carries
 * them whenever phone access is on, and while it is off a relay host runs for them alone as long as `ids()` has any. Call
 * `syncHooks()` when they change. A retiring room (after a Reset) lets go of its hooks and hands over what it still held.
 * A confined phone never takes webhooks.
 */
function createPhone({
  dataDir,
  tunnels = defaultTunnels,
  startBridge = startMobileBridge,
  relayUrl = RELAY_URL,
  startRelay = startRelayHost,
  now = Date.now,
  onChange = () => {},
  onPaired = () => {},
  onPending = () => {},
  localPort = LOCAL_PORT,
  retryDelaysMs = RETRY_DELAYS_MS,
  retiredMs = RETIRED_MS,
  name = computerName,
  allowedRoot,
  startLan = startLanHost,
  lanPort = LAN_PORT,
  lanHostname = "0.0.0.0",
  addresses = lanAddresses,
  openPeer,
  hooks,
}) {
  const file = path.join(dataDir, "mobile.json");
  let config; // { enabled, token | null, lan }, read once
  let state = "off";
  let error;
  let live; // { bridge, tunnel, relay, retired, lan, identity, phones, localUrl, publicUrl, remote, link, computerLink, qrSvg } while on
  let remote = "none";
  let relayStatus = "offline";
  let pairingUntil = 0;
  let pairingOpenedAt = 0;
  let relayPhones; // the devices store, one instance so a reset or removal changes what the running hosts see
  let generation = 0; // a bridge or retry from an earlier run must not touch this one
  let attempts = 0;
  let retryTimer;
  let lanError;
  // A confined phone (the review demo) never opens a door on the network.
  const lanAllowed = lanPort !== null && allowedRoot === undefined;
  // What the relay and LAN hosts get to serve paired desktops: nothing on a confined phone.
  const peer = openPeer && allowedRoot === undefined ? { openPeer, allowComputer } : {};
  // Webhooks reach only an unconfined Mac.
  const relayHooks = hooks && allowedRoot === undefined ? hooks : undefined;
  // A room a Reset retired registers no hooks (so the directory lets the new room have them) and still takes what it held.
  const retiringHooks = relayHooks && { ids: () => [], receive: (deliveries) => relayHooks.receive(deliveries), refused: () => {}, owners: () => ({}) };
  let hookHost = null; // the relay host for webhooks alone, while phone access is off
  // Old rooms a Reset left with webhook deliveries in them, each drained by a host of its own: hostId -> { host, timer }.
  // A room the phone already holds as retired (paired phones, phone on) drains through that host instead.
  const drains = new Map();
  // Nothing waits on a finish, and the daemon has no handler for a rejection nobody caught: it is logged, without any key.
  const drainHooks = (hostId) =>
    retiringHooks && {
      ...retiringHooks,
      drained: () => void finishDrain(hostId).catch((failure) => console.warn("[phone] couldn't finish draining an old relay room:", message(failure))),
    };
  const wantsHooks = () => {
    try {
      return Boolean(relayHooks) && relayHooks.ids().length > 0;
    } catch {
      return false;
    }
  };
  /** Computers waiting for Allow, by key, oldest first: { key, name, at, settle(verdict) }. */
  const pending = new Map();
  const pendingList = () => [...pending.values()].map(({ key, name, at }) => ({ key, name, at }));
  function pendingChanged() {
    try {
      onPending(pendingList());
    } catch {
      /* a listener must not break the setting */
    }
  }
  /**
   * Holds a computer's first hello (phone-channels.cjs) until its owner answers. It expires when the pairing window
   * open at its hello closes; its channel closing (`signal`) or a second hello from the same key drops it.
   */
  function allowComputer({ key, name = null, signal, waiting }) {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve("dropped");
      const left = pairingUntil - now();
      if (left <= 0) return resolve("expired");
      pending.get(key)?.settle("dropped");
      if (pending.size >= MAX_PENDING_COMPUTERS) return resolve("busy");
      const entry = { key, name, at: now(), settle };
      const timer = setTimeout(() => settle("expired"), left);
      const onAbort = () => settle("dropped");
      signal?.addEventListener("abort", onAbort, { once: true });
      function settle(verdict) {
        if (pending.get(key) !== entry) return;
        pending.delete(key);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        pendingChanged();
        resolve(verdict);
      }
      pending.set(key, entry);
      try {
        waiting?.();
      } catch {
        // It can't be told to wait (its channel is gone): it must not stay listed.
        settle("dropped");
        return;
      }
      pendingChanged();
    });
  }
  function answerPending(key, verdict) {
    const entry = pending.get(key);
    if (!entry) throw new Error(NOT_WAITING);
    entry.settle(verdict);
    return pendingList();
  }
  let queue = Promise.resolve();
  let closed = false;
  const enqueue = (work) => {
    const run = queue.then(work);
    queue = run.catch(() => {});
    return run;
  };

  function lanStatus(on) {
    const enabled = lanAllowed && config.lan !== false;
    return { enabled, addresses: enabled && on && live.lan ? addresses() : [], ...(enabled && lanError ? { error: lanError } : {}) };
  }

  function status() {
    const on = state === "on" && live;
    const current = live?.remote ?? remote;
    return {
      enabled: config?.enabled === true,
      state,
      ...(state === "error" ? { error } : {}),
      remote: current,
      ...(current !== "none" ? { relay: relayStatus, pairingUntil, pairedPhones: relayPhones?.count() ?? 0 } : {}),
      ...(config ? { lan: lanStatus(on) } : {}),
      ...(on
        ? {
            localUrl: live.localUrl,
            ...(live.publicUrl ? { publicUrl: live.publicUrl } : {}),
            pairingLink: live.link,
            computerLink: live.computerLink,
            qrSvg: live.qrSvg,
          }
        : {}),
    };
  }
  const changed = () => {
    try {
      onChange(status());
    } catch {
      /* a listener must not break the setting */
    }
  };
  function set(next, failure) {
    if (state === next && error === failure) return;
    state = next;
    error = failure;
    changed();
  }

  async function load() {
    if (config) return config;
    try {
      const value = JSON.parse(await fs.readFile(file, "utf8"));
      config = { enabled: value.enabled === true && TOKEN.test(value.token), token: TOKEN.test(value.token) ? value.token : null, lan: value.lan !== false };
    } catch {
      config = { enabled: false, token: null, lan: true };
    }
    return config;
  }
  async function save() {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    if (process.platform === "win32") preparePrivateDirectory(dataDir);
    const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ enabled: config.enabled, token: config.token, lan: config.lan }, null, 2), { flag: "wx", mode: 0o600 });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  const openPairing = () => {
    pairingOpenedAt = now();
    pairingUntil = pairingOpenedAt + PAIRING_WINDOW_MS;
  };

  /** The devices store, read once; each launch reads it again. */
  async function deviceStore() {
    if (!relayPhones) {
      relayPhones = createDevices(dataDir, { now });
      await relayPhones.load();
    }
    return relayPhones;
  }

  /**
   * Whether the device with `key` may pair now. Showing the QR opens the window, so a phone removed while Settings is
   * open would redial and pair again at once: a device removed since the window opened waits for the next one.
   */
  function mayPair(key) {
    if (now() >= pairingUntil) return false;
    const removedAt = relayPhones?.removedAt(key) ?? null;
    return removedAt === null || removedAt < pairingOpenedAt;
  }

  // The LAN host, tunnel and relay go first so none of them answers 502 from a bridge that is already gone.
  async function closeLive(old) {
    await old?.lan?.close().catch(() => {});
    await old?.tunnel?.close().catch(() => {});
    await old?.relay?.close().catch(() => {});
    await Promise.all(
      (old?.retired ?? []).map(({ host, timer }) => {
        clearTimeout(timer);
        return host.close().catch(() => {});
      }),
    );
    await old?.bridge?.close().catch(() => {});
  }

  /** The old rooms a Reset left behind, each held until it expires (see RETIRED_MS). */
  async function holdRetired(current) {
    const held = [];
    const draining = new Set((await readDraining(dataDir, now())).map((entry) => entry.hostId));
    for (const old of await readRetired(dataDir, now())) {
      // A reset that failed after saving the retired key may still use it: two hosts on one id would knock each other off.
      // Nor may a room a drain host already serves get a second one.
      if (old.hostId === current.hostId || drains.has(old.hostId)) continue;
      held.push(holdOne(old, draining.has(old.hostId)));
    }
    return held;
  }
  function holdOne(old, draining) {
    const host = startRelay({
      relayUrl,
      identity: { hostId: old.hostId, sign: old.sign },
      retired: true,
      ...(retiringHooks ? { hooks: draining ? drainHooks(old.hostId) : retiringHooks } : {}),
    });
    const timer = setTimeout(
      () => {
        void host.close().catch(() => {});
      },
      Math.min(old.until - now(), 2 ** 31 - 1),
    );
    timer.unref?.();
    return { host, timer, hostId: old.hostId };
  }

  /**
   * Starts a host for each old room still listed to drain (relay-identity.cjs readDraining) that nothing serves yet, and
   * stops those no longer listed. Runs whatever the phone setting, and with or without paired phones.
   */
  async function syncDrains() {
    if (!retiringHooks || closed) return;
    const listed = await readDraining(dataDir, now());
    const current = (await readIdentity(dataDir).catch(() => null))?.hostId;
    const heldAsRetired = new Set((live?.retired ?? []).map((entry) => entry.hostId));
    const wanted = new Map(listed.filter((entry) => entry.hostId !== current && !heldAsRetired.has(entry.hostId)).map((entry) => [entry.hostId, entry]));
    for (const [hostId, entry] of drains) {
      if (wanted.has(hostId)) continue;
      drains.delete(hostId);
      clearTimeout(entry.timer);
      await entry.host.close().catch(() => {});
    }
    for (const [hostId, entry] of wanted) {
      if (drains.has(hostId)) continue;
      const host = startRelay({ relayUrl, identity: { hostId, sign: entry.sign }, retired: true, hooks: drainHooks(hostId) });
      // Past the relay's retention there is nothing left to take: the host goes, and the identity with its signing key.
      const timer = setTimeout(
        () => {
          void enqueue(async () => {
            if (drains.get(hostId)?.host !== host) return;
            drains.delete(hostId);
            await host.close().catch(() => {});
            await dropDraining(dataDir, hostId);
          }).catch((failure) => console.warn("[phone] couldn't drop an old relay identity:", message(failure)));
        },
        Math.min(Math.max(entry.until - now(), 0), 2 ** 31 - 1),
      );
      timer.unref?.();
      drains.set(hostId, { host, timer });
    }
  }
  async function stopDrains() {
    for (const [hostId, entry] of [...drains]) {
      drains.delete(hostId);
      clearTimeout(entry.timer);
      await entry.host.close().catch(() => {});
    }
  }
  /**
   * The old room holds nothing more: its identity goes, and so does its host unless the phone holds the room for its phones.
   * All of it runs in the queue, so a Reset's rotateIdentity can't write the list between the drop's read and its write.
   */
  function finishDrain(hostId) {
    return enqueue(async () => {
      await dropDraining(dataDir, hostId);
      const entry = drains.get(hostId);
      if (!entry) return;
      drains.delete(hostId);
      clearTimeout(entry.timer);
      await entry.host.close().catch(() => {});
      const unwanted = () => !live || closed || live.retired?.some((held) => held.hostId === hostId);
      if (unwanted()) return;
      const old = (await readRetired(dataDir, now())).find((item) => item.hostId === hostId);
      // Asked again: a bridge that lost the daemon clears `live` outside the queue (restartLater), and the next launch
      // holds the room then.
      if (old && !unwanted()) live.retired.push(holdOne(old, false));
    });
  }

  /** With phone access off: the relay host for webhooks alone, started while any are wanted. */
  async function startHookHost() {
    if (hookHost || closed || !wantsHooks()) return;
    const identity = await readIdentity(dataDir);
    if (hookHost || closed) return;
    hookHost = startRelay({ relayUrl, identity, hooks: relayHooks, hooksOnly: true });
  }
  async function stopHookHost() {
    const host = hookHost;
    hookHost = null;
    await host?.close().catch(() => {});
  }

  async function teardown() {
    // Their channels close with the hosts; a request whose channel outlives this run must not be answerable.
    for (const entry of [...pending.values()]) entry.settle("dropped");
    generation++;
    clearTimeout(retryTimer);
    const old = live;
    live = undefined;
    relayStatus = "offline";
    await closeLive(old);
    await stopHookHost();
  }

  /** Listens on the local network for `current`. A port that is taken is reported in `lan.error`, never thrown. */
  async function startLanFor(current) {
    if (!lanAllowed || config.lan === false || current.lan) return;
    try {
      current.lan = await startLan({
        port: lanPort,
        hostname: lanHostname,
        identity: current.identity,
        phones: current.phones,
        token: config.token,
        bridgeUrl: current.bridge.url,
        ...peer,
      });
      lanError = undefined;
    } catch (failure) {
      lanError = message(failure);
    }
  }

  /**
   * Answers a phone that already reached this Mac over a route it trusts. Knowing the phone's key is what lets it finish a
   * hello on the LAN, so it is remembered here. That is not a new pairing, so nothing announces one.
   */
  async function routes(phoneKey) {
    if (typeof phoneKey !== "string" || !PHONE_KEY.test(phoneKey)) throw Object.assign(new Error("Expected this phone's key"), { status: 400 });
    const current = live;
    if (!current) throw Object.assign(new Error("Phone access is starting. Try again."), { status: 409 });
    if (!current.phones.isKnown(phoneKey) && relayPhones.removedAt(phoneKey) === null) await relayPhones.add(phoneKey);
    return routesOf(current);
  }

  /** Where a device finds this Mac: its relay identity and, while the LAN listener runs, its addresses. */
  function routesOf(current) {
    const port = current.lan?.port;
    return { hostId: current.identity.hostId, key: b64url(current.identity.box.publicKey), lan: port ? addresses().map((ip) => `ws://${ip}:${port}`) : [] };
  }

  async function cloudflareOrNull() {
    try {
      await fs.access(path.join(dataDir, "cloudflare.json"));
    } catch {
      return null;
    }
    return readCloudflare(dataDir);
  }

  // `retrying`: a failure waits and tries again (up to retryDelaysMs.length times) instead of ending in 'error'.
  async function launch({ retrying = false } = {}) {
    const mine = generation;
    set("starting");
    let bridge, tunnel, relay, retired;
    try {
      const cloudflare = await cloudflareOrNull();
      remote = cloudflare ? "cloudflare" : "relay";
      relayStatus = "connecting";
      bridge = await startBridge({
        dataDir,
        port: cloudflare ? cloudflare.port : localPort,
        token: config.token,
        phoneRoutes: (phoneKey) => routes(phoneKey),
        ...(allowedRoot ? { allowedRoot } : {}),
      });
      const identity = await readIdentity(dataDir);
      relayPhones ??= createDevices(dataDir, { now });
      await relayPhones.load();
      const known = relayPhones;
      const phones = {
        isKnown: (id) => known.isKnown(id),
        kindOf: (id) => known.kindOf(id),
        seen: (id, info) => known.seen(id, info),
        async add(id, info) {
          await known.add(id, info);
          // A pairing the old host saw while a reset tore it down is about to be forgotten: nothing to announce.
          if (mine !== generation) return;
          changed();
          try {
            onPaired({ pairedPhones: known.count(), kind: info?.kind ?? "phone" });
          } catch {
            /* a listener must not break the setting */
          }
        },
      };
      if (cloudflare) tunnel = await tunnels.startNamedTunnel({ hostname: cloudflare.hostname, connectorToken: cloudflare.connectorToken });
      // The relay runs behind a tunnel too: computers pair and connect only through it.
      relay = startRelay({
        relayUrl,
        identity,
        phones,
        token: config.token,
        bridgeUrl: bridge.url,
        canPair: (key) => mayPair(key),
        ...peer,
        ...(relayHooks ? { hooks: relayHooks } : {}),
        onStatus: (next) => {
          if (mine !== generation) return;
          relayStatus = next;
          changed();
        },
      });
      retired = await holdRetired(identity);
      const computerLink = relayPairingLink({
        relay: relayUrl,
        hostId: identity.hostId,
        key: b64url(identity.box.publicKey),
        token: config.token,
        name: name(),
      });
      // A phone scans the tunnel's link when there is one; a computer always gets the relay's.
      const link = cloudflare ? pairingLink({ address: tunnel.url || bridge.url, token: config.token, name: name(), access: cloudflare.access }) : computerLink;
      const publicUrl = tunnel?.url;
      const qrSvg = await QRCode.toString(link, { type: "svg", margin: 2, errorCorrectionLevel: "M" });
      live = { bridge, tunnel, relay, retired, identity, phones, localUrl: bridge.url, publicUrl, remote, link, computerLink, qrSvg };
      // Last, so a failure before it leaves no listener behind.
      await startLanFor(live);
      attempts = 0;
      void bridge.lost.then(() => {
        if (mine === generation) restartLater();
      });
      set("on");
    } catch (failure) {
      await closeLive({ tunnel, relay, retired, bridge });
      if (retrying && attempts < retryDelaysMs.length) restartLater();
      else set("error", message(failure));
    }
  }

  // A bridge that lost the daemon would leave the tunnel answering 502, so it is started again.
  function restartLater() {
    if (closed || !config?.enabled) return;
    const mine = ++generation;
    const delay = retryDelaysMs[attempts++];
    set("starting");
    const old = live;
    live = undefined;
    // Closing is queued so a new enable or disable cannot interleave with it.
    void enqueue(() => closeLive(old));
    retryTimer = setTimeout(() => {
      void enqueue(async () => {
        if (mine === generation && !closed && config.enabled) await launch({ retrying: true });
      });
    }, delay);
  }

  // Applies the saved setting: whatever runs is stopped, and a start follows if the phone is enabled.
  function apply() {
    return enqueue(async () => {
      await teardown();
      if (closed) return;
      if (config.enabled) await launch();
      else {
        set("off");
        await startHookHost();
      }
      await syncDrains();
    });
  }

  /** Every paired device, oldest first, with the route it is connected on now (the local network first), or null. */
  async function devices() {
    const store = await deviceStore();
    const lan = new Set(live?.lan?.connectedKeys?.() ?? []);
    const relay = new Set(live?.relay?.connectedKeys?.() ?? []);
    return store.list().map((device) => ({ ...device, route: lan.has(device.key) ? "lan" : relay.has(device.key) ? "relay" : null }));
  }

  return {
    status,
    routes,
    /** Asked by a paired desktop over its channel: it has no phone:routes, which the bridge answers. */
    peerRoutes() {
      if (!live) throw Object.assign(new Error("Phone access is starting. Try again."), { status: 409 });
      return routesOf(live);
    },
    settled: () => queue,
    devices,
    /** Computers waiting for Allow, oldest first. */
    pendingDevices: () => pendingList(),
    /** Lets a waiting computer pair; returns the ones still waiting. */
    allowDevice: (key) => answerPending(key, "allowed"),
    /** Turns a waiting computer away; returns the ones still waiting. */
    denyDevice: (key) => answerPending(key, "denied"),
    /** Phones whose pairing no desktop has announced yet and no window holds, claimed: `{ claim, devices }` (devices.cjs). */
    async takeDeviceNotices() {
      return (await deviceStore()).takeNotices();
    },
    /** The window showed what it took under `claim`; returns how many were announced. */
    async confirmDeviceNotices(claim) {
      if (typeof claim !== "string") throw new Error("Expected a notice claim");
      return (await deviceStore()).confirmNotices(claim);
    },
    /** The window that took `claim` is gone: what it held is offered again. */
    releaseDeviceNotices(claim) {
      relayPhones?.releaseNotices(claim);
    },
    /** The owner saw these devices in Settings › Devices, so they are no longer New. Returns the list. */
    async acknowledgeDevices(keys) {
      if (!Array.isArray(keys) || !keys.every((key) => typeof key === "string" && PHONE_KEY.test(key))) throw new Error("Expected device keys");
      await (await deviceStore()).acknowledge(keys);
      return devices();
    },
    /** Forgets a device and closes its channels on every carrier. It may pair again only in a pairing window opened later. */
    async removeDevice(key) {
      if (typeof key !== "string" || !PHONE_KEY.test(key)) throw new Error("Expected a device key");
      await enqueue(async () => {
        const store = await deviceStore();
        await store.remove(key);
        live?.relay?.drop?.(key);
        live?.lan?.drop?.(key);
        changed();
      });
      return devices();
    },
    async setEnabled(enabled) {
      if (typeof enabled !== "boolean") throw new Error("Expected enabled to be true or false");
      await enqueue(async () => {
        await load();
        if (enabled && config.enabled && state !== "error") return;
        config.enabled = enabled;
        if (enabled && !config.token) config.token = randomBytes(32).toString("hex");
        if (enabled) openPairing();
        await save();
        attempts = 0;
        if (enabled) set("starting");
        else set("off");
        void apply().catch(() => {});
      });
      return status();
    },
    /**
     * A new token: phones paired with the old one stop working and scan again. Whatever runs is stopped first, so the
     * old host can never see the new pairing window or re-add a phone after the list is cleared. Nothing here needs a
     * phone or the relay to answer. A failure part way leaves an enabled phone stopped in 'error'; with the phone off
     * it stays 'off' and the reset throws, so the caller hears it failed.
     */
    async reset() {
      await enqueue(async () => {
        await load();
        if (config.enabled) set("starting");
        await teardown();
        try {
          config.token = randomBytes(32).toString("hex");
          await save();
          await deviceStore();
          const hadPhones = relayPhones.count() > 0;
          // Phones paired through the relay are bound to the old token, so they go with it.
          await relayPhones.clear();
          // A new host id and key too: an old link can no longer reach this Mac. The old room stays held for a while,
          // only to tell the phones that paired there to scan the new code.
          // The old room may hold webhook deliveries the relay already accepted: keep its key to drain them.
          const drainOld = wantsHooks();
          await rotateIdentity(dataDir, {
            now: now(),
            ...(hadPhones ? { retireUntil: now() + retiredMs } : {}),
            ...(drainOld ? { drainUntil: now() + DRAIN_MS } : {}),
          });
          openPairing();
        } catch (failure) {
          if (config.enabled) {
            set("error", message(failure));
            return;
          }
          set("off");
          throw failure;
        }
        if (config.enabled) {
          attempts = 0;
          void apply().catch(() => {});
        } else {
          set("off");
          // Webhooks go on through the new identity's room, and the old one is drained.
          await startHookHost();
          await syncDrains();
        }
      });
      return status();
    },
    /** Turns the LAN listener on or off without touching the bridge, tunnel or relay. */
    async setLan(enabled) {
      if (typeof enabled !== "boolean") throw new Error("Expected enabled to be true or false");
      await enqueue(async () => {
        await load();
        if (config.lan !== enabled) {
          config.lan = enabled;
          await save();
        }
        if (live && !enabled) {
          const host = live.lan;
          live.lan = undefined;
          await host?.close().catch(() => {});
        } else if (live) await startLanFor(live);
        if (!enabled) lanError = undefined;
        changed();
      });
      return status();
    },
    /** Lets phones that are not yet known pair for another window. Settings calls it whenever it shows the QR. */
    async openPairing() {
      await enqueue(async () => {
        await load();
        if (config.enabled) {
          openPairing();
          changed();
        }
      });
      return status();
    },
    /** On daemon boot: starts the phone if it was left enabled. */
    async start() {
      await enqueue(async () => {
        await load();
        if (config.enabled && !closed) {
          set("starting");
          void apply().catch(() => {});
        } else {
          await startHookHost();
          await syncDrains();
        }
      });
      return status();
    },
    /**
     * The webhook set changed. A running relay host tells the relay now; with phone access off, the webhooks-only host
     * starts for the first webhook and, after telling the relay to let go, stops with the last.
     */
    syncHooks() {
      if (!relayHooks) return Promise.resolve();
      live?.relay?.syncHooks?.();
      hookHost?.syncHooks?.();
      return enqueue(async () => {
        await load();
        if (closed || config.enabled) return;
        if (!hookHost) await startHookHost();
        else if (!wantsHooks()) await stopHookHost();
      });
    },
    async close() {
      closed = true;
      await queue;
      await enqueue(async () => {
        await teardown();
        await stopDrains();
      });
    },
  };
}

module.exports = { createPhone, LOCAL_PORT, RELAY_URL, PAIRING_WINDOW_MS, RETIRED_MS };
