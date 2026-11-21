const fs = require("node:fs/promises");
const { VERSION } = require("./protocol.cjs");
const { transportDiagnostics } = require("./relay-host.cjs");
const { peerPolicy } = require("./peer-policy.cjs");
const { listDirs } = require("./remote-files.cjs");
const { readMedia, scopeRootsVia } = require("./media-access.cjs");
const { APP_UPDATE_METHODS } = require("./host-updates.cjs");
const { BROWSER_SIGN_IN_METHODS } = require("./host-browser-sign-ins.cjs");

const PUSH_METHODS = Object.freeze(["push:register", "push:unregister", "push:focus"]);
const LIVE_ACTIVITY_METHODS = Object.freeze(["live-activity:state", "live-activity:open", "live-activity:answer", "live-activity:forget"]);
const PHONE_METHODS = Object.freeze(["phone:status", "phone:set-enabled", "phone:reset", "phone:open-pairing", "phone:set-lan"]);
const DEVICE_METHODS = Object.freeze([
  "devices:list",
  "devices:remove",
  "devices:pending",
  "devices:allow",
  "devices:deny",
  "devices:take-notices",
  "devices:confirm-notices",
  "devices:acknowledge",
]);
const DESKTOP_PEER = "desktop-peer-v1";
const PEER_TCP = "peer-tcp-v1";
const PEER_PANEL_PAGES = "peer-panel-pages-v1";
const PEER_METHODS = Object.freeze(["peer:routes"]);
const REMOTE_FILES = "remote-files-v1";
const FILE_METHODS = Object.freeze(["fs:list-dirs", "media:read"]);
const STATE_PATCHES = "state-patches-v1";
const CHAT_PAGES = "chat-pages-v1";
const SUBAGENT_TAILS = "subagent-tails-v1";
const ARCHIVED_SUMMARIES = "archived-subagent-summaries-v1";
const STATE_METHODS = Object.freeze(["state:read"]);

/** A handler's answer when the request already replied (or must not), so dispatch sends nothing more. */
const NO_REPLY = Symbol("no reply");
/** A handler's answer when the request goes on to the runtime after all. */
const TO_RUNTIME = Symbol("to runtime");

function daemonStatus(request, { policy }, { runtime, desktopCommands, computers, version, dataDir, socketPath }) {
  return {
    ...(request.args[0]?.commands === true
      ? {
          desktopCommands: policy ? [] : desktopCommands.list(),
          commandDefinitions: runtime.commandDefinitions().filter((definition) => !policy?.denies(definition.name)),
        }
      : {}),
    pid: process.pid,
    version,
    protocolVersion: VERSION,
    dataDir,
    socketPath: socketPath(),
    closing: runtime.isClosing(),
    capabilities: [
      "command-dispatch-v1",
      ...(policy ? [] : ["computer-management-v1"]),
      ...(policy ? [] : ["desktop-commands-v1"]),
      "desktop-v1",
      "snapshot-pages-v1",
      "result-pages-v1",
      ...(policy?.denies("push:register") ? [] : ["mobile-push-v1", "mobile-push-schedule-v1"]),
      STATE_PATCHES,
      CHAT_PAGES,
      SUBAGENT_TAILS,
      ARCHIVED_SUMMARIES,
      DESKTOP_PEER,
      ...(policy === peerPolicy ? [PEER_TCP, PEER_PANEL_PAGES] : []),
      REMOTE_FILES,
    ],
    methods: [
      ...runtime.methods,
      ...(request.args[0]?.commands === true
        ? [
            "project:open",
            "daemon:status",
            "daemon:snapshot",
            "daemon:snapshot-page",
            "daemon:result-page",
            "daemon:flush",
            "daemon:focus",
            "daemon:state-patches",
            "daemon:stop",
          ]
        : []),
      ...(request.args[0]?.computerManagement === true || request.args[0]?.commands === true ? computers.methods : []),
      "desktop:register",
      "desktop:respond",
      "desktop:invoke",
      ...PHONE_METHODS,
      ...DEVICE_METHODS,
      ...PUSH_METHODS,
      ...LIVE_ACTIVITY_METHODS,
      ...STATE_METHODS,
      ...PEER_METHODS,
      ...FILE_METHODS,
      ...APP_UPDATE_METHODS,
      ...BROWSER_SIGN_IN_METHODS,
      "browser:page-url",
      "browser:release-page-url",
      "browser:keep-page-url",
    ].filter((method) => !policy?.denies(method)),
  };
}

