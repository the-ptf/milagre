const test = require("node:test");
const assert = require("node:assert/strict");
const { peerPolicy } = require("./peer-policy.cjs");

test("paired peers cannot manage the owner's outbound computers or credential vault", () => {
  for (const method of ["computers:list", "computers:add", "computers:invoke", "computers:unlock", "computers:import-keys", "computers:setup-key"])
    assert.equal(peerPolicy.denies(method), true);
});

test("paired peers cannot impersonate a local Chat through the owner command entrypoint", () => {
  for (const method of ["command:list", "command:describe", "command:run", "desktop:invoke", "desktop:register", "desktop:respond"])
    assert.equal(peerPolicy.denies(method), true);
});

test("paired Macs can't add command servers or start MCP sign-in", () => {
  for (const method of ["mcp:save", "mcp:signIn", "mcp:cancelSignIn"]) assert.equal(peerPolicy.denies(method), true, method);
  for (const method of ["mcp:saveUrl", "mcp:toggle", "mcp:remove", "mcp:definition"]) assert.equal(peerPolicy.denies(method), false, method);
});

test("sidebar visibility is this Mac's only: a paired Mac can't change it", () => {
  assert.equal(peerPolicy.denies("project:set-hidden"), true);
});

test("a paired Mac reads and changes this Mac's Babysit PRs settings", () => {
  for (const method of ["babysit:settings:read", "babysit:settings:save"]) assert.equal(peerPolicy.denies(method), false, method);
});

test("a paired Mac reads and edits this Mac's keybindings", () => {
  for (const method of ["keybindings:read", "keybindings:set-command", "keybindings:reset-command", "keybindings:reset"])
    assert.equal(peerPolicy.denies(method), false, method);
});

test("a paired Mac reads and manages this Mac's Routines", () => {
  for (const method of [
    "routines:enabled:read",
    "routines:enabled:save",
    "routines:list",
    "routines:update",
    "routines:delete",
    "routines:run-now",
    "routines:create",
    "routines:targets",
    "routines:linear-options",
    "routines:hook",
    "routines:rotate-hook",
  ])
    assert.equal(peerPolicy.denies(method), false, method);
});

test("a paired Mac can choose a Project's saved account while sign-ins and computer defaults stay local", () => {
  for (const method of ["usage:read", "usage:cached", "accounts:scope", "accounts:assign"]) assert.equal(peerPolicy.denies(method), false, method);
  for (const method of ["accounts:add", "accounts:select", "accounts:login", "accounts:cancel", "accounts:remove", "chat:limit-switch"])
    assert.equal(peerPolicy.denies(method), true, method);
});
