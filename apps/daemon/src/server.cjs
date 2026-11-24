const { isLinkScopeKey, scopeFromKey, scopeKey } = require("@milagre/shared/chat-scopes");
const { diffState } = require("@milagre/shared/state-patch");
const { sessionWithArchivedSummaries, sessionWithTranscriptTails, withArchivedSummary, withTranscriptTail } = require("@milagre/shared/subagent-transcript");
const { preparePrivateDirectory } = require("@milagre/core/private-files");
const { wholeState, unloadedChats, isFromDisk } = require("@milagre/core/message-store");
const { withWholeTranscripts } = require("@milagre/core/project-content");
const { createTranscriptOrder } = require("./transcript-order.cjs");
const { prepareToken } = require("./local-auth.cjs");
const net = require("node:net");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const { once } = require("node:events");
const { createRuntime } = require("@milagre/core");
const { registryRoots } = require("@milagre/core/project-registry");

const homeDefaults = (homeDir, options) => ({
  chatsHome: options.chatsHome ?? require("node:path").join(homeDir, ".milagre", "chats"),
  registryRoots: options.registryRoots ?? registryRoots(homeDir),
});
const { socketPath: pathFor, prepareSocketDirectory } = require("./paths.cjs");
const { VERSION, MAX_FRAME_BYTES, wire } = require("./protocol.cjs");
const { createPhone, RELAY_URL } = require("./phone.cjs");
const { computerName } = require("./mobile-pairing.cjs");
const { lanAddresses } = require("./lan-addresses.cjs");
const { createMobilePush } = require("./mobile-push.cjs");
const { createLiveActivity } = require("./live-activity.cjs");
const { createExpoPush } = require("./expo-push.cjs");
const { peerPolicy } = require("./peer-policy.cjs");
const { attentionContext } = require("@milagre/shared/attention");
const { projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");

const { createHostUpdates } = require("./host-updates.cjs");
const { createHostBrowserSignIns } = require("./host-browser-sign-ins.cjs");
const { createDaemonMethods } = require("./daemon-methods.cjs");
const { createAcceptConnection, createResultPages } = require("./daemon-connection.cjs");

const WHOLE = Object.freeze({ messages: true, transcripts: true, archived: true });
const formOf = (options) => ({
  messages: options?.messages !== false,
  transcripts: options?.transcripts !== false,
  archived: options?.archivedSubagents !== false,
});
const formKey = (form) => `${form.messages ? "m" : "-"}${form.transcripts ? "t" : "-"}${form.archived ? "a" : "-"}`;
const wholeSubagents = (form) => form.transcripts && form.archived;
const isWhole = (form) => form.messages && wholeSubagents(form);
const NO_MESSAGES = Object.freeze([]);
const leanStates = new Map();
const leanSessionsByForm = new Map();
function subagentAsTaken(agent, form) {
  const summarized = form.archived ? agent : withArchivedSummary(agent);
  return form.transcripts ? summarized : withTranscriptTail(summarized);
}
function leanSessions(sessions, form) {
  if (!sessions || typeof sessions !== "object" || wholeSubagents(form)) return sessions;
  const key = formKey(form);
  let cache = leanSessionsByForm.get(key);
  if (!cache) leanSessionsByForm.set(key, (cache = new WeakMap()));
  let lean = cache.get(sessions);
  if (!lean) {
    const entries = Object.entries(sessions).map(([id, session]) => {
      const summarized = form.archived ? session : sessionWithArchivedSummaries(session);
      return [id, form.transcripts ? summarized : sessionWithTranscriptTails(summarized)];
    });
    lean = entries.some(([id, session]) => session !== sessions[id]) ? Object.fromEntries(entries) : sessions;
    cache.set(sessions, lean);
  }
  return lean;
}
function leanState(state, form = WHOLE) {
  if (!state || typeof state !== "object") return state;
  const transcripts = form.transcripts ? withWholeTranscripts(state) : state;
  if (isWhole(form)) return wholeState(transcripts);
  const key = formKey(form);
  let cache = leanStates.get(key);
  if (!cache) leanStates.set(key, (cache = new WeakMap()));
  const base = form.messages ? wholeState(transcripts) : transcripts;
  let lean = cache.get(base);
  if (!lean) {
    lean = { ...base };
    if (!form.messages) Object.assign(lean, { messages: NO_MESSAGES, messagesInChats: true });
    if (!wholeSubagents(form)) lean.sessions = leanSessions(base.sessions, form);
    cache.set(base, lean);
  }
  return lean;
}
function resultStates(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return [];
  const items = [result, result.project, ...["projects", "links", "states"].flatMap((key) => (Array.isArray(result[key]) ? result[key] : []))];
  return items.filter((item) => item?.state && typeof item.state === "object").map((item) => item.state);
}
function leanResult(result, form = WHOLE) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const withState = (item) => {
    if (!item?.state || typeof item.state !== "object") return item;
    const state = leanState(item.state, form);
    return state === item.state ? item : { ...item, state };
  };
  let lean = withState(result);
  if (result.project && typeof result.project === "object" && !Array.isArray(result.project)) {
    const project = withState(result.project);
    if (project !== result.project) lean = { ...lean, project };
  }
  for (const key of ["projects", "links", "states"])
    if (Array.isArray(result[key])) {
      const items = result[key].map(withState);
      if (items.some((item, index) => item !== result[key][index])) lean = { ...lean, [key]: items };
    }
  return lean;
}
function agentEventAsTaken(channel, payload, form) {
  const agent = channel === "agent:event" && payload?.event?.type === "subagent-update" ? payload.event.agent : undefined;
  const taken = agent && subagentAsTaken(agent, form);
  return taken && taken !== agent ? { ...payload, event: { ...payload.event, agent: taken } } : null;
}
function messageChanges(previousState, nextState) {
  const previous = previousState?.messages ?? [];
  const next = nextState?.messages ?? [];
  if (previous === next) return { changed: [], removed: [] };
  const before = new Set(previous);
  const changed = next.filter((message) => !before.has(message) && !isFromDisk(message));
  const ids = new Set(next.map((message) => message.id));
  const unloaded = unloadedChats(nextState);
  const kept = (message) => unloaded.has(Number(message.session_id)) && Object.hasOwn(nextState?.sessions ?? {}, String(message.session_id));
  const removed = previous.filter((message) => !ids.has(message.id) && !kept(message)).map((message) => message.id);
  if (!changed.length) return { changed: [], removed };
  const chats = new Map();
  for (const message of next) {
    const list = chats.get(message.session_id);
    if (list) list.push(message);
    else chats.set(message.session_id, [message]);
  }
  return {
    changed: changed.map((message) => {
      const chat = chats.get(message.session_id);
      return { message, after: chat[chat.indexOf(message) - 1]?.id ?? null };
    }),
    removed,
  };
}

