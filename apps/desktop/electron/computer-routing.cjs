const { qualifyKey } = require("@milagre/shared/chat-scopes");

// What only this Mac's own window does (spec "Routing": its editors and Finder, the folder dialog, image menus that read
// local paths, notification settings, updates), plus its own host, devices, accounts, canvas and Links across Projects.
// preload.cjs keeps the same two lists and refuses them before any IPC; computer-routing.test.cjs compares them.
const LOCAL_ONLY = Object.freeze([
  "project:open",
  "project:reveal",
  "skills:open",
  "skills:reveal",
  "runtime:connection",
  "runtime:restart-host",
  "accounts:list",
  "accounts:add",
  "accounts:select",
  "accounts:login",
  "accounts:cancel",
  "accounts:remove",
  "agent:update-cli",
  "linear:connect",
  "linear:cancel",
  "linear:disconnect",
]);
const LOCAL_ONLY_PREFIXES = Object.freeze([
  "app:",
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
  "usage:",
]);
const NOT_REMOTE = "Not available on a remote computer";
/** @param {string} channel */
const isLocalOnly = (channel) => LOCAL_ONLY.includes(channel) || LOCAL_ONLY_PREFIXES.some((prefix) => channel.startsWith(prefix));
// The window's names for calls whose daemon method is named otherwise: Add project's remote folder picker opens a path.
/** @type {Readonly<Record<string, string>>} */
const ALIASES = Object.freeze({ "project:open-at": "project:open" });

/**
 * A remote call's arguments without `${computerId}|` anywhere. Computer ids are UUIDs, so a UUID and a bar never appear
 * in a path, a chat key or a message by chance.
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
const withPath = (id, item) => field(id, item, "path", key);
const withChat = (id, item) => field(id, item, "chatId", key);
const withLink = (id, item) => field(id, item, "id", linkId);

/** @type {Record<string, (id: string, payload: any) => any>} */
const EVENTS = {
  "project:state": withPath,
  "link:state": (id, payload) => field(id, payload, "linkId", linkId),
  "agent:event": withChat,
  "terminal:changed": withChat,
  "notification:waiting": withChat,
  "worktree:renamed": (id, payload) => field(id, payload, "projectPath", key),
  "agent:ports": keyed,
  "main-sync:status": (id, payload) => field(id, payload, "projectPath", key),
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
const PROJECT_LIST = (id, result) => each(id, result, withPath);
/** @type {Record<string, (id: string, result: any) => any>} */
const RESULTS = {
  "project:open": OPEN_PROJECT,
  "project:current": OPEN_PROJECT,
  "project:switch": OPEN_PROJECT,
  "project:read": OPEN_PROJECT,
  "project:recent": PROJECT_LIST,
  "project:set-hidden": PROJECT_LIST,
  "project:forget": PROJECT_LIST,
  "project:registry": PROJECT_LIST,
  "project:position": PROJECT_LIST,
  "link:list": (id, result) => each(id, result, withLink),
  "link:create": withLink,
  "link:update": withLink,
  "link:snapshot": (id, result) => field(id, result, "link", withLink),
  "link:open": (id, result) => (isObject(result) ? { ...field(id, result, "link", withLink), projects: each(id, result.projects, withPath) } : result),
  "project:snapshot": withPath,
  "chat:ports": withChat,
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
  "accounts:scopes": (id, result) =>
    each(id, result, (id, scope) => field(id, field(id, scope, "key", key), "projects", (id, list) => each(id, list, withPath))),
};

/** A computer's event as the window keeps it: its Project paths, Link ids and chat keys name the computer. */
const qualifyEvent = (computerId, channel, payload) => (EVENTS[channel] ? EVENTS[channel](computerId, payload) : payload);
/** The same for one call's result. */
const qualifyResult = (computerId, method, result) => (RESULTS[method] ? RESULTS[method](computerId, result) : result);

module.exports = { LOCAL_ONLY, LOCAL_ONLY_PREFIXES, NOT_REMOTE, isLocalOnly, ALIASES, stripComputer, qualifyEvent, qualifyResult };
