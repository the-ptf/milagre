const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { z } = require("zod");

// Associations live in the host profile: a device on another Mac cannot inherit them.
// Android serials are reusable, so match the AVD name as well as its serial.
const matches = (a, b) => a.id === b.id && a.platform === b.platform && (a.platform !== "android" || a.name === b.name);
function createChatSimulators({ simulators, file, validateChat, ended = () => false }) {
  let saved,
    queue = Promise.resolve(),
    stopped = false;
  const viewers = new Map();
  // The inner service expires its own capabilities. Retire idle bookkeeping too.
  const expiry = setInterval(() => {
    for (const [viewerId, v] of viewers)
      if (!v.inFlight && Date.now() - v.lastUsed > 60000) {
        viewers.delete(viewerId);
        void simulators.closeViewer({ viewerId }, v.owner).catch(() => {});
      }
  }, 5000);
  expiry.unref();
  const serial = (fn) => {
    if (stopped) return Promise.reject(Error("Simulator service is closed."));
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  };
  async function records(chatId) {
    if (typeof chatId !== "string" || !chatId || chatId.length > 8192) throw Error("An existing Chat is required.");
    await validateChat(chatId);
    if (!saved) {
      try {
        saved = new Map(Object.entries(JSON.parse(await fs.readFile(file, "utf8"))));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        saved = new Map();
      }
    }
    return saved.get(chatId) ?? [];
  }
  async function save(chatId, devices) {
    const next = new Map(saved);
    if (devices.length) next.set(chatId, devices);
    else next.delete(chatId);
    if (next.size > 10000 || devices.length > 32) throw Error("Too many simulator attachments. Detach unused devices first.");
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(Object.fromEntries(next)), { mode: 0o600 });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
    saved = next;
  }
  // Whether this host can show simulators, as its last device list said.
  let supported = true;
  // The window asks every 5 s for each Chat on screen (`attachedOnly`): a Chat with nothing attached shows nothing, so it
  // is answered from its saved attachments without listing devices, which starts a process each time.
  async function listing(chatId, { attachedOnly = false } = {}) {
    let attached = await records(chatId);
    if (attachedOnly && !attached.length) return { chatId, attached: [], devices: [], available: [], supported };
    const list = await simulators.list();
    supported = list.supported !== false;
    // A device that cannot come back once gone (a Simlock lease) leaves the Chat with it, instead of showing as stopped.
    const gone = attached.filter((a) => ended(a) && !list.devices.some((d) => matches(a, d)));
    if (gone.length) await save(chatId, (attached = attached.filter((a) => !gone.includes(a))));
    return {
      ...list,
      chatId,
      attached,
      devices: list.devices.filter((d) => attached.some((a) => matches(a, d))),
      available: list.devices.filter((d) => !attached.some((a) => matches(a, d))),
    };
  }
  const api = {
    list: (request) => serial(() => listing(request?.chatId, { attachedOnly: request?.attachedOnly === true })),
    attach: (request) =>
      serial(async () => {
        const attached = await records(request?.chatId);
        const device = (await simulators.list()).devices.find((d) => d.id === request?.deviceId);
        if (!device) throw Error("Unknown or stopped simulator device. Refresh the device list.");
        if (!attached.some((a) => matches(a, device))) await save(request.chatId, [...attached.filter((a) => a.id !== device.id), device]);
        return listing(request.chatId);
      }),
    detach: (request) =>
      serial(async () => {
        const attached = await records(request?.chatId);
        if (typeof request?.deviceId !== "string" || !request.deviceId) throw Error("A device id is required.");
        await save(
          request.chatId,
          attached.filter((a) => a.id !== request.deviceId),
        );
        const closing = [...viewers].filter(([, v]) => v.chatId === request.chatId && v.deviceId === request.deviceId);
        for (const [viewerId] of closing) viewers.delete(viewerId);
        await Promise.allSettled(closing.map(([viewerId, v]) => simulators.closeViewer({ viewerId }, v.owner)));
        return listing(request.chatId);
      }),
    open: (request, owner) =>
      serial(async () => {
        const list = await listing(request?.chatId);
        if (!list.devices.some((d) => d.id === request?.deviceId)) throw Error("This running simulator is not attached to this Chat. Attach it first.");
        const opened = await simulators.open({ deviceId: request.deviceId }, owner);
        viewers.set(opened.viewerId, { chatId: request.chatId, deviceId: request.deviceId, owner, lastUsed: Date.now(), inFlight: 0 });
        return opened;
      }),
    async closeViewer(request, owner) {
      const v = viewers.get(request?.viewerId);
      if (!v) return null;
      if (v.owner !== owner) throw Error("Unknown simulator viewer or owner.");
      viewers.delete(request.viewerId);
      return simulators.closeViewer(request, owner);
    },
    async disconnect(owner) {
      for (const [id, v] of viewers) if (v.owner === owner) viewers.delete(id);
      await simulators.disconnect(owner);
    },
    async close() {
      stopped = true;
      clearInterval(expiry);
      viewers.clear();
      const closing = simulators.close();
      await Promise.all([queue, closing]);
    },
  };
  for (const method of ["offer", "frame", "status", "control", "input", "repair"])
    api[method] = async (request, owner) => {
      const viewer = viewers.get(request?.viewerId);
      if (!viewer || viewer.owner !== owner) throw Error("Unknown simulator viewer or owner. It may have been detached.");
      viewer.inFlight++;
      try {
        return await simulators[method](request, owner);
      } finally {
        viewer.inFlight--;
        viewer.lastUsed = Date.now();
      }
    };
  return api;
}
function simulatorToolDefinitions(chatId, api) {
  return [
    {
      name: "simulator_list",
      description: "List simulators attached to this Chat and other running devices available to attach. Discovery does not attach devices or start capture.",
      input: {},
      readOnly: true,
      run: async () => JSON.stringify(await api.list({ chatId })),
    },
    {
      name: "simulator_attach",
      description:
        "Attach the exact iOS simulator or Android emulator you are using to this Chat so the user can view it from desktop or phone. Does not boot a device or start streaming. Get its deviceId from simulator_list.",
      input: { deviceId: z.string().min(1).max(256) },
      readOnly: false,
      run: async ({ deviceId }) =>
        JSON.stringify({
          ...(await api.attach({ chatId, deviceId })),
          guidance:
            "This device is attached to the current Chat. Use its exact id with your device automation tools. Keep it attached for the user to inspect. simulator_detach removes only this Chat association and leaves the device running.",
        }),
    },
    {
      name: "simulator_detach",
      description:
        "Remove a simulator from this Chat and close this Chat viewers. Leaves the device running and preserves other Chats attachments. Use when requested or when replacing a device.",
      input: { deviceId: z.string().min(1).max(256) },
      readOnly: false,
      run: async ({ deviceId }) => JSON.stringify(await api.detach({ chatId, deviceId })),
    },
  ];
}
/** Experimental: leasing devices from the Simlock pool set up in Settings. Offered only while it is turned on. */
function simlockToolDefinitions(chatId, simlock) {
  const usage = (lease) => ({
    ...lease,
    guidance: [
      `Drive this device only with its launcher, ${lease.launcher}, which is the agent-device CLI bound to this lease: run \`${lease.launcher} --help\` for every command.`,
      `Common steps: \`${lease.launcher} install <bundle-or-package> <path>\`, \`${lease.launcher} open <bundle-or-package> --foreground\` (returns a snapshot with @refs), \`${lease.launcher} press @e12 --settle\`, \`${lease.launcher} screenshot <file.png>\`. Ignore the CLI's advice to close: this launcher refuses close.`,
      `Installs are accepted only from ${lease.installDirectory} and below. The device may be on another computer: it cannot reach development servers on this Mac through localhost, and simctl, adb, argent and Xcode cannot see it.`,
      "It is attached to this Chat so the user can watch it. Call simulator_release when you are done; Simlock wipes it for the next agent.",
    ].join(" "),
  });
  return [
    {
      name: "simulator_lease",
      description:
        "Lease an iOS simulator or Android emulator of its own for this Chat from the Simlock pool (Settings › Experimental). The device is booted, attached to this Chat for the user to watch, and returned with a command bound to it. Omit model for the pool's default phone; simulator_lease_models lists the rest. Waits in Simlock's queue when every device is busy.",
      input: { platform: z.enum(["ios", "android"]), model: z.string().min(1).max(200).optional() },
      readOnly: false,
      run: async ({ platform, model }) => JSON.stringify(usage(await simlock.lease({ platform, model }))),
    },
    {
      name: "simulator_lease_models",
      description: "List the device models the Simlock pool can lease, with each one's newest OS.",
      input: {},
      readOnly: true,
      run: async () => JSON.stringify({ models: await simlock.models() }),
    },
    {
      name: "simulator_release",
      description: "Return a device this Chat leased from Simlock. Simlock wipes it for the next agent, and it is detached from this Chat.",
      input: { deviceId: z.string().min(1).max(256) },
      readOnly: false,
      run: async ({ deviceId }) => {
        const lease = simlock.get(deviceId);
        if (!lease || lease.chatId !== chatId) throw Error("This Chat holds no Simlock lease with that device id.");
        return JSON.stringify(await simlock.release({ deviceId }));
      },
    },
  ];
}
module.exports = { createChatSimulators, simulatorToolDefinitions, simlockToolDefinitions };