async function desktopMethod(request, { policy, key, connection }, { desktopCommands }) {
  if (policy) throw Object.assign(new Error("Desktop capabilities are available only to local clients"), { code: "NOT_AVAILABLE_REMOTELY" });
  const input = request.args[0] ?? {};
  if (request.method === "desktop:register")
    return desktopCommands.register(key, input.methods, (payload) => connection.send({ v: VERSION, event: { channel: "desktop:request", payload } }));
  if (request.method === "desktop:respond") return desktopCommands.respond(key, input);
  if (request.method === "desktop:invoke") return desktopCommands.invoke(input.method, input.args);
  throw new Error(`Unknown command: ${request.method}`);
}

function phoneMethods({ phone, push, liveActivity }) {
  return {
    "phone:status": (request) => {
      let result = phone.status();
      if (transportDiagnostics) {
        result = { ...result, transport: transportDiagnostics.read() };
        if (request.args[0]?.resetTransport === true) transportDiagnostics.reset();
      }
      return result;
    },
    "phone:set-enabled": async (request) => {
      const result = await phone.setEnabled(request.args[0]);
      if (request.args[0] !== false) return result;
      await phone.settled();
      await push.clear();
      liveActivity.clear();
      return phone.status();
    },
    "phone:reset": async () => {
      await phone.reset();
      await phone.settled();
      await push.clear();
      liveActivity.clear();
      return phone.status();
    },
    "phone:open-pairing": () => phone.openPairing(),
    "phone:set-lan": (request) => phone.setLan(request.args[0]),
    "devices:list": () => phone.devices(),
    "devices:remove": (request) => phone.removeDevice(request.args[0]),
    "devices:take-notices": async (_request, { isClosed, connectionClosed, noticeClaims }) => {
      const result = await phone.takeDeviceNotices();
      if (result.claim) {
        if (connectionClosed() || isClosed()) phone.releaseDeviceNotices(result.claim);
        else noticeClaims.add(result.claim);
      }
      return result;
    },
    "devices:confirm-notices": async (request, { noticeClaims }) => {
      const result = await phone.confirmDeviceNotices(request.args[0]);
      noticeClaims.delete(request.args[0]);
      return result;
    },
    "devices:acknowledge": (request) => phone.acknowledgeDevices(request.args[0]),
    "devices:pending": () => phone.pendingDevices(),
    "devices:allow": (request) => phone.allowDevice(request.args[0]),
    "devices:deny": (request) => phone.denyDevice(request.args[0]),
    "peer:routes": () => phone.peerRoutes(),
  };
}

function serviceMethods({ runtime, push, liveActivity, hostUpdates, browserSignIns, browserPages, dataDir, homeDir }) {
  return {
    ...Object.fromEntries(APP_UPDATE_METHODS.map((method) => [method, (request) => hostUpdates.invoke(request.method)])),
    ...Object.fromEntries(BROWSER_SIGN_IN_METHODS.map((method) => [method, (request) => browserSignIns.invoke(request.method, request.args)])),
    "browser:page-url": (request) => browserPages.open(request.args[0]),
    "browser:release-page-url": (request) => browserPages.release(request.args[0]),
    "browser:keep-page-url": (request) => browserPages.keep(request.args[0]),
    "live-activity:state": (request) => liveActivity.state(request.args[0]),
    "live-activity:open": (request) => liveActivity.open(request.args[0]),
    "live-activity:answer": (request) => liveActivity.choose(request.args[0]),
    "live-activity:forget": (request) => {
      liveActivity.forget(request.args[0]?.deviceId);
      return null;
    },
    "push:register": (request) => push.register(request.args[0]),
    "push:unregister": (request) => push.unregister(request.args[0]),
    "push:focus": (request) => push.focus(request.args[0]),
    "fs:list-dirs": (request) =>
      listDirs(request.args[0], {
        home: homeDir,
        projectPaths: async () => {
          const [registry, recent] = await Promise.all([runtime.invoke("project:registry", []), runtime.invoke("project:recent", [])]);
          const paths = [...(Array.isArray(registry) ? registry : []), ...(Array.isArray(recent) ? recent : [])].map((project) => project.path);
          return Promise.all(paths.map((folder) => fs.realpath(folder).catch(() => folder)));
        },
      }),
    "media:read": (request) =>
      readMedia(request.args[0], {
        dataDir,
        scopeRoots: scopeRootsVia({ dataDir, call: (method, args) => runtime.invoke(method, args) }),
        chatImage: (scope, file) => runtime.invoke("project:chat-image", [scope, file]),
      }),
  };
}

