const DENIED_PREFIXES = Object.freeze(["phone:", "devices:", "push:", "command:", "desktop:", "computers:"]);
const DENIED = new Set([
  "daemon:stop",
  "accounts:add",
  "accounts:select",
  "accounts:login",
  "accounts:cancel",
  "accounts:code",
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
