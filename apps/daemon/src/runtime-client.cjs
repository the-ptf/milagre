const { isLinkScopeKey, scopeKey } = require("@milagre/shared/chat-scopes");
const { ensureDaemon, compatibleClient, HOST_GONE } = require("./bootstrap.cjs");
const { projectOfKey } = require("@milagre/shared/agent-runs");
const { thisComputer } = require("@milagre/shared/host-computer");

// A host from before result pages still works; it only fails on very large Projects, as it always did. The window
// offers to restart it (see restartHost).
const RESULT_PAGES = "result-pages-v1";
const OUTDATED_HOST = "Restart Milagre's background host to load large projects.";
// Events waiting behind one Project's state read. Past this the connection is dropped, and the reconnect re-reads every state.
const MAX_HELD = 10_000;
// A host that went away without being asked to (it crashed, or was killed) is started again: this many times, the
// delay doubling from reconnectMs each time. Past that the window says it couldn't, and reconnects keep only connecting.
const START_ATTEMPTS = 3;
const RESTARTED_HOST = "Milagre's background host stopped unexpectedly, so it was started again.";
// A paired computer's snapshot may announce at most this many pages and run to this many characters in all: the same
// limits peer-client.cjs holds its paged replies to (not required from there, which would pull the whole peer client
// into this file's type check).
const MAX_PAGES = 1024;
const MAX_PAGED_CHARS = 128 * 1024 * 1024;
// A host that has them sends what changed in a state event, not the whole state; the window applies it (state-events.ts).
const STATE_PATCHES = "state-patches-v1";
// A host that keeps messages by Chat sends states without them; the window reads each Chat's own (chat-messages.ts).
const CHAT_PAGES = "chat-pages-v1";
// A host that can sends each subagent with only the end of its transcript; the panel reads a whole one (subagent-transcripts.ts).
const SUBAGENT_TAILS = "subagent-tails-v1";
// A host that can sends each archived subagent as a summary; the panel reads the rest when it opens one (subagent-transcripts.ts).
const ARCHIVED_SUMMARIES = "archived-subagent-summaries-v1";
// Calls whose reply is the Project the window shows from then on (server.cjs keeps the same list for its view). Not
// chats:ensure, which opens the Chats home without moving the window to it.
const SHOWN_PROJECT = new Set([
  "project:open",
  "project:current",
  "project:switch",
  "canvas:open-project",
  "onboarding:create",
  "onboarding:clone",
  "onboarding:init-git",
]);
/**
 * Asks a host that can for state patches, and for states without messages, with transcript tails and with archived
 * subagents as summaries when it can; an older one keeps sending whole states.
 */
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

// The Project an event belongs to, when it names one.
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
  // The start every launch and restartHost use; tests stand in for it.
  /** @type {typeof ensureDaemon} */
  const startHost = options.startHost ?? ensureDaemon;
  // A paired computer's host (computers.cjs) is only reached, through `connect`: this Mac never starts, flushes, stops
  // or restarts it. Without `connect` the runtime drives this Mac's own host.
  const remote = typeof options.connect === "function";
  const first = remote ? await options.connect() : await startHost(options);
  async function readStatus(connection) {
    const status = connection.status ?? (await connection.call("daemon:status"));
    // Older desktops already register these names as native IPC handlers. Only new clients opt into daemon proxies.
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
    // No runtime is made, so nothing else would ever close this connection.
    first.close();
    throw error;
  }
  const methods = [...status.methods];
  // The commands of the host connected now. `methods` only grows (each one has an IPC handler), so it says nothing
  // about whether a host reconnected to, maybe an older one, still has a command.
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

  // The host leaves a state over a quarter of a frame out of an event (`stateTooLarge`). It is read in pages and put
  // back before the window sees the event, so a turn's end and its saved reply still arrive together. Each Project
  // waits on its own: other Projects' events, and other chats' streaming, keep flowing. Everything waiting when a read
  // starts was sent before it, so one read answers them all: a burst of state events costs one read, and only the last
  // project:state of a burst is passed on. A reconnect drops what is waiting: its snapshot holds every state.
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
    // Events that arrived in the same read from the socket join the first state read.
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
        // A failed read keeps the window's state; the event still moves the turn on screen.
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
      // The host was asked to stop (by this desktop or anyone else) and saved: it stays stopped.
      if (event.channel === "daemon:stopping") {
        hostStopped = true;
        return;
      }
      if (!recovering) {
        deliver(connection, event);
        return;
      }
      if (!capturingSnapshot) return; // The later snapshot covers restoration events.
      bufferedBytes += Buffer.byteLength(JSON.stringify(event));
      // Recovery re-reads state instead of retaining an unbounded event stream.
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
  // A host stopped on purpose stays stopped: an update, a restart until it starts its own, a quit, or a stop the host
  // announced (daemon:stopping). Its reconnects only connect, and the next desktop launch can start it again. A host
  // that went away otherwise is started again (see START_ATTEMPTS). Only the connection is retried: a command that
  // was sent, or refused while disconnected, is never sent again.
  let hostStopped = false;
  // Starts tried since the host went away; reset once connected.
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
  /** Resolves with the error when it couldn't connect (it then retries by itself), or nothing once connected. */
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
          // A Project removed while the host was offline must not prevent the
          // remaining Projects, or the folder picker, from becoming usable.
          if (!(error instanceof Error) || !("code" in error) || !["ENOENT", "ENOTDIR"].includes(String(error.code))) throw error;
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
      // This Mac's own host is trusted to size its pages; a paired computer's is not (peer-client.cjs holds its replies to the same limits).
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
      // A restart the user asked for needs no notice; one that happened by itself does.
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
        // The last start failed too: say why, and keep that on screen while the retries only try to connect to a host
        // started some other way.
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

  // Stops the host the way an update does (it saves and suspends running turns), then waits for the socket to close.
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
    // The Project the window shows from now on, opened again after a reconnect. A sidebar row (canvas:open-project) is
    // only that: the Projects the sidebar went through aren't all opened again, each one's first read on the new host.
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
    /** The host's commands; restartHost can add the newer host's. */
    methods,
    /** The commands of the host connected now, which a reconnect replaces (an older host has fewer). */
    hostMethods: () => [...hostMethods],
    environmentReady: Promise.resolve(),
    invoke,
    /** A TCP stream from a paired computer to `target:port` as it sees them (peer-streams.cjs); its own host has none. */
    async openStream(target, port) {
      if (closed || !client || recovering) throw new Error("Milagre host is disconnected.");
      // A paired computer's client (peer-client.cjs) has openStream; this Mac's socket client doesn't.
      const peer = /** @type {any} */ (client);
      if (typeof peer.openStream !== "function") throw new Error("This host doesn't carry streams.");
      return peer.openStream(target, port);
    },
    openProject: (projectPath) => invoke("project:open", [projectPath, { takeNotice: true }]),
    resumeRecentProjects: async () => {}, // The daemon resumes once, before it announces startup.
    focused: () => invoke("daemon:focus", [{ focused: true }]),
    setFocused(value) {
      focused = value === true;
      return invoke("daemon:focus", [{ focused }]);
    },
    /** Replaces a running host with this desktop's own (an older one can't load large Projects). The window reconnects to it. */
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
        // A new host that fails to start is reported to the window; the retries that follow start one again.
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
        // A stop acknowledgement follows saving. Socket closure also confirms
        // host shutdown before the installer can replace its files.
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
  };
}
module.exports = { connectDesktopRuntime };
