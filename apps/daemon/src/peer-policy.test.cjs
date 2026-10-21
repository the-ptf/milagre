const test = require("node:test");
const assert = require("node:assert/strict");
const { peerPolicy } = require("./peer-policy.cjs");

test("paired Macs can't add command servers or start MCP sign-in", () => {
  for (const method of ["mcp:save", "mcp:signIn", "mcp:cancelSignIn"]) assert.equal(peerPolicy.denies(method), true, method);
  for (const method of ["mcp:saveUrl", "mcp:toggle", "mcp:remove", "mcp:definition"]) assert.equal(peerPolicy.denies(method), false, method);
});

test("sidebar visibility is this Mac's only: a paired Mac can't change it", () => {
  assert.equal(peerPolicy.denies("project:set-hidden"), true);
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

test("a paired Mac can read usage but cannot mutate provider accounts", () => {
  for (const method of ["usage:read", "usage:cached", "accounts:scope"]) assert.equal(peerPolicy.denies(method), false, method);
  for (const method of ["accounts:add", "accounts:select", "accounts:login", "accounts:cancel", "accounts:remove", "accounts:assign", "chat:limit-switch"])
    assert.equal(peerPolicy.denies(method), true, method);
});
