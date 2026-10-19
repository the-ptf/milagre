const test = require("node:test");
const assert = require("node:assert/strict");
const { peerPolicy } = require("./peer-policy.cjs");

test("paired Macs can't add command servers or start MCP sign-in", () => {
  for (const method of ["mcp:save", "mcp:signIn", "mcp:cancelSignIn"]) assert.equal(peerPolicy.denies(method), true, method);
  for (const method of ["mcp:saveUrl", "mcp:toggle", "mcp:remove", "mcp:definition"]) assert.equal(peerPolicy.denies(method), false, method);
});

test("routines and sidebar visibility are this Mac's only: a paired Mac can't read or change them", () => {
  for (const method of [
    "project:set-hidden",
    "routines:enabled:read",
    "routines:enabled:save",
    "routines:list",
    "routines:update",
    "routines:delete",
    "routines:run-now",
  ])
    assert.equal(peerPolicy.denies(method), true, method);
});
