const fs = require("node:fs/promises");
const path = require("node:path");
const { projectOfKey } = require("@milagre/shared/agent-runs");

const REFUSED = "This demo computer only opens its demo project.";
const MCP_REFUSED = "MCP servers are not shown on this demo computer.";
const NOTIFICATIONS_OFF = "Notifications are off on the demo computer.";
const TOO_LONG = "Messages to the demo computer are limited to 64 KB.";
const MAX_BODY = 64 * 1024;
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
const designProject = (value) => (typeof value?.projectPath === "string" ? value.projectPath : chatProject(value?.chatId));
const routineProject = (routine) => {
  const target = routine?.target;
  if (target?.kind === "new-chat") return target.projectPath;
  if (target?.kind === "chat") return chatProject(target.chatId);
  return null;
};
const attached = (file) => ({ file });
const none = () => [];
const denySimulator = () => {
  throw refused();
};
const denied = () => {
  throw refused();
};

const PATHS = Object.freeze({
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
  "device-notes:read": denied,
  "device-notes:save": denied,
  "computer-use:settings:read": denied,
  "computer-use:settings:save": denied,
  "computer-use:status": denied,
  "computer-use:guide": denied,
  "computer-use:frame": denied,
  "baguette:status": denySimulator,
  "simlock:settings:read": denySimulator,
  "simlock:settings:save": denySimulator,
  "simlock:identity": denySimulator,
  "simlock:models": denySimulator,
  "simlock:lease": denySimulator,
  "simlock:release": denySimulator,
  "browser:list": denied,
  "browser:attach": denied,
  "browser:open": denied,
  "browser:open-page": denied,
  "browser:page-url": denied,
  "browser:release-page-url": denied,
  "browser:keep-page-url": denied,
  "browser:frame": denied,
  "browser:status": denied,
  "browser:control": denied,
  "browser:input": denied,
  "browser:close": denied,
  "terminal:list": denied,
  "terminal:profiles": denied,
  "terminal:setShell": denied,
  "terminal:open": denied,
  "terminal:read": denied,
  "terminal:input": denied,
  "terminal:resize": denied,
  "terminal:close": denied,
  "artifact:get": ([value]) => [designProject(value)],
  "artifact:asset": ([value]) => [chatProject(value?.chatId)],
  "artifact:delete": denied,
  "artifact:list": ([value]) => [chatProject(value?.chatId)],
  "artifact:page-shares": ([value]) => [chatProject(value?.chatId)],
  "artifact:sharing-status": denied,
  "artifact:all-page-shares": denied,
  "artifact:share-page": denied,
  "artifact:revoke-page-share": denied,
  "artifact:set-page-share-paused": denied,
  "artifact:revoke-saved-page-share": denied,
  "artifact:add-comments": ([value]) => [chatProject(value?.chatId)],
  "artifact:comments": ([value]) => [chatProject(value?.chatId)],
  "design-library:list": ([value]) => [designProject(value)],
  "design-library:chats": ([value]) => [designProject(value)],
  "design-system:read": ([value]) => [designProject(value)],
  "design-library:add": denied,
  "design-library:update": denied,
  "design-library:rename-page": denied,
  "browser-comments:list": ([value]) => [chatProject(value?.chatId)],
  "browser-comments:send-from-page": denied,
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
  "project:registry": denied,
  "canvas:links": denied,
  "canvas:link-add": denied,
  "canvas:link-remove": denied,
  "canvas:chat-mode": denied,
  "linked:grant": denied,
  "link:list": denied,
  "link:create": denied,
  "link:update": denied,
  "link:delete-check": denied,
  "link:delete": denied,
  "link:open": denied,
  "link:send": denied,
  "project:open": ([projectPath]) => [projectPath],
  "onboarding:clone": denied,
  "chats:home": denied,
  "chats:ensure": denied,
  "project:forget": ([projectPath]) => [projectPath],
  "project:find": none,
  "project:scan-children": ([folder]) => [folder],
  "folder-repos:detect:read": none,
  "folder-repos:detect:save": denied,
  "project:image": ([projectPath]) => [projectPath],
  "project:set-icon": ([projectPath]) => [projectPath],
  "project-git:read": ([projectPath]) => [projectPath],
  "project-git:save": ([projectPath]) => [projectPath],
  "project-validation:read": ([projectPath]) => [projectPath],
  "project-validation:save": ([projectPath]) => [projectPath],
  "main-sync:read": ([projectPath]) => [projectPath],
  "main-sync:save": ([projectPath]) => [projectPath],
  "main-sync:default:read": none,
  "main-sync:default:save": denied,
  "linear:status": none,
  "triage:prepare": denied,
  "linear:enabled:read": none,
  "linear:enabled:save": denied,
  "designs:enabled:read": none,
  "designs:enabled:save": denied,
  "linear:move-to-started:save": denied,
  "connectors:list": none,
  "connectors:check": denied,
  "connectors:remove": denied,
  "connectors:sign-out": denied,
  "connectors:access": denied,
  "connectors:tools": denied,
  "connectors:movable": denied,
  "connectors:moved": none,
  "connectors:dismiss-moved": denied,
  "limits:auto-switch:read": none,
  "limits:auto-switch:save": denied,
  "limits:resume-at-reset:read": none,
  "limits:resume-at-reset:save": denied,
  "app-update:auto:read": none,
  "computer:resources:read": none,
  "storage:worktrees": denied,
  "storage:remove-worktree": denied,
  "import:scan": denied,
  "import:run": denied,
  "app-update:auto:save": denied,
  "app-update:state": none,
  "app-update:check": denied,
  "app-update:install": denied,
  "browser:sign-ins": none,
  "browser:sign-ins:clear": denied,
  "keybindings:read": none,
  "keybindings:set-command": denied,
  "keybindings:reset-command": denied,
  "keybindings:reset": denied,
  "context:settings:read": none,
  "context:settings:save": denied,
  "babysit:settings:read": none,
  "babysit:settings:save": denied,
  "done:settings:read": none,
  "done:settings:save": denied,
  "orchestrator:read": none,
  "orchestrator:projects": none,
  "orchestrator:computers": none,
  "orchestrator:settings:save": denied,
  "orchestrator:send": denied,
  "orchestrator:task:project": denied,
  "orchestrator:task:sidebar": denied,
  "orchestrator:task:undo": denied,
  "orchestrator:task:move": denied,
  "orchestrator:task:delete": denied,
  "orchestrator:task:reroute": denied,
  "orchestrator:task:dismiss": denied,
  "orchestrator:memory:import": denied,
  "orchestrator:memory:save": denied,
  "orchestrator:memory:forget": denied,
  "routines:enabled:read": none,
  "routines:list": none,
  "routines:targets": none,
  "routines:linear-options": denied,
  "routines:enabled:save": denied,
  "routines:update": denied,
  "routines:delete": denied,
  "routines:run-now": denied,
  "routines:flow-act": denied,
  "routines:flow-test": denied,
  "routines:create": denied,
  "routines:hook": denied,
  "routines:rotate-hook": denied,
  "linear:issues": none,
  "linear:worktree-issues": ([projectPath]) => [projectPath],
  "github:issues": ([value]) => [value?.projectPath],
  "chat:runs": none,
  "chat:send-status": ([projectPath]) => [projectPath],
  "chat:inbox": none,
  "checkpoint:list": ([value]) => [chatProject(value?.chatId)],
  "checkpoint:preview": ([value]) => [chatProject(value?.chatId)],
  "checkpoint:restore": ([value]) => [chatProject(value?.chatId)],
  "validation:run": ([value]) => [chatProject(value?.chatId)],
  "validation:stop": ([value]) => [chatProject(value?.chatId)],
  "validation:log": ([value]) => [chatProject(value?.chatId)],
  "chat:ports": ([chatId]) => [chatProject(chatId)],
  "agent:stop-port": ([chatId]) => [chatProject(chatId)],
  "chat:send": ([request]) => [
    request?.projectPath,
    ...(request?.cwd === undefined ? [] : [request.cwd]),
    ...(Array.isArray(request?.files) ? request.files.map(attached) : []),
  ],
  "chat:resume": ([projectPath]) => [projectPath],
  "chat:limit-switch": ([projectPath]) => [projectPath],
  "chat:limit-resume": ([projectPath]) => [projectPath],
  "chat:limit-resume:cancel": ([projectPath]) => [projectPath],
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
  "accounts:code": none,
  "accounts:remove": none,
  "mcp:accounts": none,
  "mcp:check": none,
  "mcp:definition": none,
  "mcp:saveUrl": none,
  "mcp:remove": none,
  "mcp:toggle": none,
  "local-mcp:status": denied,
  "local-mcp:create": denied,
  "local-mcp:update": denied,
  "local-mcp:rotate": denied,
  "local-mcp:revoke": denied,
  "local-mcp:enableClient": denied,
  "local-mcp:disableClient": denied,
  "usage:read": (args) => (args[0] == null ? [] : [args[0]]),
  "token-usage:read": denied,
  "usage:cached": (args) => (args[0] == null ? [] : [args[0]]),
  "usage:accounts:read": denied,
  "usage:accounts:cached": denied,
  "agent:answer-question": ([value]) => [chatProject(value?.chatId)],
  "agent:dismiss-suggestion": ([value]) => [chatProject(value?.chatId)],
  "agent:set-permission-mode": ([value]) => [chatProject(value?.chatId)],
  "agent:models": (args) => (args[0] == null ? [] : [args[0]]),
  "agent:provider-updates": () => [],
  "agent:update-cli": denied,
  "agent:cli-status": (args) => (args[0] == null ? [] : [args[0]]),
  "scope:retry-save": ([scope]) => [scope],
  "chat:patch": ([projectPath]) => [projectPath],
  "chat:delete": ([projectPath]) => [projectPath],
  "chat:detach": ([projectPath]) => [projectPath],
  "chat:fork": ([projectPath]) => [projectPath],
  "chat:btw": ([request]) => [chatProject(request?.chatId)],
  "chat:btw-stop": ([chatId]) => [chatProject(chatId)],
  "chat:btw-read": ([chatId]) => [chatProject(chatId)],
  "chat:archive-subagent": ([projectPath]) => [projectPath],
  "chat:archive-finished-subagents": ([projectPath]) => [projectPath],
  "chat:subagent": ([projectPath]) => [projectPath],
  "chat:task-output": ([chatId]) => [chatProject(chatId)],
  "worktree:pull-request": ([worktreePath]) => [worktreePath],
  "worktree:pull-requests": ([worktreePath]) => [worktreePath],
  "pull-requests:open": ([projectPath]) => [projectPath],
  "pull-requests:list": denied,
  "pull-requests:checks": denied,
  "pr-reviews:fix": denied,
  "pr-reviews:read": denied,
  "pr-reviews:counts": denied,
  "pr-reviews:set-status": denied,
  "pr-reviews:settings:read": denied,
  "pr-reviews:settings:save": denied,
  "project:branches": ([projectPath]) => [projectPath],
  "attachment:preview": ([file]) => [attached(file)],
  "attachment:read": ([file]) => [attached(file)],
  "skills:list": ([projectPath]) => [projectPath],
  "project:files": ([root]) => [root],
  "skills:read": ([projectPath, file]) => [projectPath, file],
  "dictation:corrections": ([cwd]) => [cwd],
  "dictation:correct": ([cwd]) => [cwd],
  "dictation:context": ([value]) => (value?.scope == null ? [value?.cwd] : [value?.cwd, value.scope]),
  "dictation:polish": ([value]) => (value?.scope == null ? [value?.cwd] : [value?.cwd, value.scope]),
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
  "worktree:roots": none,
  "worktree:status": ([worktreePath]) => [worktreePath],
  "worktree:remove": ([worktreePath, options]) => [worktreePath, options?.projectPath, ...(options?.chatId === undefined ? [] : [chatProject(options.chatId)])],
});

