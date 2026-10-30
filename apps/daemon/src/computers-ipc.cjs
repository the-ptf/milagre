const { ALIASES, NOT_REMOTE, isLocalOnly, qualifyEvent, qualifyResult, stripComputer } = require("./computer-routing.cjs");

// Kept as they pass (main sees whole lists and the states a Project opens with); the window forwards the rest.
const KEPT_LISTS = { "project:recent": "recent", "project:known": "known", "link:list": "links", "project:registry": "registry" };
// Routines' reads, kept whole: a computer away shows its last list. Writes and webhook URLs (secrets) are never kept.
const KEPT_OBJECTS = {
  "routines:enabled:read": "routines-enabled",
  "routines:list": "routines",
  "routines:targets": "routine-targets",
  // Where its Chats home is, so its project-less Chats stay listed while it is away.
  "chats:home": "chats-home",
};
const OPENED = new Set(["project:read", "project:switch", "project:open", "project:current", "chats:ensure"]);
// What a window reads that a computer's last copy can answer while it is away.
const MAX_REMEMBERED_CHARS = 32 * 1024 * 1024;
const nameOf = (projectPath, recent) =>
  recent?.find?.((project) => project.path === projectPath)?.name ?? projectPath.split("/").findLast(Boolean) ?? projectPath;

/** A read answered from the cache, or null when the cache can't answer it. A chat with no copy reads empty, never pending. */
function readOffline(cache, id, method, args) {
  if (KEPT_LISTS[method]) return cache.get(id, KEPT_LISTS[method], "") ?? [];
  if (KEPT_OBJECTS[method]) return cache.get(id, KEPT_OBJECTS[method], "") ?? null;
  if (OPENED.has(method)) {
    const scope = args[0];
    const kept = typeof scope === "string" ? cache.get(id, "scope", scope) : null;
    // The copy keeps no `kind`; the home's last known path says which scope is the Chats home.
    const home = kept && cache.get(id, "chats-home", "")?.path === scope;
    return kept ? { path: scope, name: kept.name, ...(home ? { kind: "chats" } : {}), state: kept.state } : null;
  }
  if (method === "link:snapshot" || method === "link:open") {
    const kept = typeof args[0] === "string" ? cache.get(id, "scope", `milagre-link:${args[0]}`) : null;
    if (!kept) return null;
    const link = { id: args[0], name: kept.name, projectIds: [], createdAt: "" };
    return method === "link:open" ? { link, state: kept.state, projects: [] } : { link, state: kept.state };
  }
  if (method === "chat:messages") {
    const [scope, chatId, options] = args;
    const kept = typeof scope === "string" ? cache.get(id, "chat", `${scope}#${chatId}`) : null;
    if (options?.before !== undefined) return { messages: [], hasMore: false, total: kept?.total ?? 0 };
    return kept ? { messages: kept.messages, hasMore: false, total: kept.total } : { messages: [], hasMore: false, total: 0 };
  }
  if (method === "chat:runs") return { runs: {}, seq: 0 };
  if (method === "agent:ports") return {};
  return null;
}

/**
 * The window's side of computers.cjs (spec "This Mac (Electron main) › Computers"): the IPC the preload's
 * window.milagre.computers calls, the list pushed to every window after each change (computers:changed), and each
 * computer's runtime events, tagged with its id (computers:event). `send(channel, payload)` reaches every window.
 * @param {{
 *   ipcMain: { handle: (channel: string, handler: (event: any, ...args: any[]) => any) => void };
 *   computers: any;
 *   thisMac: () => string;
 *   cache?: any;
 *   send: (channel: string, payload: unknown) => void;
 *   onRemoteEvent?: (computerId: string, channel: string, payload: any) => void;
 *   onForget?: (computerId: string) => void;
 * }} options
 */