function stateScope(channel, payload) {
  if (!payload?.state || typeof payload.state !== "object") return null;
  if (channel === "project:state") return typeof payload.path === "string" ? payload.path : null;
  if (channel === "link:state") return typeof payload.linkId === "string" ? scopeKey({ kind: "link", linkId: payload.linkId }) : null;
  if (channel === "agent:event") return typeof payload.chatId === "string" ? projectOfKey(payload.chatId) : null;
  return null;
}

const SHOWN_PROJECT = new Set([
  "project:open",
  "project:current",
  "project:switch",
  "canvas:open-project",
  "onboarding:create",
  "onboarding:clone",
  "onboarding:init-git",
]);
const STATE_REPLIES = new Set([...SHOWN_PROJECT, "chats:ensure", "project:read", "project:snapshot", "link:open", "link:snapshot"]);
function replyScope(method, result) {
  if (!STATE_REPLIES.has(method) || !hasState(result)) return null;
  if (method.startsWith("link:")) return typeof result.link?.id === "string" ? scopeKey({ kind: "link", linkId: result.link.id }) : null;
  return typeof result.path === "string" ? result.path : null;
}
function sameButMessages(a, b) {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const keys = Object.keys(b);
  return keys.length === Object.keys(a).length && keys.every((key) => key === "messages" || (Object.hasOwn(a, key) && a[key] === b[key]));
}

const encodedStates = new WeakMap();
function encodeState(state) {
  let encoded = encodedStates.get(state);
  if (!encoded) {
    const json = JSON.stringify(state);
    encoded = { json, bytes: Buffer.byteLength(json) };
    encodedStates.set(state, encoded);
  }
  return encoded;
}
const hasState = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value) && value.state && typeof value.state === "object");
function encode(value) {
  if (!hasState(value)) return JSON.stringify(value ?? null);
  const { state, ...rest } = value;
  const head = JSON.stringify(rest);
  return `${head === "{}" ? "{" : `${head.slice(0, -1)},`}"state":${encodeState(state).json}}`;
}

