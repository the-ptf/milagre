const { qualifyKey } = require("@milagre/shared/chat-scopes");

const LOCAL_ONLY = Object.freeze([
  "project:open",
  "project:choose-folder",
  "project:reveal",
  "file:reveal",
  "project:set-hidden",
  "skills:open",
  "skills:reveal",
  "runtime:connection",
  "runtime:restart-host",
  "chat:limit-switch",
  "agent:update-cli",
  "agent:provider-updates",
  "linear:connect",
  "linear:cancel",
  "linear:disconnect",
  "mcp:save",
  "mcp:signIn",
  "mcp:cancelSignIn",
  "connectors:add",
  "connectors:update",
  "connectors:sign-in",
  "connectors:cancel-sign-in",
  "connectors:call",
  "connectors:move",
]);
const LOCAL_ONLY_PREFIXES = Object.freeze([
  "app:",
  "artifact-preview:",
  "canvas:",
  "computers:",
  "devices:",
  "editor:",
  "image:",
  "floating-inbox:",
  "linked:",
  "notification:",
  "phone:",
  "settings:",
  "update:",
]);
const NOT_REMOTE = "Not available on a remote computer";
/** @param {string} channel */
const isLocalOnly = (channel) => LOCAL_ONLY.includes(channel) || LOCAL_ONLY_PREFIXES.some((prefix) => channel.startsWith(prefix));
/** @type {Readonly<Record<string, string>>} */
const ALIASES = Object.freeze({ "project:open-at": "project:open" });

/**
 * @param {string} computerId @param {unknown} value @returns {any}
 */
function stripComputer(computerId, value, depth = 0) {
  const mark = `${computerId}|`;
  if (typeof value === "string") return value.includes(mark) ? value.split(mark).join("") : value;
  if (depth > 32 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => stripComputer(computerId, item, depth + 1));
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [stripComputer(computerId, key, depth + 1), stripComputer(computerId, item, depth + 1)]),
  );
}

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
/** @param {string} id @param {unknown} value */
const key = (id, value) => (typeof value === "string" ? qualifyKey(id, value) : value);
/** A Link id (a bare UUID) as the window keeps a computer's. @param {string} id @param {unknown} linkId */
const linkId = (id, linkId) => (typeof linkId === "string" && !linkId.includes("|") ? `${id}|${linkId}` : linkId);
/** `value` with its `name` field passed through `how`. @param {string} id @param {any} value @param {string} name @param {(id: string, value: any) => unknown} how */
const field = (id, value, name, how) => (isObject(value) && name in value ? { ...value, [name]: how(id, value[name]) } : value);
/** A map keyed by chat key. @param {string} id @param {any} record */
const keyed = (id, record) => (isObject(record) ? Object.fromEntries(Object.entries(record).map(([chat, item]) => [key(id, chat), item])) : record);
/** @param {string} id @param {any} list @param {(id: string, item: any) => any} how */
const each = (id, list, how) => (Array.isArray(list) ? list.map((item) => how(id, item)) : list);
/** Another computer's own `hidden` flag belongs to its sidebar, not this Mac's. @param {any} value */
const withoutHidden = (value) => {
  if (!isObject(value) || !("hidden" in value)) return value;
  const { hidden: _hidden, ...rest } = value;
  return rest;
};
const withPath = (id, item) => field(id, item, "path", key);
const withRemotePath = (id, item) => withoutHidden(withPath(id, item));
const withChat = (id, item) => field(id, item, "chatId", key);
const withLink = (id, item) => withoutHidden(field(id, item, "id", linkId));
/** @param {string} id @param {any} state */
const withFlowStep = (id, state) =>
  isObject(state) ? { ...field(id, state, "chatId", key), ...(Array.isArray(state.tries) ? { tries: each(id, state.tries, withChat) } : {}) } : state;
/** @param {string} id @param {any} flow */
const withFlow = (id, flow) =>
  isObject(flow) && isObject(flow.state)
    ? { ...flow, state: Object.fromEntries(Object.entries(flow.state).map(([step, state]) => [step, withFlowStep(id, state)])) }
    : flow;
/** @param {string} id @param {any} run */
const withRun = (id, run) => field(id, field(id, field(id, run, "routineId", key), "chatId", key), "flow", withFlow);
/** @param {string} id @param {any} routine */
const withRoutine = (id, routine) =>
  isObject(routine)
    ? {
        ...routine,
        id: key(id, routine.id),
        target: field(id, field(id, routine.target, "chatId", key), "projectPath", key),
        ...(routine.createdBy ? { createdBy: field(id, routine.createdBy, "chatId", key) } : {}),
        ...(Array.isArray(routine.runs) ? { runs: each(id, routine.runs, withRun) } : {}),
      }
    : routine;

