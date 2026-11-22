const DENIED_PREFIXES = Object.freeze(["phone:", "devices:", "push:", "command:", "desktop:", "computers:"]);
const DENIED = new Set([
  "daemon:stop",
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
