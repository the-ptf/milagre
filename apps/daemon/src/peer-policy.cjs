// What a paired desktop may not call on this Mac: pairing and device management (it must not manage its own access),
// push registration (a phone's), stopping the daemon, managing sign-ins and computer-default accounts, signing in to or out of Linear (the Mac's own account, done at this Mac), and adding MCP command servers or starting an MCP sign-in (they run or open things on this Mac). Selecting a saved Account for a Project or Link is allowed. Everything else is allowed, so a new desktop method works
// remotely by default. The Unix socket, this Mac's own window, has no policy. Routines run only on this Mac, but a paired
// Mac reads and manages them like its own (routines:changed reaches it too). Its Computer page checks and installs this
// Mac's desktop app update (app-update:*), as a phone does; the desktop:* commands behind them stay local.
const DENIED_PREFIXES = Object.freeze(["phone:", "devices:", "push:", "command:", "desktop:", "computers:"]);
const DENIED = new Set([
  "daemon:stop",
  "accounts:add",
  "accounts:select",
  "accounts:login",
  "accounts:cancel",
  "accounts:remove",
  "chat:limit-switch",
  "project:set-hidden",
  "linear:connect",
  "linear:cancel",
  "linear:disconnect",
  "mcp:save",
  "mcp:signIn",
  "mcp:cancelSignIn",
]);

const peerPolicy = Object.freeze({
  denies: (method) => DENIED.has(method) || DENIED_PREFIXES.some((prefix) => method.startsWith(prefix)),
});

module.exports = { peerPolicy };
