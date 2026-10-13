const test = require("node:test");
const assert = require("node:assert/strict");
const { deadlineFor } = require("./client.cjs");

test("slow mutations get the time core allows them, others keep the default", () => {
  assert.equal(deadlineFor("artifact:share-page", 30000), 360000);
  assert.equal(deadlineFor("artifact:revoke-page-share", 30000), 120000);
  assert.equal(deadlineFor("artifact:revoke-saved-page-share", 30000), 120000);
  assert.equal(deadlineFor("git:push", 30000), 330000);
  assert.equal(deadlineFor("git:commit", 30000), 330000);
  assert.equal(deadlineFor("agent:update-cli", 30000), 1200000);
  assert.equal(deadlineFor("linear:connect", 30000), 330000, "a sign-in waits five minutes for the browser");
  assert.equal(deadlineFor("daemon:status", 30000), 30000);
  assert.equal(deadlineFor("git:push", 600000), 600000, "a longer caller deadline is kept");
});
