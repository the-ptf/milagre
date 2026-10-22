const path = require("node:path");
const fs = require("node:fs/promises");
const { createComputers } = require("./computers.cjs");
const { createComputerVault } = require("./computer-vault.cjs");
const { createComputerCaches } = require("./computer-cache.cjs");
const { registerComputers } = require("./computers-ipc.cjs");
const { computerName } = require("./mobile-pairing.cjs");
const { readOwnHostId } = require("./own-host.cjs");
const { writePrivate } = require("./relay-identity.cjs");

/** One manager and cache per owning daemon. Both native IPC and the CLI call these handlers. */
function createComputerService({ dataDir, emit = () => {}, ...options }) {
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
  const computers = createComputers({
    dataDir,
    credentials: vault,
    ownHostId: () => readOwnHostId(dataDir),
    ...options,
    onChange: () => ipc?.changed(),
    emit: (id, channel, payload) => ipc?.event(id, channel, payload),
  });
  ipc = registerComputers({
    ipcMain: { handle: (method, handler) => handlers.set(method, handler) },
    computers,
    cache,
    thisMac: computerName,
    send: emit,
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
    async close() {
      await ready.catch(() => {});
      await controls;
      await computers.close();
      cache.close();
    },
  };
}

module.exports = { createComputerService };
