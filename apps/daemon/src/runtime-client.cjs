const { isLinkScopeKey, scopeKey } = require("@milagre/shared/chat-scopes");
const { ensureDaemon, compatibleClient, HOST_GONE } = require("./bootstrap.cjs");
const { projectOfKey } = require("@milagre/shared/agent-runs");
const { thisComputer } = require("@milagre/shared/host-computer");

const RESULT_PAGES = "result-pages-v1";
const OUTDATED_HOST = "Restart Milagre's background host to load large projects.";
const MAX_HELD = 10_000;
// A host that went away without being asked to (it crashed, or was killed) is started again: this many times, the
const START_ATTEMPTS = 3;
const RESTARTED_HOST = "Milagre's background host stopped unexpectedly, so it was started again.";
const MAX_PAGES = 1024;
const MAX_PAGED_CHARS = 128 * 1024 * 1024;
const STATE_PATCHES = "state-patches-v1";
const CHAT_PAGES = "chat-pages-v1";
const SUBAGENT_TAILS = "subagent-tails-v1";
const ARCHIVED_SUMMARIES = "archived-subagent-summaries-v1";
const SHOWN_PROJECT = new Set([
  "project:open",
  "project:current",
  "project:switch",
  "canvas:open-project",
  "onboarding:create",
  "onboarding:clone",
  "onboarding:init-git",
]);
async function takeStatePatches(connection, status) {
  const capabilities = status.capabilities ?? [];
  if (capabilities.includes(CHAT_PAGES))
    await connection.call("daemon:state-patches", [
      {
        messages: false,
        ...(capabilities.includes(SUBAGENT_TAILS) ? { transcripts: false } : {}),
        ...(capabilities.includes(SUBAGENT_TAILS) && capabilities.includes(ARCHIVED_SUMMARIES) ? { archivedSubagents: false } : {}),
      },
    ]);
  else if (status.capabilities?.includes(STATE_PATCHES)) await connection.call("daemon:state-patches");
}

function projectOfEvent({ channel, payload }) {
  if (!payload || typeof payload !== "object") return null;
  if (channel === "link:state") return typeof payload.linkId === "string" ? scopeKey({ kind: "link", linkId: payload.linkId }) : null;
  if (channel === "project:state") return typeof payload.path === "string" ? payload.path : null;
  if (typeof payload.chatId === "string") return projectOfKey(payload.chatId);
  return typeof payload.projectPath === "string" ? payload.projectPath : null;
}
const carriesState = (payload) =>
  Boolean(payload && typeof payload === "object" && (payload.stateTooLarge || (payload.state && typeof payload.state === "object")));