function createConfinement({ allowedRoot, uploadsDir }) {
  if (typeof allowedRoot !== "string" || !path.isAbsolute(allowedRoot)) throw new Error("allowedRoot must be an absolute path");
  let root;
  const realRoot = async () => {
    root ??= await fs.realpath(allowedRoot).catch(() => {
      throw new Error(`allowedRoot does not exist: ${allowedRoot}`);
    });
    return root;
  };

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

  async function checkCall(method, args) {
    const paths = PATHS[method];
    if (!paths || !Array.isArray(args)) throw refused();
    if (method === "accounts:list") return { result: { providers: [] } };
    if (method === "usage:accounts:read" || method === "usage:accounts:cached") return { result: { providers: [] } };
    if (method === "accounts:scopes") return { result: [] };
    if (method.startsWith("accounts:") || method === "chat:limit-switch" || method === "limits:auto-switch:save" || method === "limits:resume-at-reset:save")
      throw failure(403, "Accounts cannot be changed on this demo computer.");
    if (method.startsWith("mcp:")) throw failure(403, MCP_REFUSED);
    if (method === "push:register") throw failure(403, NOTIFICATIONS_OFF);
    if (method === "push:unregister") return { result: { registered: false } };
    if (method === "push:focus") return { result: null };
    if (method === "chat:send") args = [sendRequest(args[0])];
    if (method === "routines:targets") args = [{ within: await realRoot() }];
    for (const item of paths(args)) {
      if (item && typeof item === "object" && "file" in item) await check(item.file, { uploads: true });
      else await check(item);
    }
    return { args };
  }

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
