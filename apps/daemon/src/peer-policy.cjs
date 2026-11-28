const DENIED_PREFIXES = Object.freeze(["phone:", "devices:", "push:", "command:", "desktop:", "computers:", "secrets:"]);
const PEER_SECRETS = new Set(["secrets:digest", "secrets:push", "secrets:forget-from"]);
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
  "connectors:add",
  "connectors:update",
  "connectors:sign-in",
  "connectors:cancel-sign-in",
  "connectors:call",
  "connectors:move",
  "email:connect",
]);

const peerPolicy = Object.freeze({
  denies: (method) => !PEER_SECRETS.has(method) && (DENIED.has(method) || DENIED_PREFIXES.some((prefix) => method.startsWith(prefix))),
});

module.exports = { peerPolicy };