function registerComputers({ ipcMain, computers, thisMac, send, cache = null, onRemoteEvent = () => {}, onForget = () => {} }) {
  // A cache that fails never fails a call, but it says so once per computer and kind of error.
  const warned = new Set();
  const warn = (computerId, error) => {
    const kind = String(error?.code ?? error?.name ?? "error");
    if (warned.has(`${computerId}\n${kind}`)) return;
    warned.add(`${computerId}\n${kind}`);
    console.warn(`Computer ${computerId}: its offline copy failed (${kind}): ${error instanceof Error ? error.message : String(error)}`);
  };
  const paired = (computerId) => computers.list().some((item) => item.id === computerId);
  const snapshot = () => ({ thisMac: thisMac(), computers: computers.list() });
  // An opened scope's copy waiting to be written after its answer, by computer and scope: a newer one replaces it, and a
  // state the window remembers meanwhile (computers:remember) is newer still, so the waiting copy is dropped.
  /** @type {Map<string, object>} */
  const waiting = new Map();

  ipcMain.handle("computers:list", async () => {
    await computers.loaded;
    return snapshot();
  });
  ipcMain.handle("computers:preview", (_event, link) => computers.preview(link));
  // Electron keeps only an error's message across IPC; Add computer needs its code too ("cancelled" says nothing).
  ipcMain.handle("computers:add", async (event, link, options) => {
    try {
      const computer = await computers.add(
        link,
        { name: typeof options?.name === "string" ? options.name : undefined },
        {
          onPending: () => {
            if (!event.sender.isDestroyed()) event.sender.send("computers:pending");
          },
        },
      );
      return { ok: true, computer };
    } catch (error) {
      const code = /** @type {any} */ (error)?.code;
      return {
        ok: false,
        code: typeof code === "string" ? code : "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });
  ipcMain.handle("computers:cancel-add", () => computers.cancelAdd());
  ipcMain.handle("computers:rename", async (_event, id, name) => {
    await computers.rename(String(id), String(name ?? ""));
    return snapshot();
  });
  ipcMain.handle("computers:remove", async (_event, id) => {
    await computers.remove(String(id));
    onForget(String(id));
    await cache?.remove(String(id)).catch(() => {});
    return snapshot();
  });
  ipcMain.handle("computers:set-enabled", async (_event, on) => {
    const ids = computers.list().map((item) => item.id);
    await computers.setEnabled(on === true);
    // Switched off, no computer reports any more: what it was waiting on must not keep the dock badge up.
    if (on !== true) for (const id of ids) onForget(id);
  });
  // One call on a computer: this Mac's own actions are refused, its id leaves the arguments, and what comes back names it.
  ipcMain.handle("computers:invoke", async (_event, id, channel, args) => {
    const computerId = String(id);
    const name = String(channel);
    if (isLocalOnly(name)) throw new Error(NOT_REMOTE);
    const method = ALIASES[name] ?? name;
    const bare = stripComputer(computerId, Array.isArray(args) ? args : []);
    const computer = computers.list().find((item) => item.id === computerId);
    // Away (or off): its last copy answers what it can; nothing is sent. Connecting or reconnecting is a blip: what the
    // copy can't answer (a message, an approval) waits for the computer to be back instead of failing as offline.
    const blip = computer?.state === "connecting" || computer?.state === "reconnecting";
    if (computer && computer.state !== "online") {
      let kept = null;
      // An unreadable copy is deleted by the cache, so a second look reads as no copy.
      for (let attempt = 0; attempt < (cache ? 2 : 0) && kept === null; attempt++) {
        try {
          kept = readOffline(cache, computerId, method, bare);
          break;
        } catch (error) {
          warn(computerId, error);
        }
      }
      if (kept !== null) {
        // A Project opened from the last copy can be hours old, and nothing on screen says so.
        if (OPENED.has(method)) console.log(`computers: ${computerId} ${method} ${bare[0]} answered from its offline copy (${computer.state})`);
        return qualifyResult(computerId, method, kept);
      }
      if (!blip) throw new Error(`${computer.name} is offline.`);
    }
    const result = await computers.invoke(computerId, method, bare);
    // The copy is written once the answer is on its way: a Project's state is megabytes to serialize and write.
    const scope = cache && OPENED.has(method) && result?.state && typeof result.path === "string" ? `${computerId}\n${result.path}` : null;
    const mark = {};
    if (scope) waiting.set(scope, mark);
    if (cache && (KEPT_LISTS[method] || KEPT_OBJECTS[method] || scope))
      setImmediate(() => {
        const current = scope !== null && waiting.get(scope) === mark;
        if (current) waiting.delete(scope);
        // Removed while the call was out: its folder stays gone.
        if (!paired(computerId)) return;
        try {
          if (KEPT_LISTS[method] && Array.isArray(result)) cache.put(computerId, KEPT_LISTS[method], "", result);
          if (KEPT_OBJECTS[method] && result && typeof result === "object") cache.put(computerId, KEPT_OBJECTS[method], "", result);
          if (current)
            cache.put(computerId, "scope", result.path, { name: result.name ?? nameOf(result.path, cache.get(computerId, "recent", "")), state: result.state });
        } catch (error) {
          warn(computerId, error); // the cache is a copy: a failed write never fails the call
        }
      });
    return qualifyResult(computerId, method, result);
  });
  // The window forwards a remote scope's whole state and a chat's window as they change (offline-cache.ts).
  ipcMain.handle("computers:remember", (_event, id, entry) => {
    const computerId = String(id);
    if (!cache || !entry || typeof entry !== "object" || typeof entry.scope !== "string" || !paired(computerId)) return;
    const scope = stripComputer(computerId, entry.scope);
    try {
      if (entry.kind === "state" && entry.state && typeof entry.state === "object") {
        waiting.delete(`${computerId}\n${scope}`);
        const recent = cache.get(computerId, "recent", "");
        const text = JSON.stringify({ name: nameOf(scope, recent), state: stripComputer(computerId, entry.state) });
        if (text.length <= MAX_REMEMBERED_CHARS) cache.put(computerId, "scope", scope, null, text);
      } else if (entry.kind === "chat" && Number.isSafeInteger(entry.chatId) && Array.isArray(entry.window?.messages)) {
        const text = JSON.stringify({
          messages: entry.window.messages.slice(-200),
          hasMore: Boolean(entry.window.hasMore),
          total: Number(entry.window.total) || entry.window.messages.length,
        });
        if (text.length <= MAX_REMEMBERED_CHARS) cache.put(computerId, "chat", `${scope}#${entry.chatId}`, null, text);
      }
    } catch (error) {
      warn(computerId, error);
    }
  });

  // A window's note about a computer's scope (an open whose copy lacked the Chat it opened), for daemon.log: the window
  // keeps no log of its own.
  ipcMain.handle("computers:note", (_event, id, line) => {
    if (typeof line === "string" && line) console.log(`computers: ${String(id)} ${line.slice(0, 500)}`);
  });

  // A chat's last copy, for the window to paint while the computer answers (chat-messages.ts). Older turns are never
  // kept, so the copy stands alone until the real window replaces it.
  ipcMain.handle("computers:recall", (_event, id, entry) => {
    const computerId = String(id);
    if (!cache || !entry || entry.kind !== "chat" || typeof entry.scope !== "string" || !Number.isSafeInteger(entry.chatId) || !paired(computerId)) return null;
    try {
      const kept = cache.get(computerId, "chat", `${stripComputer(computerId, entry.scope)}#${entry.chatId}`);
      if (!Array.isArray(kept?.messages)) return null;
      return qualifyResult(computerId, "chat:messages", { messages: kept.messages, hasMore: false, total: kept.total });
    } catch (error) {
      warn(computerId, error);
      return null;
    }
  });

  return {
    changed: () => send("computers:changed", snapshot()),
    /** @param {string} computerId @param {string} channel @param {unknown} payload */
    event: (computerId, channel, payload) => {
      const named = qualifyEvent(computerId, channel, payload);
      try {
        onRemoteEvent(computerId, channel, named);
      } catch {
        /* a listener must not stop the window hearing it */
      }
      send("computers:event", { computerId, channel, payload: named });
    },
  };
}

module.exports = { registerComputers };