function eventFrame(channel, payload, seq, inlineLimit) {
  let body = payload;
  if (hasState(payload) && encodeState(payload.state).bytes > inlineLimit) {
    const { state: _state, ...rest } = payload;
    body = { ...rest, stateTooLarge: true };
  }
  const json = `{"v":${VERSION},"event":{"channel":${JSON.stringify(channel)},"payload":${encode(body)},"seq":${seq}}}`;
  return { json, bytes: Buffer.byteLength(json) + 1 };
}

function statePatchOf({ sentStates, patchClients, clients, epoch, inlineLimit }, channel, payload, seq) {
  const scope = stateScope(channel, payload);
  if (!scope) return null;
  const previous = sentStates.get(scope);
  const version = (previous?.version ?? 0) + 1;
  sentStates.set(scope, { version, state: payload.state });
  if (![...patchClients.keys()].some((key) => clients.has(key))) return null;
  const { state, ...rest } = payload;
  const frame = (body) => eventFrame(channel, body, seq, Infinity);
  const numbered = (patchBody) => {
    if (previous) {
      const patched = frame({ ...rest, ...patchBody(), base: previous.version, version, epoch });
      if (patched.bytes <= inlineLimit) return patched;
    }
    return frame({ ...rest, resync: true, version, epoch });
  };
  const forms = new Map();
  return {
    previous: previous?.state,
    form(form) {
      const key = formKey(form);
      if (!forms.has(key))
        forms.set(
          key,
          numbered(() => ({
            patch: diffState(leanState(previous.state, form), leanState(state, form)),
            ...(form.messages ? {} : { messages: messageChanges(previous.state, state) }),
          })),
        );
      return forms.get(key);
    },
  };
}
function subscribe(set, listener) {
  set.add(listener);
  return () => set.delete(listener);
}