function hostMethods({ runtime, computers, patchClients, readState, windowFocused, sentNumber, formOf, leanResult, prepareResult, eventSeq, epoch }) {
  return {
    "daemon:snapshot": async (request, { key, capturePages }) => {
      const whole = runtime.snapshot();
      await prepareResult?.(whole, patchClients.get(key));
      const snapshot = { ...leanResult(whole, patchClients.get(key)), eventSeq: eventSeq() };
      if (request.args[0]?.paged !== true) return snapshot;
      const pages = await capturePages(JSON.stringify(snapshot));
      if (!pages) return NO_REPLY;
      return { snapshotId: pages.pageId, pageCount: pages.pageCount, eventSeq: snapshot.eventSeq };
    },
    "daemon:snapshot-page": (request, { resultPages }) => resultPages.page(...request.args),
    "daemon:result-page": (request, { resultPages }) => resultPages.page(...request.args),
    "daemon:flush": () => runtime.flush(),
    "daemon:state-patches": (request, { key, connectionClosed }) => {
      if (!connectionClosed()) patchClients.set(key, formOf(request.args[0]));
      return { epoch };
    },
    "state:read": (request, { key }) => readState(request.args[0], patchClients.get(key), { withRest: request.args[1]?.rest === true }),
    "daemon:focus": async (request, { view }) => {
      const next = request.args[0];
      if (!next || typeof next.focused !== "boolean") throw new Error("Expected a focused boolean");
      view.focused = next.focused;
      computers.setFocused(windowFocused());
      if (view.focused) await runtime.focused(view);
      return undefined;
    },
    "chat:set-open": async (request, { view }) => {
      view.chatId = typeof request.args[0] === "string" ? request.args[0] : null;
      await runtime.chatOpened(view.chatId);
      return undefined;
    },
    "daemon:stop": async () => {
      await runtime.close();
      return { stopping: true };
    },
    "project:open": (request) => runtime.openProject(request.args[0], { takeNotice: request.args[1]?.takeNotice === true }),
    "project:current": (_request, { view }) => (view.projectPath ? runtime.invoke("project:snapshot", [view.projectPath]) : TO_RUNTIME),
    "project:read": async (request, { context }) => {
      if (request.args[1]?.state !== false) return TO_RUNTIME;
      const { state, ...project } = await runtime.invoke("project:read", [request.args[0]], context);
      return { ...project, version: sentNumber(project.path, state), epoch };
    },
  };
}

function runtimeArgs(request, policy) {
  if (
    !policy ||
    (request.method !== "link:update" && request.method !== "link:create") ||
    !request.args[0] ||
    typeof request.args[0] !== "object" ||
    Array.isArray(request.args[0]) ||
    !("hidden" in request.args[0])
  )
    return request.args;
  const { hidden: _hidden, ...rest } = request.args[0];
  return [rest, ...request.args.slice(1)];
}

/**
 * The daemon's own methods, checked before a request goes to the runtime. `handle` answers with the result,
 * NO_REPLY when the request was answered already, or the runtime's result for anything not handled here.
 */
function createDaemonMethods(deps) {
  const table = Object.assign(Object.create(null), hostMethods(deps), serviceMethods(deps), phoneMethods(deps));
  table["daemon:status"] = (request, connection) => daemonStatus(request, connection, deps);
  async function handle(request, connection) {
    if (request.method === "daemon:status") return table["daemon:status"](request, connection);
    if (request.method.startsWith("computers:")) {
      if (connection.policy) throw Object.assign(new Error("Computer management requires a local owner connection"), { code: "NOT_AVAILABLE_REMOTELY" });
      return deps.computers.invoke(request.method, request.args, {
        send: (channel, payload) => connection.connection.send({ v: VERSION, event: { channel, payload } }),
      });
    }
    if (request.method.startsWith("desktop:")) return desktopMethod(request, connection, deps);
    const own = table[request.method];
    const result = own ? await own(request, connection) : TO_RUNTIME;
    if (result !== TO_RUNTIME) return result;
    return deps.runtime.invoke(request.method, runtimeArgs(request, connection.policy), connection.context);
  }
  return { handle };
}

module.exports = { createDaemonMethods, NO_REPLY };
