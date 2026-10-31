const path = require("node:path");
const fs = require("node:fs/promises");
const { createComputers } = require("./computers.cjs");
const { createBrowserProxies } = require("./browser-proxy.cjs");
const { createComputerVault } = require("./computer-vault.cjs");
const { createComputerCaches } = require("./computer-cache.cjs");
const { registerComputers } = require("./computers-ipc.cjs");
const { computerName } = require("./mobile-pairing.cjs");
const { readOwnHostId } = require("./own-host.cjs");
const { writePrivate } = require("./relay-identity.cjs");

/** Runs a listener of the computers; one that throws must not break them. */
function hear(listener) {
  try {
    listener();
  } catch {
    /* a listener must not break the computers */
  }
}

/**
 * One manager and cache per owning daemon. Both native IPC and the CLI call these handlers. `onRemoteEvent(id, channel,
 * payload)` hears each computer's events as it sent them (unqualified), `onOnline(id)` each computer coming online, and
 * `onRemoved(id)` each one the user removed: this daemon's own Delegations to other computers follow them (spec 2026-10-23).
 */
function createComputerService({ dataDir, emit = () => {}, onRemoteEvent = () => {}, onOnline = () => {}, onRemoved = () => {}, ...options }) {
  const handlers = new Map();
  const vault = createComputerVault({ dataDir });
  const cache = createComputerCaches({ dir: path.join(dataDir, "computers") });
  const settingsFile = path.join(dataDir, "computer-settings.json");
  let enabled = false;
  let controls = Promise.resolve();
  const control = (change) => {
    const next = controls.then(change);
    controls = next.catch(() => {});
    return next;
  };
  let ipc;
  // Each computer's last state, so onOnline fires once per return.
  const states = new Map();
  const computers = createComputers({
    dataDir,
    credentials: vault,
    ownHostId: () => readOwnHostId(dataDir),
    // Each computer's state changes land in daemon.log: a blip leaves no trace on screen once it is over.
    log: (line) => console.log(`computers: ${line}`),
    ...options,
    onChange: (list) => {
      ipc?.changed();
      for (const computer of list ?? []) {
        const was = states.get(computer.id);
        states.set(computer.id, computer.state);
        if (computer.state === "online" && was !== "online") hear(() => onOnline(computer.id));
      }
    },
    emit: (id, channel, payload) => {
      hear(() => onRemoteEvent(id, channel, payload));
      ipc?.event(id, channel, payload);
    },
  });
  ipc = registerComputers({
    ipcMain: { handle: (method, handler) => handlers.set(method, handler) },
    computers,
    cache,
    thisMac: computerName,
    send: (channel, payload) => emit(channel, channel === "computers:changed" ? { ...payload, enabled } : payload),
    onForget: (id) => emit("computers:forgotten", { computerId: id }),
  });
  const ready = (async () => {
    await computers.loaded;
    try {
      const saved = JSON.parse(await fs.readFile(settingsFile, "utf8"));
      enabled = saved.enabled === true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await computers.setEnabled(enabled);
  })();
  // Startup failures remain observable through calls; they never become unhandled rejections.
  void ready.catch(() => {});
  // A remote Chat's Browser pages reach the web from its computer through this proxy (browser-proxy.cjs, #832). Desktop
  // main points the page's session at it. computers:* is this Mac's own: a paired desktop is never let in (peer-policy).
  const proxies = createBrowserProxies({ openStream: (id, target, port) => computers.openStream(id, target, port), log: (line) => console.log(line) });
  handlers.set("computers:browser-proxy", async (_context, computerId) => {
    if (typeof computerId !== "string" || !computers.list().some((computer) => computer.id === computerId)) throw new Error("Unknown computer.");
    return { port: await proxies.port(computerId) };
  });
  handlers.set("computers:vault-status", () => vault.status());
  handlers.set("computers:unlock", (_context, { key } = {}) => vault.unlock(key));
  handlers.set("computers:setup-key", (_context, { file } = {}) =>
    control(async () => {
      const result = await vault.setupKey(file);
      if (enabled) {
        await computers.setEnabled(false);
        await computers.setEnabled(true);
      }
      return result;
    }),
  );
  handlers.set("computers:import-keys", (_context, value) => vault.importLegacy(value));
  const remove = handlers.get("computers:remove");
  handlers.set("computers:remove", async (context, id) => {
    void proxies.drop(id);
    const result = await remove(context, id);
    states.delete(String(id));
    hear(() => onRemoved(String(id)));
    return result;
  });
  const setEnabled = handlers.get("computers:set-enabled");
  handlers.set("computers:set-enabled", (context, on) =>
    control(async () => {
      if (typeof on !== "boolean") throw new Error("Expected enabled boolean");
      await writePrivate(settingsFile, { enabled: on });
      enabled = on;
      return setEnabled(context, on);
    }),
  );
  return {
    methods: Object.freeze([...handlers.keys()]),
    async invoke(method, args, context = {}) {
      await ready;
      const handler = handlers.get(method);
      if (!handler) throw new Error(`Unknown computer command: ${method}`);
      const sender = { isDestroyed: () => false, send: (channel, payload) => (context.send ?? emit)(channel, payload) };
      const result = await handler({ sender }, ...args);
      if (method === "computers:list") return { ...result, enabled };
      return result;
    },
    setFocused: (value) => computers.setFocused(value),
    /** The paired computers as this daemon's own code reaches them: raw calls, no offline copy, no qualified keys. */
    remote: {
      list: () => (enabled ? computers.list().map((computer) => ({ id: computer.id, name: computer.name, online: computer.state === "online" })) : []),
      invoke: (id, method, args) => computers.invoke(id, method, args),
    },
    async close() {
      await ready.catch(() => {});
      await controls;
      await proxies.close();
      await computers.close();
      cache.close();
    },
  };
}

module.exports = { createComputerService };