async function connectDesktopRuntime(options) {
  const { emit = () => {}, dataDir, reconnectMs = 1000, maxPagedChars = MAX_PAGED_CHARS } = options;
  const outdated = (status) =>
    !status.capabilities?.includes(RESULT_PAGES) || (options.requiredCapabilities ?? []).some((name) => !status.capabilities?.includes(name));
  /** @type {typeof ensureDaemon} */
  const startHost = options.startHost ?? ensureDaemon;
  const remote = typeof options.connect === "function";
  const first = remote ? await options.connect() : await startHost(options);
  async function readStatus(connection) {
    const status = connection.status ?? (await connection.call("daemon:status"));
    if (!remote && (options.requiredCapabilities ?? []).includes("computer-management-v1") && status.capabilities?.includes("computer-management-v1"))
      return connection.call("daemon:status", [{ computerManagement: true }]);
    return status;
  }
  /** @type {import('@milagre/daemon/bootstrap').DaemonClient | null} */
  let client = first;
  let status;
  try {
    status = await readStatus(first);
    await takeStatePatches(first, status);
  } catch (error) {
    first.close();
    throw error;
  }
  const methods = [...status.methods];
  let hostMethods = [...status.methods];
  let hostOutdated = outdated(status);
  let closed = false;
  let restarting = false;
  let timer;
  /** @type {string | null} */
  let currentProject = null;
  let currentChat = null;
  let focused = false;
  let recovering = false;
  let capturingSnapshot = false;
  let buffered = [];
  let bufferedBytes = 0;
  const projects = new Set();

  function forward({ channel, payload }) {
    emit(channel, payload);
  }
  const connectedState = () =>
    hostOutdated ? { connected: true, hostOutdated: true, message: options.outdatedMessage ?? OUTDATED_HOST } : { connected: true };
  function adopt(next) {
    for (const method of next.methods ?? []) if (!methods.includes(method)) methods.push(method);
    hostMethods = [...(next.methods ?? [])];
    hostOutdated = outdated(next);
  }

  const holds = new Map();
  function deliver(connection, event) {
    const project = projectOfEvent(event);
    const hold = project ? holds.get(project) : undefined;
    if (hold && hold.connection === connection) {
      const chatId = event.payload?.chatId;
      const sameChat = typeof chatId === "string" && hold.queue.some((item) => item.payload?.chatId === chatId);
      if (!carriesState(event.payload) && !sameChat) {
        forward(event);
        return;
      }
      if (hold.queue.length >= MAX_HELD) {
        connection.close();
        return;
      }
      hold.queue.push(event);
      return;
    }
    if (!project || !event.payload?.stateTooLarge) {
      forward(event);
      return;
    }
    const created = { connection, queue: [event] };
    holds.set(project, created);
    setImmediate(() => void release(project, created));
  }
  async function release(project, hold) {
    const live = () => holds.get(project) === hold && client === hold.connection && !closed;
    while (live() && hold.queue.length) {
      if (!carriesState(hold.queue[0].payload)) {
        forward(hold.queue.shift());
        continue;
      }
      const batch = hold.queue.splice(0);
      let state;
      let read = true;
      try {
        state = /** @type {{ state: unknown }} */ (
            await hold.connection.call(isLinkScopeKey(project) ? "link:snapshot" : "project:snapshot", [
              isLinkScopeKey(project) ? project.slice("milagre-link:".length) : project,
            ])
        ).state;
      } catch {
        read = false;
      }
      if (!live()) return;
      const last = batch.findLastIndex((item) => ["project:state", "link:state"].includes(item.channel));
      batch.forEach((item, index) => {
        if (!carriesState(item.payload)) {
          forward(item);
          return;
        }
        const { stateTooLarge, state: _own, ...rest } = item.payload;
        if (!read) {
          if (!stateTooLarge) forward(item);
          else if (!["project:state", "link:state"].includes(item.channel)) forward({ ...item, payload: rest });
          return;
        }
        if (["project:state", "link:state"].includes(item.channel) && index !== last) return;
        forward({ ...item, payload: { ...rest, state } });
      });
    }
    if (holds.get(project) === hold) holds.delete(project);
  }

  function attach(connection) {
    connection.on("event", (event) => {
      if (client !== connection || closed) return;
      if (event.channel === "daemon:stopping") {
        hostStopped = true;
        return;
      }
      if (!recovering) {
        deliver(connection, event);
        return;
      }
      if (!capturingSnapshot) return;
      bufferedBytes += Buffer.byteLength(JSON.stringify(event));
      if (buffered.length >= 1024 || bufferedBytes > 16 * 1024 * 1024) {
        connection.close();
        return;
      }
      buffered.push(event);
    });
    connection.once("close", () => {
      if (client !== connection) return;
      client = null;
      if (closed || restarting) return;
      emit("runtime:connection", { connected: false, message: "Connection to the host was interrupted. Reconnecting…" });
      if (!recovering) scheduleReconnect();
    });
  }
  let hostStopped = false;
  let starts = 0;
  const mayStart = () => !hostStopped && starts < START_ATTEMPTS;
  function scheduleReconnect() {
    if (closed || timer) return;
    timer = setTimeout(
      () => {
        timer = null;
        void reconnect();
      },
      mayStart() ? reconnectMs * 2 ** starts : reconnectMs,
    );
  }
  async function reconnect() {
    let connection;
    let started = false;
    try {
      if (remote) connection = await options.connect();
      else if (mayStart()) {
        try {
          connection = await compatibleClient(dataDir);
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || !HOST_GONE.includes(String(error.code))) throw error;
          starts++;
          started = true;
          if (!restarting) emit("runtime:connection", { connected: false, message: "Milagre's background host stopped. Starting it again…" });
          connection = await startHost(options);
        }
      } else connection = await compatibleClient(dataDir);
      if (closed) {
        connection.close();
        return undefined;
      }
      const next = await readStatus(connection);
      adopt(next);
      await takeStatePatches(connection, next);
      client = connection;
      recovering = true;
      capturingSnapshot = false;
      buffered = [];
      bufferedBytes = 0;
      attach(connection);
      /** @param {string} projectPath */
      const openAgain = async (projectPath) => {
        try {
          await connection.call(isLinkScopeKey(projectPath) ? "link:open" : "project:open", [
            isLinkScopeKey(projectPath) ? projectPath.slice("milagre-link:".length) : projectPath,
          ]);
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
          const message = error instanceof Error ? error.message : String(error);
          if (
            ["DAEMON_CLOSED", "CLOSING", "UNAUTHORIZED", "ETIMEDOUT", "ECONNRESET", "ECONNABORTED", "EPIPE", "FRAME_TOO_LARGE", "INVALID_REQUEST"].includes(
              code,
            ) ||
            /^(Daemon connection closed|Timed out:|Incompatible daemon protocol|The daemon sent an invalid paged response|The daemon's paged response is too large)/.test(
              message,
            )
          )
            throw error;
          console.warn("[runtime] couldn't reopen Project:", projectPath, message);
          projects.delete(projectPath);
          if (currentProject === projectPath) {
            currentProject = null;
            currentChat = null;
          }
        }
      };
      for (const projectPath of projects) await openAgain(projectPath);
      if (currentProject) await openAgain(currentProject);
      await connection.call("chat:set-open", [currentChat]);
      await connection.call("daemon:focus", [{ focused }]);
      capturingSnapshot = true;
      const manifest = await connection.call("daemon:snapshot", [{ paged: true }]);
      if (remote && (!Number.isSafeInteger(manifest.pageCount) || manifest.pageCount < 1 || manifest.pageCount > MAX_PAGES))
        throw new Error("The computer sent an invalid snapshot");
      const pages = [];
      let chars = 0;
      for (let index = 0; index < manifest.pageCount; index++) {
        const page = await connection.call("daemon:snapshot-page", [manifest.snapshotId, index]);
        if (remote) {
          if (typeof page !== "string") throw new Error("The computer sent an invalid snapshot");
          chars += page.length;
          if (chars > maxPagedChars) throw new Error("The computer's snapshot is too large");
        }
        pages.push(page);
      }
      const snapshot = JSON.parse(pages.join(""));
      emit("runtime:snapshot", snapshot);
      for (const event of buffered) if (event.seq > snapshot.eventSeq) deliver(connection, event);
      buffered = [];
      recovering = false;
      const restarted = starts > 0 && !restarting;
      hostStopped = false;
      starts = 0;
      emit("runtime:connection", restarted ? { ...connectedState(), notice: RESTARTED_HOST } : connectedState());
      return undefined;
    } catch (error) {
      recovering = false;
      buffered = [];
      if (client === connection) client = null;
      connection?.close();
      if (!closed) {
        const reason = error instanceof Error ? error.message : String(error);
        if (started && starts >= START_ATTEMPTS)
          emit("runtime:connection", { connected: false, failed: true, message: `Milagre's background host couldn't start again: ${reason}` });
        else if (hostStopped || starts < START_ATTEMPTS) emit("runtime:connection", { connected: false, message: `Host unavailable: ${reason}` });
        scheduleReconnect();
      }
      return error;
    }
  }
  attach(client);
  if (hostOutdated) emit("runtime:connection", connectedState());

  async function stopHost(connection, message) {
    let deadline;
    let onClose;
    const stopped = new Promise((resolve, reject) => {
      onClose = resolve;
      connection.once("close", onClose);
      deadline = setTimeout(() => reject(new Error(message)), 30000);
    });
    try {
      await Promise.all([connection.call("daemon:stop"), stopped]);
    } finally {
      clearTimeout(deadline);
      if (onClose) connection.off("close", onClose);
    }
  }

  async function invoke(method, args = []) {
    if (closed || !client || recovering) throw new Error("Milagre host is disconnected. Your command was not sent.");
    const result = /** @type {any} */ (await client.call(method, args));
    if (SHOWN_PROJECT.has(method) && result && typeof result === "object" && "path" in result && typeof result.path === "string") {
      currentProject = result.path;
      if (method !== "canvas:open-project") projects.add(result.path);
    }
    if (method === "link:open" && result?.link?.id) {
      currentProject = scopeKey({ kind: "link", linkId: result.link.id });
      projects.add(currentProject);
    }
    if (method === "chat:set-open") currentChat = args[0] ?? null;
    return result;
  }
  return {
    methods,
    hostMethods: () => [...hostMethods],
    environmentReady: Promise.resolve(),
    invoke,
    async openStream(target, port) {
      if (closed || !client || recovering) throw new Error("Milagre host is disconnected.");
      const peer = /** @type {any} */ (client);
      if (typeof peer.openStream !== "function") throw new Error("This host doesn't carry streams.");
      return peer.openStream(target, port);
    },
    openProject: (projectPath) => invoke("project:open", [projectPath, { takeNotice: true }]),
    resumeRecentProjects: async () => {},
    focused: () => invoke("daemon:focus", [{ focused: true }]),
    setFocused(value) {
      focused = value === true;
      return invoke("daemon:focus", [{ focused }]);
    },
    async restartHost() {
      if (remote) throw new Error(`Only ${thisComputer}'s own host restarts from here.`);
      if (closed || restarting) return;
      if (!client || recovering) throw new Error("Reconnect to the host before restarting it.");
      const connection = client;
      restarting = true;
      try {
        emit("runtime:connection", { connected: false, message: "Restarting the background host…" });
        await stopHost(connection, "The background host has not stopped. Try again.");
        clearTimeout(timer);
        timer = null;
        hostStopped = false;
        starts = 0;
        const failure = await reconnect();
        if (failure) throw failure;
      } catch (error) {
        if (client === connection) emit("runtime:connection", connectedState());
        throw error;
      } finally {
        restarting = false;
      }
    },
    async close({ stopHost: stop = false } = {}) {
      if (closed) return;
      if (stop && remote) throw new Error(`Only ${thisComputer}'s own host stops from here.`);
      if (stop) {
        if (!client || recovering) throw new Error("Reconnect to the host before installing an update.");
        const connection = client;
        hostStopped = true;
        try {
          await stopHost(connection, "The host has not stopped. The update was not installed.");
        } catch (error) {
          if (client === connection) hostStopped = false;
          throw error;
        }
      } else if (client && !recovering && !remote) await client.call("daemon:flush");
      closed = true;
      clearTimeout(timer);
      client?.close();
    },
    async reopen() {
      if (remote) throw new Error(`Only ${thisComputer}'s own host starts from here.`);
      closed = false;
      hostStopped = false;
      starts = 0;
      if (client && !recovering) return;
      clearTimeout(timer);
      timer = null;
      restarting = true;
      try {
        const failure = await reconnect();
        if (failure) throw failure;
      } finally {
        restarting = false;
      }
    },
  };
}
module.exports = { connectDesktopRuntime };
