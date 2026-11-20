const http = require("node:http");
const { once } = require("node:events");
const { timingSafeEqual } = require("node:crypto");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { randomUUID, createHash } = require("node:crypto");
const zlib = require("node:zlib");
const { WebSocketServer, WebSocket } = require("ws");
const { applyAgentEvent, chatInProject, projectOfKey } = require("@milagre/shared/agent-runs");
const { applyStatePatch, diffState } = require("@milagre/shared/state-patch");
const { isLinkScopeKey, scopeFromKey } = require("@milagre/shared/chat-scopes");
const { openMedia } = require("./media-access.cjs");
const { connect } = require("./client.cjs");
const { createConfinement } = require("./confine.cjs");
const { METHODS } = require("./mobile-methods.cjs");
const { createMobileRoutes } = require("./mobile-routes.cjs");
const { failure, forPhone, forChatList, runsForPhone, projectRuns, projectRunsForPhone } = require("./mobile-projections.cjs");
const LIVE_ORIGIN = "milagre-app://phone";
const MAX_LIVE = 8;
const MAX_ACTIVE = 16;
const MAX_WAITING = 64;
const MAX_WAIT = 20_000;
const LIVE_DELAY = { runs: 150, project: 400 };
function sharedRead(read) {
  let events = 0;
  let pending = null;
  return {
    changed() {
      events++;
    },
    read() {
      if (pending?.events === events) return pending.promise;
      const current = { events, promise: Promise.resolve().then(read) };
      pending = current;
      const forget = () => {
        if (pending === current) pending = null;
      };
      current.promise.then(forget, forget);
      return current.promise;
    },
  };
}
const CHAT_LIST_CACHE = 64;
const CHAT_LIST_MAX_AGE = 30000;
const ATTACHMENT_QUOTA = 200 * 1024 * 1024;
function chatLiveSignal(channel, payload) {
  if (channel === "chat:btw-event") return ["btw", payload.btw?.status === "running" ? LIVE_DELAY.runs : 0];
  if (payload.state || payload.stateTooLarge || typeof payload.version === "number") return ["project", LIVE_DELAY.runs];
  return [payload.event?.type === "subagent-update" ? "project" : "runs"];
}
const SIGNAL_ORDER = ["accounts", "usage", "token-usage", "mcp", "designs", "library", "keybindings", "links", "routines", "orchestrator", "pulls", "btw"];
const SIGNALS = { "designs:enabled-changed": "designs", "keybindings:changed": "keybindings", "routines:changed": "routines" };
const OWNER_SIGNALS = {
  "accounts:changed": "accounts",
  "usage:changed": "usage",
  "token-usage:changed": "token-usage",
  "mcp:changed": "mcp",
  "local-mcp:changed": "mcp",
  "canvas:links-changed": "links",
  "orchestrator:changed": "orchestrator",
};

