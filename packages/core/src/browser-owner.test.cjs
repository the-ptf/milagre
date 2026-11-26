const test = require("node:test");
const assert = require("node:assert/strict");
const { browserOwnerToken, withBrowserOwner, ownerTokenIn } = require("./browser-owner.cjs");

test("each Chat gets its own owner token and agent-browser session", () => {
  const a = withBrowserOwner("/repo#1", { PATH: "/bin" });
  const b = withBrowserOwner("/repo#2", { PATH: "/bin" });
  assert.match(a.MILAGRE_BROWSER_OWNER, /^[a-f0-9]{16}$/);
  assert.equal(a.MILAGRE_BROWSER_OWNER, browserOwnerToken("/repo#1"));
  assert.notEqual(a.MILAGRE_BROWSER_OWNER, b.MILAGRE_BROWSER_OWNER);
  assert.equal(a.AGENT_BROWSER_SESSION, `milagre-${a.MILAGRE_BROWSER_OWNER}`);
  assert.equal(a.PATH, "/bin");
});

test("a user's own agent-browser session is kept", () => {
  assert.equal(withBrowserOwner("/repo#1", { AGENT_BROWSER_SESSION: "mine" }).AGENT_BROWSER_SESSION, "mine");
});

test("the owner token is read from ps output or a NUL-separated environ, last one wins", () => {
  assert.equal(ownerTokenIn("/chrome --flag MILAGRE_BROWSER_OWNER=0123456789abcdef PATH=/bin"), "0123456789abcdef");
  assert.equal(ownerTokenIn("A=1\0MILAGRE_BROWSER_OWNER=0123456789abcdef\0MILAGRE_BROWSER_OWNER=fedcba9876543210\0"), "fedcba9876543210");
  assert.equal(ownerTokenIn("/chrome --x=MILAGRE_BROWSER_OWNER=0123456789abcdef"), null);
  assert.equal(ownerTokenIn("MILAGRE_BROWSER_OWNER=nothex"), null);
});
