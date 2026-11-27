const LINK_DELETE_MS = 30 * 60 * 1000;
const SLOW_METHODS = Object.freeze({
  "command:run": 30 * 60 * 1000,
  "desktop:invoke": 130000,
  "computers:add": 12 * 60 * 1000,
  "computers:invoke": 30 * 60 * 1000,
  "artifact:share-page": 420000,
  "artifact:set-page-share-paused": 420000,
  "artifact:revoke-page-share": 120000,
  "artifact:revoke-saved-page-share": 120000,
  "git:commit": 330000,
  "git:push": 330000,
  "git:open-pr": 120000,
  "git:generate": 180000,
  "worktree:create": 330000,
  "worktree:remove": 330000,
  "storage:remove-worktree": 330000,
  "storage:worktrees": 120000,
  "import:scan": 120000,
  "import:run": 600000,
  "link:delete": LINK_DELETE_MS,
  // Installing Antigravity downloads about 110 MB and unpacks it; a slow connection takes minutes.
  "agent:update-cli": 1200000,
  "linear:connect": 330000,
  "connectors:sign-in": 330000,
  "connectors:add": 45000,
  "connectors:move": 45000,
  "connectors:check": 45000,
  "connectors:tools": 45000,
  "connectors:call": 130000,
  "email:connect": 45000,
  "mcp:accounts": 45000,
  "mcp:check": 45000,
  "mcp:save": 45000,
  "mcp:saveUrl": 45000,
  "mcp:remove": 45000,
  "mcp:signIn": 45000,
  "mcp:definition": 45000,
});
const FLUSH_ABORTED_METHODS = new Set(["linear:connect", "connectors:sign-in"]);
const isBackgroundSlowMethod = (method) => Object.hasOwn(SLOW_METHODS, method) && !FLUSH_ABORTED_METHODS.has(method);

module.exports = { SLOW_METHODS, isBackgroundSlowMethod };