async function startMobileBridge({
  dataDir,
  port = 8787,
  token,
  compressAbove = 1024,
  pingMs = 25000,
  queueWaitMs = MAX_WAIT,
  allowedRoot,
  attachmentQuota = ATTACHMENT_QUOTA,
  phoneRoutes,
}) {
  if (!/^[a-f0-9]{64}$/.test(token ?? "")) throw new Error("Bridge token must be 32 random bytes encoded as hex");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid bridge port");
  const confine = allowedRoot === undefined ? null : createConfinement({ allowedRoot, uploadsDir: path.join(dataDir, "mobile-attachments") });
  if (!Number.isSafeInteger(attachmentQuota) || attachmentQuota < 0) throw new Error("Invalid attachment quota");
  await confine?.root();
  const expected = Buffer.from(`Bearer ${token}`);
  const client = await connect({ dataDir });
  const hostRuns = sharedRead(() => client.call("chat:runs"));
  await client.call("daemon:state-patches", [{ transcripts: false, archivedSubagents: false, messages: false }]).catch(() => {});
  const validScope = (owner) => typeof owner === "string" && (isLinkScopeKey(owner) || path.isAbsolute(owner));
  const HELD_PROJECTS = 4;
  const heldProjects = new Map();
  async function readHeld(owner) {
    const { state, version, epoch, ...rest } = await client.call("state:read", [owner, { rest: true }]);
    return { epoch, version, project: { ...rest, state } };
  }
  async function heldProject(owner) {
    let held = heldProjects.get(owner);
    if (!held) {
      held = await readHeld(owner);
      heldProjects.set(owner, held);
      if (heldProjects.size > HELD_PROJECTS) heldProjects.delete(heldProjects.keys().next().value);
    } else {
      heldProjects.delete(owner);
      heldProjects.set(owner, held);
    }
    return held.project;
  }
  const changes = new Map();
  function followState(channel, payload) {
    const owner =
      channel === "project:state" ? payload?.path : channel === "agent:event" && typeof payload?.chatId === "string" ? projectOfKey(payload.chatId) : null;
    if (typeof owner === "string") changes.set(owner, (changes.get(owner) ?? 0) + 1);
    const held = typeof owner === "string" ? heldProjects.get(owner) : undefined;
    if (!held) return;
    const state = held.project.state;
    if (typeof payload.version === "number") {
      if (payload.resync || payload.epoch !== held.epoch || payload.base !== held.version) heldProjects.delete(owner);
      else Object.assign(held, { version: payload.version, project: { ...held.project, state: applyStatePatch(state, payload.patch) } });
    } else if (payload.state) heldProjects.delete(owner);
    else if (payload.event?.type === "subagent-update")
      held.project = { ...held.project, state: applyAgentEvent(state, {}, owner, payload.chatId, payload.event).state };
  }
  const SNAPSHOT_HISTORY = 8;
  const snapshotEpoch = randomUUID();
  const sentSnapshots = new Map();
  function numberSnapshot(owner, result, since) {
    let sent = sentSnapshots.get(owner);
    if (!sent) sentSnapshots.set(owner, (sent = { last: 0, versions: new Map() }));
    const version = ++sent.last;
    sent.versions.set(version, result);
    if (sent.versions.size > SNAPSHOT_HISTORY) sent.versions.delete(sent.versions.keys().next().value);
    const [epoch, held] = since.split(":");
    const base = epoch === snapshotEpoch ? sent.versions.get(Number(held)) : undefined;
    if (base) {
      const patch = diffState(base, result, 6);
      if (JSON.stringify(patch ?? null).length < 64 * 1024 || JSON.stringify(patch).length < JSON.stringify(result).length / 2)
        return { epoch: snapshotEpoch, version, base: Number(held), patch };
    }
    return { epoch: snapshotEpoch, version, snapshot: result };
  }
  async function withMessages(owner, scope, { marks = false } = {}) {
    const read = await client.call("chat:all-messages", [owner, { marks, withState: true }]);
    const fill = (item) => {
      const { messagesInChats: _lean, ...state } = read.state;
      return { ...item, state: { ...state, messages: read.messages } };
    };
    return scope.link ? { link: fill(scope.link) } : { project: fill(scope.project) };
  }
  async function readScope(owner) {
    await confine?.check(owner);
    if (!validScope(owner)) throw failure(400, "Choose a valid Project or Link");
    if (!isLinkScopeKey(owner)) return { project: await heldProject(owner) };
    const id = scopeFromKey(owner).linkId;
    const [link, projects] = await Promise.all([client.call("link:snapshot", [id]), client.call("project:registry")]);
    return {
      link: {
        ...link,
        projects: link.link.projectIds.map((id) => projects.find((project) => project.id === id) ?? { id, path: "", name: "Unavailable Project" }),
      },
    };
  }
  const chatLists = new Map();
  async function chatListOf(owner, runs) {
    await confine?.check(owner);
    if (!validScope(owner)) throw failure(400, "Choose a valid Project or Link");
    const ownRuns = projectRuns(runs, owner);
    const signature = JSON.stringify(ownRuns);
    const stamp = changes.get(owner) ?? 0;
    const kept = chatLists.get(owner);
    chatLists.delete(owner);
    if (kept && kept.stamp === stamp && kept.signature === signature && Date.now() - kept.at < CHAT_LIST_MAX_AGE) {
      chatLists.set(owner, kept);
      return kept.result;
    }
    const project = heldProjects.get(owner)?.project ?? (await readHeld(owner)).project;
    const { project: listed } = await withMessages(owner, { project }, { marks: true });
    const result = forChatList(listed, ownRuns);
    chatLists.set(owner, { stamp, signature, at: Date.now(), result });
    if (chatLists.size > CHAT_LIST_CACHE) chatLists.delete(chatLists.keys().next().value);
    return result;
  }
  async function scopeRoots(owner) {
    if (!isLinkScopeKey(owner)) return client.call("project:worktree-paths", [owner]);
    const { link } = await readScope(owner);
    return [
      path.join(dataDir, "links", link.link.id, ".milagre", "images"),
      ...Object.values(link.state.sessions).flatMap((chat) => [chat.workspacePath, ...chat.worktrees.map((member) => member.worktreePath)]),
    ];
  }
  let active = 0;
  const waiting = [];
  function slot(res) {
    if (active < MAX_ACTIVE) {
      active++;
      return Promise.resolve();
    }
    if (waiting.length >= MAX_WAITING) return Promise.reject(failure(429, "Too many pending requests"));
    return new Promise((resolve, reject) => {
      const leave = (error) => {
        const at = waiting.indexOf(turn);
        if (at < 0) return;
        waiting.splice(at, 1);
        clearTimeout(turn.expiry);
        reject(error);
      };
      const turn = { resolve, reject: leave };
      turn.expiry = setTimeout(() => leave(failure(429, "Too many pending requests")), queueWaitMs);
      waiting.push(turn);
      res.once("close", () => leave(failure(499, "The phone stopped waiting")));
    });
  }
  function release() {
    const next = waiting.shift();
    if (!next) return void active--;
    clearTimeout(next.expiry);
    next.resolve();
  }
  let closed;
  let url;
  function admit(req, allowedOrigin) {
    const received = Buffer.from(req.headers.authorization ?? "");
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw failure(401, "Connection token is missing or incorrect");
    const address = new URL(url);
    if ((req.headers.origin && req.headers.origin !== allowedOrigin) || ![address.host, `10.0.2.2:${address.port}`].includes(req.headers.host))
      throw failure(403, "Only a native localhost client is supported");
    if (closed) throw failure(503, "Bridge is closing");
  }
  const live = new Set();
  const wss = new WebSocketServer({ noServer: true, clientTracking: false, perMessageDeflate: false, maxPayload: 4096 });
  function signal(entry, type, delay = LIVE_DELAY[type]) {
    entry.kinds.add(type);
    const due = Date.now() + delay;
    if (entry.timer && entry.due <= due) return;
    clearTimeout(entry.timer);
    entry.due = due;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      const types = SIGNAL_ORDER.filter((kind) => entry.kinds.has(kind));
      if (entry.kinds.has("project")) types.push("project");
      else if (entry.kinds.has("runs")) types.push("runs");
      entry.kinds.clear();
      if (entry.socket.readyState === WebSocket.OPEN) for (const type of types) entry.socket.send(JSON.stringify({ type }));
    }, delay);
  }
  function drop(entry) {
    live.delete(entry);
    clearTimeout(entry.timer);
    clearInterval(entry.heartbeat);
  }
  function accept(socket, projectPath) {
    if (closed) {
      socket.close(1001, "Mobile host stopped");
      return;
    }
    if (live.size >= MAX_LIVE) {
      const [oldest] = live;
      drop(oldest);
      oldest.socket.close(1013, "Too many live connections");
    }
    const entry = { socket, projectPath, kinds: new Set(), timer: null, due: 0, alive: true };
    entry.heartbeat = setInterval(() => {
      if (!entry.alive) {
        drop(entry);
        socket.terminate();
        return;
      }
      entry.alive = false;
      socket.ping();
      socket.send(JSON.stringify({ type: "ping" }));
    }, pingMs);
    socket.on("pong", () => {
      entry.alive = true;
    });
    socket.on("error", () => {});
    socket.on("close", () => drop(entry));
    live.add(entry);
  }
  client.on("event", ({ channel, payload } = {}) => {
    hostRuns.changed();
    followState(channel, payload);
    for (const entry of live) {
      const immediate = SIGNALS[channel] ?? (confine ? undefined : OWNER_SIGNALS[channel]);
      if (immediate) signal(entry, immediate, 0);
      if (channel === "pull-requests:changed") signal(entry, "pulls", LIVE_DELAY.project);
      if (channel === "design-library:changed" && payload?.projectPath === entry.projectPath) signal(entry, "library", 0);
      if (
        (channel === "project:state" && payload?.path === entry.projectPath) ||
        (channel === "link:state" && isLinkScopeKey(entry.projectPath) && payload?.linkId === scopeFromKey(entry.projectPath).linkId)
      )
        signal(entry, "project");
      else if (
        (channel === "agent:event" || channel === "chat:btw-event") &&
        typeof payload?.chatId === "string" &&
        payload.event?.type !== "step-draft" &&
        chatInProject(entry.projectPath, payload.chatId)
      ) {
        signal(entry, ...chatLiveSignal(channel, payload));
      }
    }
  });
  async function serveMedia(target, res) {
    const { handle, type, size } = await openMedia(
      { scope: target.searchParams.get("projectPath"), requested: target.searchParams.get("path") },
      {
        dataDir,
        scopeRoots,
        chatImage: (scope, file) => client.call("project:chat-image", [scope, file]),
        check: confine
          ? async (scope, file) => {
              await confine.check(scope);
              await confine.check(file, { uploads: true });
            }
          : undefined,
      },
    );
    try {
      res.writeHead(200, { "content-type": type, "content-length": size, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" });
      await pipeline(handle.createReadStream({ start: 0, end: Math.max(size - 1, 0), autoClose: true }), res);
    } catch (error) {
      await handle.close().catch(() => {});
      if (res.headersSent) {
        res.destroy();
        return;
      }
      throw error;
    }
  }
  const routes = createMobileRoutes({
    readScope,
    hostRuns,
    withMessages,
    numberSnapshot,
    chatListOf,
    confine,
    validScope,
    client,
    scopeRoots,
    attachmentQuota,
    phoneRoutes,
    serveMedia,
  });
  const server = http.createServer({ requestTimeout: 15000, headersTimeout: 10000, maxHeaderSize: 8192 }, (req, res) => {
    const reply = (status, value, { etag = false } = {}) => {
      const body = JSON.stringify({ v: 1, ...value });
      const headers = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" };
      if (etag && status === 200) {
        headers.etag = `"${createHash("sha1").update(body).digest("base64url")}"`;
        if (req.headers["if-none-match"] === headers.etag) {
          res.writeHead(304, headers);
          res.end();
          return;
        }
      }
      if (body.length < compressAbove || !/\bgzip\b/.test(req.headers["accept-encoding"] ?? "")) {
        res.writeHead(status, headers);
        res.end(body);
        return;
      }
      zlib.gzip(body, { level: 6 }, (error, zipped) => {
        if (res.destroyed) return;
        if (error) {
          res.writeHead(status, headers);
          res.end(body);
          return;
        }
        res.writeHead(status, { ...headers, "content-encoding": "gzip", vary: "accept-encoding" });
        res.end(zipped);
      });
    };
    void (async () => {
      admit(req);
      await slot(res);
      if (closed) {
        release();
        throw failure(503, "Bridge is closing");
      }
      try {
        const target = new URL(req.url, url);
        let result;
        const route = req.method === "GET" ? routes.get[target.pathname] : undefined;
        if (route) {
          await route({ target, req, res, reply });
          return;
        }
        if (req.method === "POST" && ["/rpc", "/attachments"].includes(target.pathname)) result = await routes.post({ target, req });
        else throw failure(404, "Unknown endpoint");
        reply(200, { result: result ?? null });
      } finally {
        release();
      }
    })().catch((error) => {
      if (!res.headersSent && !res.destroyed) reply(error.status ?? 409, { error: { message: error.message } });
    });
  });
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => {});
    let projectPath;
    const refuse = (error) => {
      const status = error.status ?? 400;
      const body = JSON.stringify({ v: 1, error: { message: error.message } });
      socket.end(
        `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
      );
    };
    try {
      admit(req, LIVE_ORIGIN);
      const target = new URL(req.url, url);
      if (target.pathname !== "/live") throw failure(404, "Unknown endpoint");
      projectPath = target.searchParams.get("projectPath");
      if (!(projectPath === "" && !confine) && !validScope(projectPath)) throw failure(400, "Choose a valid Project or Link");
    } catch (error) {
      refuse(error);
      return;
    }
    if (!confine) {
      wss.handleUpgrade(req, socket, head, (ws) => accept(ws, projectPath));
      return;
    }
    confine
      .check(projectPath)
      .then(() => {
        if (closed) throw failure(503, "Bridge is closing");
        wss.handleUpgrade(req, socket, head, (ws) => accept(ws, projectPath));
      })
      .catch(refuse);
  });
  async function close() {
    closed ??= new Promise((resolve) => {
      for (const turn of waiting.slice()) turn.reject(failure(503, "Bridge is closing"));
      server.close(resolve);
      server.closeAllConnections();
      const sockets = [...live].map((entry) => {
        drop(entry);
        entry.socket.close(1001, "Mobile host stopped");
        return entry.socket;
      });
      if (sockets.length) setTimeout(() => sockets.forEach((socket) => socket.terminate()), 1000).unref();
      client.close();
    });
    return closed;
  }
  let lostConnection;
  const lost = new Promise((resolve) => {
    lostConnection = resolve;
  });
  client.once("close", () => {
    lostConnection();
    void close();
  });
  try {
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    url = `http://127.0.0.1:${server.address().port}`;
  } catch (error) {
    await close();
    throw error;
  }
  return { url, close, lost };
}
module.exports = { startMobileBridge, forPhone, forChatList, runsForPhone, projectRuns, projectRunsForPhone, sharedRead, METHODS };
