const fs = require("node:fs/promises");
const path = require("node:path");
const { projectOfKey } = require("@milagre/shared/agent-runs");

const REFUSED = "This demo computer only opens its demo project.";
const MCP_REFUSED = "MCP servers are not shown on this demo computer.";
const NOTIFICATIONS_OFF = "Notifications are off on the demo computer.";
const TOO_LONG = "Messages to the demo computer are limited to 64 KB.";
// A message body, in UTF-8 bytes.
const MAX_BODY = 64 * 1024;
// What daemon:status says about the Mac itself, left out for a confined phone.
const HIDDEN_STATUS = ["dataDir", "socketPath", "pid", "uid", "methods"];
const failure = (status, message) => Object.assign(new Error(message), { status });
const refused = () => failure(403, REFUSED);
const inside = (root, target) => target === root || target.startsWith(root + path.sep);
const realOrNull = async (file) => {
  try {
    return await fs.realpath(file);
  } catch {
    return null;
  }
};

const chatProject = (chatId) => (typeof chatId === "string" ? projectOfKey(chatId) : null);
// A file the phone attached: inside the folder, or one it uploaded itself.
const attached = (file) => ({ file });
const none = () => [];
const denySimulator = () => {
  throw refused();
};
const denied = () => {
  throw refused();
};

/**
 * The paths in each command the phone may call, by argument shape (see core's runtime). A command missing here is
 * refused while the bridge is confined, so a command added to the bridge later stays closed until it is listed.
 */