/** @type {Record<string, (id: string, payload: any) => any>} */
const EVENTS = {
  "usage:changed": (id, payload) => field(id, payload, "scopeKey", key),
  "project:state": withPath,
  "link:state": (id, payload) => field(id, payload, "linkId", linkId),
  "agent:event": withChat,
  "chat:btw-event": (id, payload) => field(id, withChat(id, payload), "btw", withChat),
  "terminal:changed": withChat,
  "notification:waiting": withChat,
  "worktree:renamed": (id, payload) => field(id, payload, "projectPath", key),
  "agent:ports": keyed,
  "main-sync:status": (id, payload) => field(id, payload, "projectPath", key),
  "pull-requests:changed": (id, payload) => field(id, payload, "projectPath", key),
  "design-library:changed": (id, payload) => field(id, payload, "projectPath", key),
  "runtime:snapshot": (id, snapshot) =>
    isObject(snapshot)
      ? {
          ...snapshot,
          ...(snapshot.projects ? { projects: each(id, snapshot.projects, withPath) } : {}),
          ...(snapshot.links ? { links: each(id, snapshot.links, (id, item) => field(id, item, "linkId", linkId)) } : {}),
          ...(snapshot.runs ? { runs: field(id, snapshot.runs, "runs", keyed) } : {}),
          ...(snapshot.ports ? { ports: keyed(id, snapshot.ports) } : {}),
        }
      : snapshot,
};

const OPEN_PROJECT = (id, result) => withPath(id, result);
const PROJECT_LIST = (id, result) => each(id, result, withRemotePath);
/** @type {Record<string, (id: string, result: any) => any>} */
const RESULTS = {
  "accounts:scope": (id, result) => field(id, result, "scopeKey", key),
  "accounts:assign": (id, result) => field(id, result, "scopeKey", key),
  "project:open": OPEN_PROJECT,
  "onboarding:clone": OPEN_PROJECT,
  "project:current": OPEN_PROJECT,
  "project:switch": OPEN_PROJECT,
  "project:read": OPEN_PROJECT,
  "canvas:open-project": OPEN_PROJECT,
  "chats:home": OPEN_PROJECT,
  "chats:ensure": OPEN_PROJECT,
  "project:recent": PROJECT_LIST,
  "project:known": PROJECT_LIST,
  "project:forget": PROJECT_LIST,
  "project:registry": PROJECT_LIST,
  "project:position": PROJECT_LIST,
  "link:list": (id, result) => each(id, result, withLink),
  "link:create": withLink,
  "link:update": withLink,
  "link:snapshot": (id, result) => field(id, result, "link", withLink),
  "link:open": (id, result) => (isObject(result) ? { ...field(id, result, "link", withLink), projects: each(id, result.projects, withPath) } : result),
  "project:snapshot": withPath,
  "chat:btw": withChat,
  "chat:btw-read": withChat,
  "chat:btw-stop": withChat,
  "chat:ports": withChat,
  "simulator:list": withChat,
  "simulator:attach": withChat,
  "simulator:detach": withChat,
  "chat:runs": (id, result) => field(id, result, "runs", keyed),
  "chat:inbox": (id, result) => {
    const item = (id, value) => field(id, field(id, value, "key", key), "projectPath", key);
    return { agents: each(id, result.agents, item), items: each(id, result.items, item) };
  },
  "agent:ports": keyed,
  "worktree:create": (id, result) => field(id, result, "project", withPath),
  "worktree:link-issue": (id, result) => field(id, result, "project", withPath),
  "worktree:unlink-issue": (id, result) => field(id, result, "project", withPath),
  "terminal:list": (id, result) => field(id, result, "terminals", (id, list) => each(id, list, withChat)),
  "terminal:open": withChat,
  "routines:list": (id, result) => field(id, result, "routines", (id, list) => each(id, list, withRoutine)),
  "routines:create": (id, result) => field(id, result, "routine", withRoutine),
  "routines:update": withRoutine,
  "routines:run-now": withRun,
  "routines:flow-act": (id, result) => field(id, result, "run", withRun),
  "routines:flow-test": (id, result) => field(id, result, "run", withRun),
  "routines:targets": (id, result) =>
    field(id, result, "projects", (id, list) =>
      each(id, list, (id, project) => field(id, withPath(id, project), "chats", (id, chats) => each(id, chats, withChat))),
    ),
  "design-library:list": (id, result) =>
    field(id, result, "pages", (id, pages) =>
      each(id, pages, (id, page) =>
        field(id, page, "designs", (id, designs) => each(id, designs, (id, design) => field(id, design, "edits", (id, edits) => each(id, edits, withChat)))),
      ),
    ),
  "design-library:add": (id, result) => field(id, result, "edits", (id, edits) => each(id, edits, withChat)),
  "design-library:update": (id, result) => field(id, result, "edits", (id, edits) => each(id, edits, withChat)),
  "accounts:scopes": (id, result) =>
    each(id, result, (id, scope) => field(id, field(id, scope, "key", key), "projects", (id, list) => each(id, list, withPath))),
};

const qualifyEvent = (computerId, channel, payload) => (EVENTS[channel] ? EVENTS[channel](computerId, payload) : payload);
const qualifyResult = (computerId, method, result) => (RESULTS[method] ? RESULTS[method](computerId, result) : result);

module.exports = { LOCAL_ONLY, LOCAL_ONLY_PREFIXES, NOT_REMOTE, isLocalOnly, ALIASES, stripComputer, qualifyEvent, qualifyResult };
