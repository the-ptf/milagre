const { readToken, authenticationProof, authenticationNonce, validToken, validNonce } = require("./local-auth.cjs");
const net = require("node:net");
const { once, EventEmitter } = require("node:events");
const { socketPath } = require("./paths.cjs");
const { VERSION, MAX_PENDING, wire, isEventFrame } = require("./protocol.cjs");

// Commands core lets run longer than the default deadline (git/client.cjs LIMITS, gh, the CLI installers), plus a
// margin. A shorter client deadline reported a slow pre-commit hook or push as failed while it was still running.
const SLOW_METHODS = Object.freeze({
  // Scoped commands may wait on the same user approval cards as their MCP calls.
  "command:run": 30 * 60 * 1000,
  "desktop:invoke": 130000,
  "computers:add": 12 * 60 * 1000,
  "computers:invoke": 30 * 60 * 1000,
  // Image preparation gets 30 s; an 8 MiB upload on a slow uplink can take up to 300 s; revoking the page's
  // older links (in parallel) up to 45 s more.
  "artifact:share-page": 420000,
  "artifact:revoke-page-share": 120000,
  "artifact:revoke-saved-page-share": 120000,
  "git:commit": 330000,
  "git:push": 330000,
  "git:open-pr": 120000,
  "git:generate": 180000,
  "worktree:create": 330000,
  "worktree:remove": 330000,
  // Installing Antigravity downloads about 110 MB and unpacks it; a slow connection takes minutes.
  "agent:update-cli": 1200000,
  // A Linear sign-in waits up to five minutes for the browser, plus two 15 s requests.
  "linear:connect": 330000,
  // Settings › MCP: the server caps one check at 30 s (packages/core/src/mcp/index.cjs); wait a little longer for its answer.
  "mcp:accounts": 45000,
  "mcp:check": 45000,
  "mcp:save": 45000,
  "mcp:saveUrl": 45000,
  "mcp:remove": 45000,
  "mcp:signIn": 45000,
  "mcp:definition": 45000,
});
const deadlineFor = (method, fallback) => Math.max(fallback, SLOW_METHODS[method] ?? 0);

/**
 * A connection to this Mac's daemon. `events: false`: the daemon's events, which it sends every connection, are dropped
 * unread (a connection kept for calls only).
 * @param {{ dataDir: string; timeoutMs?: number; requireAuthentication?: boolean; events?: boolean }} options
 */
async function connect({ dataDir, timeoutMs = 30000, requireAuthentication = process.platform === "win32", events = true }) {
  const authenticationToken = requireAuthentication ? readToken(dataDir) : null;
  const socket = net.createConnection(socketPath(dataDir));
  const connecting = once(socket, "connect");
  const deadline = setTimeout(() => socket.destroy(new Error("Daemon connection timed out")), timeoutMs);
  try {
    await connecting;
  } finally {
    clearTimeout(deadline);
  }
  const client = /** @type {EventEmitter & { call: (method: string, args?: unknown[]) => Promise<any>; close: () => void }} */ (new EventEmitter());
  const pending = new Map();
  // Calls past MAX_PENDING wait here for a free slot (the daemon drops a connection that sends more); a burst of
  // reads on a busy Mac used to reject the next send with "Too many pending daemon requests".
  const queued = [];
  let nextId = 0;
  function fail(error) {
    for (const { reject, timeout } of [...pending.values(), ...queued]) {
      clearTimeout(timeout);
      reject(error);
    }
    pending.clear();
    queued.length = 0;
  }
  function drain() {
    while (queued.length > 0 && pending.size < MAX_PENDING) start(queued.shift());
  }
  const connection = wire(socket, {
    skip: events ? null : isEventFrame,
    onInvalid(error) {
      fail(error);
      socket.destroy();
    },
    onMessage(message) {
      if (message?.v !== VERSION) {
        fail(new Error("Incompatible daemon protocol"));
        socket.destroy();
        return;
      }
      if (message.event) {
        client.emit("event", message.event);
        return;
      }
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timeout);
      drain();
      if (message.error) request.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else if (message.pages) request.resolve(readPages(message.pages));
      else request.resolve(message.result);
    },
  });
  // A response too large for one frame (a big Project's state) arrives as pages, read one at a time in order.
  async function readPages({ pageId, pageCount }) {
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw new Error("The daemon sent an invalid paged response");
    const parts = [];
    for (let index = 0; index < pageCount; index++) parts.push(await client.call("daemon:result-page", [pageId, index]));
    return JSON.parse(parts.join(""));
  }
  socket.on("error", fail);
  socket.on("close", () => {
    fail(Object.assign(new Error("Daemon connection closed"), { code: "DAEMON_CLOSED" }));
    client.emit("close");
  });
  function start(request) {
    const id = ++nextId;
    request.id = id;
    pending.set(id, request);
    try {
      if (!connection.send({ v: VERSION, id, method: request.method, args: request.args, pages: true })) throw new Error("Daemon connection closed");
    } catch (error) {
      pending.delete(id);
      clearTimeout(request.timeout);
      request.reject(error);
    }
  }
  client.call = (method, args = []) =>
    new Promise((resolve, reject) => {
      if (socket.destroyed) {
        reject(new Error("Daemon connection closed"));
        return;
      }
      // The deadline counts time spent queued, so a call never waits longer than it would have unqueued.
      /** @type {{ id: number; method: string; args: unknown[]; resolve: (value: any) => void; reject: (error: Error) => void; timeout?: ReturnType<typeof setTimeout> }} */
      const request = { id: 0, method, args, resolve, reject };
      request.timeout = setTimeout(
        () => {
          pending.delete(request.id);
          const index = queued.indexOf(request);
          if (index >= 0) queued.splice(index, 1);
          reject(new Error(`Timed out: ${method}. It may still be running; do not retry a mutation without checking state.`));
          drain();
        },
        deadlineFor(method, timeoutMs),
      );
      if (pending.size >= MAX_PENDING) queued.push(request);
      else start(request);
    });
  client.close = () => socket.destroy();
  if (requireAuthentication) {
    try {
      const token = authenticationToken;
      const clientNonce = authenticationNonce();
      const challenge = await client.call("daemon:authenticate", [{ clientNonce }]);
      if (!validNonce(challenge?.serverNonce) || !validToken(authenticationProof(token, "server", clientNonce, challenge.serverNonce), challenge?.proof))
        throw Object.assign(new Error("The local daemon could not prove its identity"), { code: "UNAUTHORIZED" });
      await client.call("daemon:authenticate", [{ proof: authenticationProof(token, "client", clientNonce, challenge.serverNonce) }]);
    } catch (error) {
      client.close();
      throw error;
    }
  }
  return client;
}
module.exports = { connect, deadlineFor };