const PATHS = Object.freeze({
  // Simulators are machine-wide. A demo Project never grants access to the host's devices.
  "simulator:list": denySimulator,
  "simulator:attach": denySimulator,
  "simulator:detach": denySimulator,
  "simulator:open": denySimulator,
  "simulator:offer": denySimulator,
  "simulator:status": denySimulator,
  "simulator:control": denySimulator,
  "simulator:input": denySimulator,
  "simulator:repair": denySimulator,
  "simulator:close": denySimulator,
  // Browsers on the host can hold the owner's signed-in sessions. A demo Project never reaches them.
  "browser:list": denied,
  "browser:attach": denied,
  "browser:open": denied,
  "browser:frame": denied,
  "browser:status": denied,
  "browser:control": denied,
  "browser:input": denied,
  "browser:close": denied,
  // A Terminal runs any command as the owner of this computer. A demo Project never opens one.
  "terminal:list": denied,
  "terminal:open": denied,
  "terminal:read": denied,
  "terminal:input": denied,
  "terminal:resize": denied,
  "terminal:close": denied,
  // A design is read through its Chat, which must be in the folder.
  "artifact:get": ([value]) => [chatProject(value?.chatId)],
  "artifact:list": ([value]) => [chatProject(value?.chatId)],
  "artifact:add-comments": ([value]) => [chatProject(value?.chatId)],
  "artifact:comments": ([value]) => [chatProject(value?.chatId)],
  // Live Activities summarize every open Project and Link, beyond a confined demo folder.
  "live-activity:state": denied,
  "live-activity:open": denied,
  "live-activity:answer": denied,
  "live-activity:forget": denied,
  "push:register": none,
  "push:unregister": none,
  "push:focus": ([value]) => (value?.chatId === null || value?.chatId === undefined ? [] : [chatProject(value.chatId)]),
  "daemon:status": none,
  "project:recent": none,
  // Named Links span Projects. The single-folder demo must never expose them.
  "project:registry": denied,
  // Canvas Links reach other Projects too, so the demo has none.
  "canvas:links": denied,
  "canvas:link-add": denied,
  "canvas:link-remove": denied,
  "linked:grant": denied,
  "link:list": denied,
  "link:create": denied,
  "link:update": denied,
  "link:open": denied,
  "link:send": denied,
  "project:open": ([projectPath]) => [projectPath],
  // Takes a Project off the recent list; its folder is never touched.
  "project:forget": ([projectPath]) => [projectPath],
  // The search names no path; its results are cut down to the folder (filterResult).
  "project:find": none,
  "project:image": ([projectPath]) => [projectPath],
  "project:set-icon": ([projectPath]) => [projectPath],
  "project:set-hidden": ([projectPath]) => [projectPath],
  "main-sync:read": ([projectPath]) => [projectPath],
  "main-sync:save": ([projectPath]) => [projectPath],
  // The global default names no folder. Changing it reaches every Project on the Mac, so a confined phone only reads it.
  "main-sync:default:read": none,
  "main-sync:default:save": denied,
  // The Mac's Linear connection names no folder. A confined phone reads it; the switches reach every Project, so it can't flip them.
  "linear:status": none,
  "linear:enabled:read": none,
  "linear:enabled:save": denied,
  "linear:move-to-started:save": denied,
  // Issues name no folder. A Project's worktree issues name the Project's folder, like its other reads.
  "linear:issues": none,
  "linear:worktree-issues": ([projectPath]) => [projectPath],
  "chat:runs": none,
  "chat:inbox": none,
  "chat:ports": ([chatId]) => [chatProject(chatId)],
  "agent:stop-port": ([chatId]) => [chatProject(chatId)],
  "chat:send": ([request]) => [
    request?.projectPath,
    ...(request?.cwd === undefined ? [] : [request.cwd]),
    ...(Array.isArray(request?.files) ? request.files.map(attached) : []),
  ],
  "chat:resume": ([projectPath]) => [projectPath],
  "advisor:stop": ([chatId]) => [chatProject(chatId)],
  "advisor:retry": ([chatId]) => [chatProject(chatId)],
  "agent:interrupt": ([chatId]) => [chatProject(chatId)],
  "agent:respond-permission": ([value]) => [chatProject(value?.chatId)],
  "accounts:scopes": none,
  "accounts:scope": none,
  "accounts:assign": none,
  "accounts:list": none,
  "accounts:add": none,
  "accounts:select": none,
  "accounts:login": none,
  "accounts:cancel": none,
  "accounts:remove": none,
  "mcp:accounts": none,
  "mcp:check": none,
  "usage:read": (args) => (args[0] == null ? [] : [args[0]]),
  "usage:cached": (args) => (args[0] == null ? [] : [args[0]]),
  "agent:answer-question": ([value]) => [chatProject(value?.chatId)],
  "agent:set-permission-mode": ([value]) => [chatProject(value?.chatId)],
  "agent:models": (args) => (args[0] == null ? [] : [args[0]]),
  "agent:cli-status": (args) => (args[0] == null ? [] : [args[0]]),
  "chat:patch": ([projectPath]) => [projectPath],
  "chat:archive-subagent": ([projectPath]) => [projectPath],
  "chat:archive-finished-subagents": ([projectPath]) => [projectPath],
  "worktree:pull-request": ([worktreePath]) => [worktreePath],
  "worktree:pull-requests": ([worktreePath]) => [worktreePath],
  "project:branches": ([projectPath]) => [projectPath],
  "attachment:preview": ([file]) => [attached(file)],
  // A null Project (user skills only) is refused: confined, the phone sees no user skills.
  "skills:list": ([projectPath]) => [projectPath],
  "skills:read": ([projectPath, file]) => [projectPath, file],
  "worktree:create": ([value]) => [value?.projectPath],
  "worktree:link-issue": ([value]) => [value?.projectPath],
  "worktree:unlink-issue": ([value]) => [value?.projectPath],
  "git:diff-files": ([value]) => [value?.cwd],
  "git:diff-file": ([value]) => [value?.cwd],
  // The roots name no path the phone sent; the answer is cut down to the folder (filterResult).
  "worktree:roots": none,
  "worktree:status": ([worktreePath]) => [worktreePath],
  // The worktree, its project, and the Chat whose agent the daemon closes before it looks again.
  "worktree:remove": ([worktreePath, options]) => [worktreePath, options?.projectPath, ...(options?.chatId === undefined ? [] : [chatProject(options.chatId)])],
});

/**
 * Keeps a paired phone inside one folder: every project path, worktree path, cwd and file path it sends must already
 * be canonical (equal to its realpath, so no `..`, `.` or symlink in it) and inside `allowedRoot`. Files the phone
 * uploaded itself (`uploadsDir`) may also be attached and shown. Anything else is a 403.
 */