async function startDaemon({
  dataDir,
  version,
  runtimeOptions = {},
  computerOptions = {},
  phoneOptions = {},
  pushOptions = {},
  homeDir = os.homedir(),
  maxFrameBytes = MAX_FRAME_BYTES,
  pagesTtlMs,
  pagesBudgetChars,
  requireAuthentication = process.platform === "win32",
  authTimeoutMs = 5000,
  onError = (error) => console.error(error),
  onStopped = () => {},
}) {
  if (process.platform === "win32") preparePrivateDirectory(dataDir);
  const authenticationToken = requireAuthentication ? prepareToken(dataDir) : null;
  const sockets = new Set();
  let unauthenticated = 0;
  const inlineLimit = Math.floor(maxFrameBytes / 4);
  const clients = new Map();
  const desktopCommands = require("./desktop-commands.cjs").createDesktopCommands();
  const hostUpdates = createHostUpdates(desktopCommands);
  const views = new Map();
  let eventSeq = 0;
  const patchClients = new Map();
  const epoch = randomUUID();
  const sentStates = new Map();
  const order = createTranscriptOrder({ onError });
  const snapshotRest = new Map();
  let stopping;
  let listening = false;
  const sender = createExpoPush({ ...pushOptions, onError, onInvalid: (token) => push.invalidate(token) });
  const isChatFocused = (chatId) => [...views.values()].some((view) => view.focused && view.chatId === chatId);
  const windowFocused = () => [...views.values()].some((view) => view.focused && !view.peer);
  const push = createMobilePush({
    dataDir,
    send: sender.send,
    isChatFocused,
    onError,
    context: async (chatId) => {
      const owner = projectOfKey(chatId);
      if (!isLinkScopeKey(owner) && (await runtime.invoke("project:recent", [])).some((project) => project.path === owner && project.hidden)) return null;
      const project = await runtime.invoke(isLinkScopeKey(owner) ? "link:snapshot" : "project:snapshot", [
        isLinkScopeKey(owner) ? scopeFromKey(owner).linkId : owner,
      ]);
      return attentionContext(project.state, project.link?.name || project.name || require("node:path").basename(project.path), sessionIdFromKey(chatId));
    },
  });
  const remoteListeners = { event: new Set(), online: new Set(), removed: new Set() };
  let macName;
  const remoteComputers = {
    list: () => computers.remote.list(),
    invoke: (id, method, args) => computers.remote.invoke(id, method, args),
    thisMac: () => (macName ??= computerName()),
    onEvent: (listener) => subscribe(remoteListeners.event, listener),
    onOnline: (listener) => subscribe(remoteListeners.online, listener),
    onRemoved: (listener) => subscribe(remoteListeners.removed, listener),
  };
  const runtime = createRuntime({
    hookRelayUrl: phoneOptions.relayUrl ?? RELAY_URL,
    remoteComputers,
    hostNetwork: () => ({ name: (macName ??= computerName()), addresses: lanAddresses() }),
    ...runtimeOptions,
    ...homeDefaults(homeDir, runtimeOptions),
    dataDir,
    version,
    isChatFocused,
    isChatSeen: (chatId) => isChatFocused(chatId) || push.viewing(chatId),
    notifyWaiting(notice) {
      broadcast("notification:waiting", notice);
      if (/^(?:flow|reminder):/.test(String(notice?.requestId ?? ""))) push.notice(notice.chatId, notice);
      runtimeOptions.notifyWaiting?.(notice);
    },
    emit(channel, payload) {
      broadcast(channel, payload);
      runtimeOptions.emit?.(channel, payload);
    },
  });
  const liveActivity = createLiveActivity({ snapshot: () => runtime.snapshot(), answer: (value) => runtime.invoke("agent:answer-question", [value]) });
  function broadcast(channel, payload) {
    if (channel === "agent:event") push.observe(payload.chatId, payload.event);
    if (channel === "routines:changed")
      queueMicrotask(() => {
        try {
          void phone.syncHooks().catch(() => {});
        } catch {}
      });
    const seq = ++eventSeq;
    const patched = statePatchOf({ sentStates, patchClients, clients, epoch, inlineLimit }, channel, payload, seq);
    if (!clients.size) return;
    let whole;
    const agentFrames = new Map();
    const agentFrame = (form) => {
      const key = formKey(form);
      if (!agentFrames.has(key)) {
        const taken = agentEventAsTaken(channel, payload, form);
        agentFrames.set(key, taken && eventFrame(channel, taken, seq, inlineLimit));
      }
      return agentFrames.get(key);
    };
    const states = hasState(payload) ? [payload.state, patched?.previous].filter(Boolean) : [];
    for (const [key, connection] of clients) {
      if (connection.policy?.denies(channel)) continue;
      const taker = patchClients.get(key);
      order.inOrder(key, taker, states, () => {
        try {
          const frame =
            patched && taker
              ? patched.form(taker)
              : (taker && !wholeSubagents(taker) && agentFrame(taker)) ||
                (whole ??= eventFrame(channel, hasState(payload) ? { ...payload, state: leanState(payload.state) } : payload, seq, inlineLimit));
          connection.send(null, frame.json, frame.bytes);
        } catch (error) {
          onError(new Error(`Milagre couldn't send a ${channel} event: ${error.message}`));
        }
      });
    }
  }
  function replyNumber(scope, state) {
    const sent = sentStates.get(scope);
    if (!sent) {
      sentStates.set(scope, { version: 1, state });
      return 1;
    }
    if (sent.state === state) return sent.version;
    return runtime.stateOf(scope) === state && sameButMessages(sent.state, state) ? sent.version : null;
  }
  function sentNumber(scope, state) {
    if (!sentStates.has(scope)) sentStates.set(scope, { version: 1, state });
    return sentStates.get(scope).version;
  }
  async function readState(owner, form = WHOLE, { withRest = false } = {}) {
    if (typeof owner !== "string" || !owner) throw new Error("Choose a Project or Link");
    const link = isLinkScopeKey(owner);
    const answer = (sent) => ({ ...snapshotRest.get(owner), state: sent.state, version: sent.version, epoch });
    const sent = sentStates.get(owner);
    if (sent && ((!form.messages && !withRest) || snapshotRest.has(owner))) return answer(sent);
    const { state, ...rest } = await runtime.invoke(link ? "link:snapshot" : "project:snapshot", [link ? scopeFromKey(owner).linkId : owner]);
    snapshotRest.set(owner, rest);
    if (sentStates.get(owner)?.state !== state)
      broadcast(link ? "link:state" : "project:state", link ? { linkId: scopeFromKey(owner).linkId, state } : { path: owner, state });
    return answer(sentStates.get(owner));
  }
  const phone = createPhone({
    dataDir,
    onChange: (status) => broadcast("phone:status", status),
    onPaired: (info) => broadcast("phone:paired", info),
    onPending: (requests) => broadcast("devices:pending", { requests }),
    openPeer: (carrier) => acceptConnection({ ...carrier, policy: peerPolicy }),
    hooks: {
      ids: () => runtime.routines.hookIds(),
      receive: (deliveries) => runtime.routines.receiveHooks(deliveries),
      refused: (ids) => runtime.routines.hooksRefused(ids),
      owners: (ids) => runtime.routines.hookOwners(ids),
    },
    ...phoneOptions,
  });
  const computers = require("./computer-service.cjs").createComputerService({
    dataDir,
    ...computerOptions,
    emit: (channel, payload) => broadcast(channel, payload),
    onRemoteEvent: (id, channel, payload) => {
      for (const listener of remoteListeners.event) listener(id, channel, payload);
    },
    onOnline: (id) => {
      for (const listener of remoteListeners.online) listener(id);
    },
    onRemoved: (id) => {
      for (const listener of remoteListeners.removed) listener(id);
    },
  });
  const browserSignIns = createHostBrowserSignIns({ desktop: desktopCommands, computers: () => computers.remote.list() });
  const browserPages = require("./browser-page-proxy.cjs").createBrowserPageProxy();
  const methods = createDaemonMethods({
    runtime,
    phone,
    push,
    liveActivity,
    computers,
    desktopCommands,
    hostUpdates,
    browserSignIns,
    browserPages,
    patchClients,
    readState,
    windowFocused,
    sentNumber,
    formOf,
    leanResult,
    prepareResult: (result, form) => order.prepare(form, resultStates(result)),
    inOrder: (key, send) => order.inOrder(key, patchClients.get(key), [], send),
    dataDir,
    homeDir,
    version,
    epoch,
    eventSeq: () => eventSeq,
    socketPath: () => socketPath,
  });
  const acceptConnection = createAcceptConnection({
    authenticationToken,
    authTimeoutMs,
    maxFrameBytes,
    pagesTtlMs,
    pagesBudgetChars,
    inlineLimit,
    clients,
    views,
    patchClients,
    methods,
    runtime,
    epoch,
    replyNumber,
    computers,
    windowFocused,
    desktopCommands,
    phone,
    onError,
    encode,
    leanResult,
    inOrder: (key, result, send) => order.inOrder(key, patchClients.get(key), resultStates(result), send),
    replyScope,
    SHOWN_PROJECT,
    close: () => close(),
    isStopping: () => stopping,
    countUnauthenticated: (delta) => {
      unauthenticated += delta;
    },
  });

  const server = net.createServer((socket) => {
    if (stopping || (requireAuthentication && unauthenticated >= 32)) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    let framed;
    const client = acceptConnection({
      send: (message, json, bytes) => framed.send(message, json, bytes),
      end: () => socket.end(),
      destroy: () => socket.destroy(),
      isClosed: () => socket.destroyed,
      requireAuthentication,
    });
    framed = wire(socket, { maxFrameBytes, onInvalid: (error) => client.invalid(error), onMessage: (request) => client.receive(request) });
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      client.close();
    });
  });
  let socketPath;
  async function close() {
    stopping ??= (async () => {
      await phone.close();
      await browserPages.close();
      await push.close();
      await sender.close();
      await runtime.close();
      await computers.close();
      desktopCommands.close();
      broadcast("daemon:stopping", {});
      const stopped = listening ? new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))) : Promise.resolve();
      for (const socket of sockets) socket.end();
      const timeout = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
      }, 1000);
      await stopped;
      clearTimeout(timeout);
      onStopped();
    })().catch((error) => {
      stopping = undefined;
      throw error;
    });
    return stopping;
  }
  try {
    socketPath = pathFor(dataDir);
    prepareSocketDirectory(socketPath);
    if (process.platform !== "win32") await fs.rm(socketPath, { force: true });
    server.listen(socketPath);
    await once(server, "listening");
    listening = true;
    if (process.platform !== "win32") await fs.chmod(socketPath, 0o600);
    server.on("error", onError);
    await push.load();
    await phone.start();
    await runtime.resumeRecentProjects();
  } catch (error) {
    await close();
    throw error;
  }
  return { socketPath, close, acceptConnection, unloadIdle: () => runtime.unloadIdle() };
}
module.exports = { startDaemon, createResultPages, formOf, agentEventAsTaken, eventFrame, leanState };
