const path = require("node:path");
const fs = require("node:fs/promises");
const { createComputers } = require("./computers.cjs");
const { createBrowserProxies } = require("./browser-proxy.cjs");
const net = require("node:net");
const { computerOfKey, unqualifyKey, LOCAL_COMPUTER } = require("@milagre/shared/chat-scopes");

const PEER_PANEL_PAGES = "peer-panel-pages-v1";
const { createComputerVault } = require("./computer-vault.cjs");
const { createComputerCaches } = require("./computer-cache.cjs");
const { registerComputers } = require("./computers-ipc.cjs");
const { computerName } = require("./mobile-pairing.cjs");
const { readOwnHostId } = require("./own-host.cjs");
const { writePrivate } = require("./relay-identity.cjs");

function hear(listener) {
  try {
    listener();
  } catch {}
}

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
  /** @type {{ port: number; prefix: string } | null} */
  let pagesEndpoint = null;
  /** @type {Map<string, { id: string; chatId: string; title: string; url: string }[]>} */
  const pagesByComputer = new Map();
  async function sendPages(id) {
    const pages = pagesByComputer.get(id) ?? [];
    try {
      const status = await computers.invoke(id, "daemon:status", []);
      if (!status?.capabilities?.includes(PEER_PANEL_PAGES)) return;
      const request = pages.length && pagesEndpoint ? { via: "peer", ...pagesEndpoint, pages } : { via: "peer", pages: [] };
      await computers.invoke(id, "browser:panel-pages", [request]);
    } catch (error) {
      console.log(`computers: ${id} did not take this Mac's Browser pages (${error?.message ?? error})`);
    }
  }
  const states = new Map();
  const computers = createComputers({
    dataDir,
    credentials: vault,
    ownHostId: () => readOwnHostId(dataDir),
    log: (line) => console.log(`computers: ${line}`),
    acceptStream: (target, port) => {
      if (target !== "127.0.0.1" || !pagesEndpoint || port !== pagesEndpoint.port) throw Object.assign(new Error("Refused"), { code: "ECONNREFUSED" });
      return net.connect({ host: "127.0.0.1", port, noDelay: true });
    },
    ...options,
    onChange: (list) => {
      ipc?.changed();
      for (const computer of list ?? []) {
        const was = states.get(computer.id);
        states.set(computer.id, computer.state);
        if (computer.state === "online" && was !== "online") {
          hear(() => onOnline(computer.id));
          if (pagesByComputer.has(computer.id)) void sendPages(computer.id);
        }
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
  void ready.catch(() => {});
  const proxies = createBrowserProxies({ openStream: (id, target, port) => computers.openStream(id, target, port), log: (line) => console.log(line) });
  handlers.set("computers:browser-proxy", async (_context, computerId) => {
    if (typeof computerId !== "string" || !computers.list().some((computer) => computer.id === computerId)) throw new Error("Unknown computer.");
    return { port: await proxies.port(computerId) };
  });
  handlers.set("computers:browser-pages", async (_context, request) => {
    const pages = Array.isArray(request?.pages) ? request.pages : [];
    if (pages.length > 128) throw new Error("Too many Browser panel pages.");
    if (pages.length) {
      const { port, prefix } = request;
      if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof prefix !== "string" || !/^\/[a-f0-9]{48}$/.test(prefix))
        throw new Error("Invalid Browser panel endpoint.");
      pagesEndpoint = { port, prefix };
    }
    const next = new Map();
    for (const page of pages) {
      const computerId = computerOfKey(page?.chatKey);
      if (!computerId || computerId === LOCAL_COMPUTER || typeof page.id !== "string") continue;
      const list = next.get(computerId) ?? [];
      list.push({ id: page.id, chatId: unqualifyKey(page.chatKey), title: String(page.title ?? "").slice(0, 300), url: String(page.url ?? "").slice(0, 2048) });
      next.set(computerId, list);
    }
    const changed = new Set([...pagesByComputer.keys(), ...next.keys()]);
    pagesByComputer.clear();
    for (const [id, list] of next) pagesByComputer.set(id, list);
    await Promise.all([...changed].map((id) => sendPages(id)));
    return { computers: next.size };
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