function createConfinement({ allowedRoot, uploadsDir }) {
  if (typeof allowedRoot !== "string" || !path.isAbsolute(allowedRoot)) throw new Error("allowedRoot must be an absolute path");
  let root;
  const realRoot = async () => {
    root ??= await fs.realpath(allowedRoot).catch(() => {
      throw new Error(`allowedRoot does not exist: ${allowedRoot}`);
    });
    return root;
  };

  /** Whether `target` resolves inside the folder (or, with `uploads`, inside the phone's own uploads). */
  async function allows(target, { uploads = false } = {}) {
    if (typeof target !== "string" || !path.isAbsolute(target) || target.includes("\0")) return false;
    const real = await realOrNull(target);
    if (!real || real !== target) return false;
    if (inside(await realRoot(), real)) return true;
    if (!uploads || !uploadsDir) return false;
    const uploadsReal = await realOrNull(uploadsDir);
    return Boolean(uploadsReal && inside(uploadsReal, real));
  }

  async function check(target, options) {
    if (!(await allows(target, options))) throw refused();
  }

  /**
   * Checks a command before it reaches the daemon. Resolves to `{ args }` to forward (possibly cleaned), or to
   * `{ result }` when the bridge answers it itself; throws a 403 (or 400, 413) otherwise.
   */
  async function checkCall(method, args) {
    const paths = PATHS[method];
    if (!paths || !Array.isArray(args)) throw refused();
    // No push device is ever registered, so there is nothing to unregister or focus, and no daemon state to grow.
    if (method === "accounts:list") return { result: { providers: [] } };
    if (method === "accounts:scopes") return { result: [] };
    if (method.startsWith("accounts:")) throw failure(403, "Accounts cannot be changed on this demo computer.");
    if (method.startsWith("mcp:")) throw failure(403, MCP_REFUSED);
    if (method === "push:register") throw failure(403, NOTIFICATIONS_OFF);
    if (method === "push:unregister") return { result: { registered: false } };
    if (method === "push:focus") return { result: null };
    if (method === "chat:send") args = [sendRequest(args[0])];
    for (const item of paths(args)) {
      if (item && typeof item === "object" && "file" in item) await check(item.file, { uploads: true });
      else await check(item);
    }
    return { args };
  }

  /**
   * What a command answers, cut down to the folder: the recent list, the turns running elsewhere, the worktree roots
   * outside it and what the daemon says about the Mac. A project:open that landed outside the folder (a subfolder of a bigger repository) is refused.
   */
  async function filterResult(method, result) {
    if (method === "skills:list" && result && Array.isArray(result.skills)) {
      const kept = await Promise.all(result.skills.map((skill) => skill.scope === "bundled" || (skill.scope === "workspace" && allows(skill.path))));
      return {
        skills: result.skills.filter((_skill, index) => kept[index]).map((skill) => (skill.scope === "bundled" ? { ...skill, path: "" } : skill)),
        shadowed: [],
        warnings: [],
      };
    }
    if (method === "daemon:status" && result && typeof result === "object") {
      const kept = { ...result };
      for (const key of HIDDEN_STATUS) delete kept[key];
      return kept;
    }
    if (method === "project:open" && !(await allows(result?.path))) throw refused();
    if (method === "worktree:roots" && Array.isArray(result)) {
      const kept = await Promise.all(result.map((root) => allows(root)));
      return result.filter((_root, index) => kept[index]);
    }
    if ((method === "project:recent" || method === "project:find") && Array.isArray(result)) {
      const kept = await Promise.all(result.map((entry) => allows(entry?.path)));
      return result.filter((_entry, index) => kept[index]);
    }
    if (method === "chat:runs" && result && typeof result === "object" && result.runs && typeof result.runs === "object") {
      const entries = Object.entries(result.runs);
      const kept = await Promise.all(entries.map(([chatId]) => allows(chatProject(chatId))));
      return { ...result, runs: Object.fromEntries(entries.filter((_entry, index) => kept[index])) };
    }
    if (method === "chat:inbox" && result) {
      const keep = async (items) => {
        const allowed = await Promise.all(items.map((item) => allows(chatProject(item.key))));
        return items.filter((_item, index) => allowed[index]);
      };
      return { agents: await keep(result.agents), items: await keep(result.items) };
    }
    return result;
  }

  return { allows, check, checkCall, filterResult, root: realRoot };
}

/** A chat:send request with a bounded body, a list of files, and images that carry their bytes but no Mac path. */
function sendRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw refused();
  if (typeof request.body === "string" && Buffer.byteLength(request.body) > MAX_BODY) throw failure(413, TOO_LONG);
  if (request.files !== undefined && !Array.isArray(request.files)) throw failure(400, "Attached files must be a list of paths.");
  if (request.images !== undefined && !Array.isArray(request.images)) throw failure(400, "Attached images must be a list.");
  const images = request.images?.map((image) => {
    if (!image || typeof image !== "object") return image;
    const { path: _path, sourcePath: _sourcePath, ...rest } = image;
    return rest;
  });
  return { ...request, ...(images ? { images } : {}) };
}

module.exports = { createConfinement, PATHS, REFUSED, MCP_REFUSED, NOTIFICATIONS_OFF, TOO_LONG, MAX_BODY };
