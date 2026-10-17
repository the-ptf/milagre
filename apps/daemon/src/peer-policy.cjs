// What a paired desktop may not call on this Mac: pairing and device management (it must not manage its own access),
// push registration (a phone's), stopping the daemon, signing in to or out of Linear (the Mac's own account, done at this Mac), and adding MCP command servers or starting an MCP sign-in (they run or open things on this Mac). Everything else is allowed, so a new desktop method works
// remotely by default. The Unix socket, this Mac's own window, has no policy. Routines are this Mac's only: phones paired
// to it reach them through the mobile bridge, a paired Mac never.
const DENIED_PREFIXES = Object.freeze(["phone:", "devices:", "push:", "routines:"]);
const DENIED = new Set(["daemon:stop", "linear:connect", "linear:cancel", "linear:disconnect", "mcp:save", "mcp:signIn", "mcp:cancelSignIn"]);

const peerPolicy = Object.freeze({
  denies: (method) => DENIED.has(method) || DENIED_PREFIXES.some((prefix) => method.startsWith(prefix)),
});

module.exports = { peerPolicy };
