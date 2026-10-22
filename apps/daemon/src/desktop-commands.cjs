const { randomUUID } = require("node:crypto");

/** Local desktop capability port. Commands execute once in their owning desktop; disconnects never replay them. */
function createDesktopCommands({ timeoutMs = 120000 } = {}) {
  const hosts = new Map();
  const pending = new Map();
  const unavailable = () =>
    Object.assign(new Error("This command requires a connected Milagre desktop using the same profile."), { code: "CAPABILITY_UNAVAILABLE" });
  function disconnect(id) {
    hosts.delete(id);
    for (const [key, call] of pending)
      if (call.host === id) {
        pending.delete(key);
        clearTimeout(call.timer);
        call.reject(Object.assign(new Error("Desktop disconnected. The command may have run; check state before retrying."), { code: "OUTCOME_UNKNOWN" }));
      }
  }
  return {
    register(id, methods, send) {
      if (
        !Array.isArray(methods) ||
        methods.length > 1024 ||
        methods.some((name) => typeof name !== "string" || !/^[a-zA-Z][a-zA-Z0-9-]*(?::[a-zA-Z][a-zA-Z0-9-]*)+$/.test(name) || name.length > 128)
      )
        throw new Error("Invalid desktop command registration");
      hosts.set(id, { methods: new Set(methods), send });
      return { registered: methods.length };
    },
    list() {
      return [...new Set([...require("@milagre/core/command-input").nativeCommands, ...[...hosts.values()].flatMap((host) => [...host.methods])])]
        .sort()
        .map((name) => ({
          name: `desktop:${name}`,
          command: `desktop ${name.replaceAll(":", " ")}`,
          requires: ["desktop"],
          available: [...hosts.values()].some((host) => host.methods.has(name)),
          ...require("@milagre/core/command-input").contractFor(name, { desktop: true }),
        }));
    },
    invoke(method, args) {
      if (typeof method !== "string" || !Array.isArray(args)) return Promise.reject(new Error("Expected a desktop method and arguments array"));
      const match = [...hosts.entries()].find(([, host]) => host.methods.has(method));
      if (!match) return Promise.reject(unavailable());
      if (pending.size >= 32) return Promise.reject(new Error("Too many desktop commands are pending"));
      const [hostId, host] = match;
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Object.assign(new Error("Desktop command timed out. It may still be running; check state before retrying."), { code: "OUTCOME_UNKNOWN" }));
        }, timeoutMs);
        pending.set(id, { host: hostId, resolve, reject, timer });
        try {
          host.send({ id, method, args });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
    respond(host, { id, result, error } = {}) {
      const call = pending.get(id);
      if (!call || call.host !== host) throw new Error("Unknown desktop command response");
      pending.delete(id);
      clearTimeout(call.timer);
      if (error) call.reject(Object.assign(new Error(String(error.message)), { code: typeof error.code === "string" ? error.code : "COMMAND_FAILED" }));
      else call.resolve(result);
      return null;
    },
    disconnect,
    close() {
      for (const id of hosts.keys()) disconnect(id);
    },
  };
}

module.exports = { createDesktopCommands };
