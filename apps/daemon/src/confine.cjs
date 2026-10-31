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
const HIDDEN_STATUS = ["dataDir", "socketPath", "pid", "uid", "methods", "commandDefinitions", "desktopCommands"];
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
// The Project a Routine runs in, or null when its target names none.
const routineProject = (routine) => {
  const target = routine?.target;
  if (target?.kind === "new-chat") return target.projectPath;
  if (target?.kind === "chat") return chatProject(target.chatId);
  return null;
};
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
  "simulator:frame": denySimulator,
  "simulator:status": denySimulator,
  "simulator:control": denySimulator,
  "simulator:input": denySimulator,
  "simulator:repair": denySimulator,
  "simulator:close": denySimulator,
  // Computer use drives the owner's own desktop apps. A demo Project never reaches it.
  "computer-use:settings:read": denied,
  "computer-use:settings:save": denied,
  "computer-use:status": denied,
  "computer-use:guide": denied,
  // Simlock leases run on the owner's machines with the owner's token. A demo Project never reaches them.
  "simlock:settings:read": denySimulator,
  "simlock:settings:save": denySimulator,
  "simlock:identity": denySimulator,
  "simlock:models": denySimulator,
  "simlock:lease": denySimulator,
  "simlock:release": denySimulator,
  // Browsers on the host can hold the owner's signed-in sessions. A demo Project never reaches them.
  "browser:list": denied,
  "browser:attach": denied,
  "browser:open": denied,
  "browser:open-page": denied,
  "browser:frame": denied,
  "browser:status": denied,
  "browser:control": denied,
  "browser:input": denied,
  "browser:close": denied,
  // A Terminal runs any command as the owner of this computer. A demo Project never opens one.
  "terminal:list": denied,
  "terminal:profiles": denied,
  "terminal:setShell": denied,
  "terminal:open": denied,
  "terminal:read": denied,
  "terminal:input": denied,
  "terminal:resize": denied,
  "terminal:close": denied,
  // A design is read through its Chat, which must be in the folder.
  "artifact:get": ([value]) => [chatProject(value?.chatId)],
  "artifact:asset": ([value]) => [chatProject(value?.chatId)],
  "artifact:apply": denied,
  "artifact:delete": denied,
  "artifact:list": ([value]) => [chatProject(value?.chatId)],
  "artifact:page-shares": ([value]) => [chatProject(value?.chatId)],
  "artifact:sharing-status": denied,
  "artifact:all-page-shares": denied,
  "artifact:share-page": denied,
  "artifact:revoke-page-share": denied,
  "artifact:revoke-saved-page-share": denied,
  "artifact:add-comments": ([value]) => [chatProject(value?.chatId)],
  "artifact:comments": ([value]) => [chatProject(value?.chatId)],
  // Page comments are read through their Chat, which must be in the folder. Sending one reads the page under the
  // pin, a desktop browser page, and a confined phone sees no browser pages.
  "browser-comments:list": ([value]) => [chatProject(value?.chatId)],
  "browser-comments:send-from-page": denied,
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
  "project:known": none,
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
  // The Chats home is the Mac's own folder, outside any demo folder.
  "chats:home": denied,
  "chats:ensure": denied,
  // Takes a Project off the recent list; its folder is never touched.
  "project:forget": ([projectPath]) => [projectPath],
  // The search names no path; its results are cut down to the folder (filterResult).
  "project:find": none,
  "project:image": ([projectPath]) => [projectPath],
  "project:set-icon": ([projectPath]) => [projectPath],
  "main-sync:read": ([projectPath]) => [projectPath],
  "main-sync:save": ([projectPath]) => [projectPath],
  // The global default names no folder. Changing it reaches every Project on the Mac, so a confined phone only reads it.
  "main-sync:default:read": none,
  "main-sync:default:save": denied,
  // The Mac's Linear connection names no folder. A confined phone reads it; the switches reach every Project, so it can't flip them.
  "linear:status": none,
  // A triage session names the host's profile and every agent CLI, beyond a confined demo folder.
  "triage:prepare": denied,
  "linear:enabled:read": none,
  "linear:enabled:save": denied,
  "designs:enabled:read": none,
  "designs:enabled:save": denied,
  "linear:move-to-started:save": denied,
  // Auto-switch after a usage limit names no folder and reaches every Project's accounts: a confined phone only reads it.
  "limits:auto-switch:read": none,
  "limits:auto-switch:save": denied,
  // Auto update restarts the whole Mac's Milagre: a confined phone only reads the switch.
  "app-update:auto:read": none,
  // Memory and disk totals name no folder.
  "computer:resources:read": none,
  "app-update:auto:save": denied,
  // The desktop app's update names no folder. A confined phone sees it; a check or an install restarts the whole Mac's
  // Milagre, so it starts neither.
  "app-update:state": none,
  "app-update:check": denied,
  "app-update:install": denied,
  // The Browser panel's sign-ins name no folder. A confined phone sees whose there are; signing out reaches every
  // Chat's pages on the Mac, so it can't.
  "browser:sign-ins": none,
  "browser:sign-ins:clear": denied,
  // Keybindings name no folder: a confined phone reads the rules of the Mac it is paired with and can't change them.
  "keybindings:read": none,
  "keybindings:set-command": denied,
  "keybindings:reset-command": denied,
  "keybindings:reset": denied,
  // Babysit PRs settings name no folder, but their level and instructions go into every future babysit Run in every Chat
  // on the Mac: a confined phone only reads them.
  "context:settings:read": none,
  "context:settings:save": denied,
  "babysit:settings:read": none,
  "babysit:settings:save": denied,
  // How long Done Chats wait before archiving applies to every Project on the Mac: a confined phone only reads it.
  "done:settings:read": none,
  "done:settings:save": denied,
  // Routines send prompts into any Chat on the Mac: a confined phone sees its own Project's (filterResult) and the switch,
  // and changes nothing.
  "routines:enabled:read": none,
  "routines:list": none,
  "routines:targets": none,
  // The owner's Linear workspaces, teams, labels and states feed only the form a confined phone can't save.
  "routines:linear-options": denied,
  "routines:enabled:save": denied,
  "routines:update": denied,
  "routines:delete": denied,
  "routines:run-now": denied,
  "routines:create": denied,
  // A webhook URL reaches this Mac from anywhere: a confined phone neither reads nor makes one.
  "routines:hook": denied,
  "routines:rotate-hook": denied,
  // Issues name no folder. A Project's worktree issues name the Project's folder, like its other reads.
  "linear:issues": none,
  "linear:worktree-issues": ([projectPath]) => [projectPath],
  "chat:runs": none,
  "chat:send-status": ([projectPath]) => [projectPath],
  "chat:inbox": none,
  "checkpoint:list": ([value]) => [chatProject(value?.chatId)],
  "checkpoint:preview": ([value]) => [chatProject(value?.chatId)],
  "checkpoint:restore": ([value]) => [chatProject(value?.chatId)],
  "chat:ports": ([chatId]) => [chatProject(chatId)],
  "agent:stop-port": ([chatId]) => [chatProject(chatId)],
  "chat:send": ([request]) => [
    request?.projectPath,
    ...(request?.cwd === undefined ? [] : [request.cwd]),
    ...(Array.isArray(request?.files) ? request.files.map(attached) : []),
  ],
  "chat:resume": ([projectPath]) => [projectPath],
  // Moves the Chat's Project to another account, like accounts:assign, then continues the Chat.
  "chat:limit-switch": ([projectPath]) => [projectPath],
  "advisor:stop": ([chatId]) => [chatProject(chatId)],
  "advisor:retry": ([chatId]) => [chatProject(chatId)],
  "agent:interrupt": ([chatId]) => [chatProject(chatId)],
  "chat:reload": ([chatId]) => [chatProject(chatId)],
  "chat:queue-send": ([chatId]) => [chatProject(chatId)],
  "chat:queue-remove": ([chatId]) => [chatProject(chatId)],
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
  "mcp:definition": none,
  "mcp:saveUrl": none,
  "mcp:remove": none,
  "mcp:toggle": none,
  // Local connection grants are computer-wide and must never be issued by a confined demo.
  "local-mcp:status": denied,
  "local-mcp:create": denied,
  "local-mcp:update": denied,
  "local-mcp:rotate": denied,
  "local-mcp:revoke": denied,
  "local-mcp:enableClient": denied,
  "local-mcp:disableClient": denied,
  "usage:read": (args) => (args[0] == null ? [] : [args[0]]),
  // Token usage names every Project and folder an agent ran in on the Mac.
  "token-usage:read": denied,
  "usage:cached": (args) => (args[0] == null ? [] : [args[0]]),
  "agent:answer-question": ([value]) => [chatProject(value?.chatId)],
  "agent:set-permission-mode": ([value]) => [chatProject(value?.chatId)],
  "agent:models": (args) => (args[0] == null ? [] : [args[0]]),
  "agent:provider-updates": () => [],
  "agent:update-cli": denied,
  "agent:cli-status": (args) => (args[0] == null ? [] : [args[0]]),
  "scope:retry-save": ([scope]) => [scope],
  "chat:patch": ([projectPath]) => [projectPath],
  "chat:delete": ([projectPath]) => [projectPath],
  "chat:archive-subagent": ([projectPath]) => [projectPath],
  "chat:archive-finished-subagents": ([projectPath]) => [projectPath],
  "chat:subagent": ([projectPath]) => [projectPath],
  "chat:task-output": ([chatId]) => [chatProject(chatId)],
  "worktree:pull-request": ([worktreePath]) => [worktreePath],
  "worktree:pull-requests": ([worktreePath]) => [worktreePath],
  "project:branches": ([projectPath]) => [projectPath],
  "attachment:preview": ([file]) => [attached(file)],
  "attachment:read": ([file]) => [attached(file)],
  // A null Project (user skills only) is refused: confined, the phone sees no user skills.
  "skills:list": ([projectPath]) => [projectPath],
  // The file search for the phone's @ menu: the root must be inside the folder; it names no other path.
  "project:files": ([root]) => [root],
  "skills:read": ([projectPath, file]) => [projectPath, file],
  "dictation:context": ([value]) => [value?.cwd],
  "dictation:polish": ([value]) => [value?.cwd],
  "worktree:create": ([value]) => [value?.projectPath],
  "worktree:link-issue": ([value]) => [value?.projectPath],
  "worktree:unlink-issue": ([value]) => [value?.projectPath],
  "git:history": ([value]) => [value?.cwd],
  "git:diff-files": ([value]) => [value?.cwd],
  "git:diff-file": ([value]) => [value?.cwd],
  "pr:detail": ([value]) => [value?.cwd],
  "pr:diff-files": ([value]) => [value?.cwd],
  "pr:diff-file": ([value]) => [value?.cwd],
  "pr:comment": ([value]) => [value?.cwd],
  "pr:reply": ([value]) => [value?.cwd],
  "pr:delete-comment": ([value]) => [value?.cwd],
  "pr:submit-review": ([value]) => [value?.cwd],
  "pr:resolve-thread": ([value]) => [value?.cwd],
  "pr:merge": ([value]) => [value?.cwd],
  "pr:ready": ([value]) => [value?.cwd],
  "pr:image": ([value]) => [value?.cwd],
  "pr:labels": ([value]) => [value?.cwd],
  "pr:set-labels": ([value]) => [value?.cwd],
  "pr:reviewer-candidates": ([value]) => [value?.cwd],
  "pr:request-reviewers": ([value]) => [value?.cwd],
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
    if (method.startsWith("accounts:") || method === "chat:limit-switch" || method === "limits:auto-switch:save")
      throw failure(403, "Accounts cannot be changed on this demo computer.");
    if (method.startsWith("mcp:")) throw failure(403, MCP_REFUSED);
    if (method === "push:register") throw failure(403, NOTIFICATIONS_OFF);
    if (method === "push:unregister") return { result: { registered: false } };
    if (method === "push:focus") return { result: null };
    if (method === "chat:send") args = [sendRequest(args[0])];
    // The daemon reads only the Projects inside the folder for it, so the phone never makes it read another one.
    if (method === "routines:targets") args = [{ within: await realRoot() }];
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
    if ((method === "project:recent" || method === "project:known" || method === "project:find") && Array.isArray(result)) {
      const kept = await Promise.all(result.map((entry) => allows(entry?.path)));
      return result.filter((_entry, index) => kept[index]);
    }
    if (method === "chat:runs" && result && typeof result === "object" && result.runs && typeof result.runs === "object") {
      const entries = Object.entries(result.runs);
      const kept = await Promise.all(entries.map(([chatId]) => allows(chatProject(chatId))));
      return { ...result, runs: Object.fromEntries(entries.filter((_entry, index) => kept[index])) };
    }
    // A Routine shows only when the Project it runs in (a new Chat's, or its Chat's) is inside the folder. One whose Project
    // can't be told (a Link's Chat, a folder that's gone, a target it doesn't know) stays hidden.
    if (method === "routines:list" && result && Array.isArray(result.routines)) {
      const kept = await Promise.all(result.routines.map((routine) => allows(routineProject(routine))));
      return { ...result, routines: result.routines.filter((_routine, index) => kept[index]) };
    }
    if (method === "routines:targets" && result && Array.isArray(result.projects)) {
      const kept = await Promise.all(result.projects.map((project) => allows(project?.path)));
      return { ...result, projects: result.projects.filter((_project, index) => kept[index]) };
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
