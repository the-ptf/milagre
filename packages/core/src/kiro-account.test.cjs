const assert = require("node:assert/strict");
const test = require("node:test");
const { inspectKiroAccount, parseWhoami } = require("./kiro-account.cjs");

const SIGNED_IN = `Logged in with IAM Identity Center (https://example.awsapps.com/start)
Email: dev@example.com

Profile:
KiroProfile-us-east-1
arn:aws:codewhisperer:us-east-1:000000000000:profile/EXAMPLE
`;

// `whoami` as kiro-cli answers it: stdout, and exit 1 when signed out.
const whoami =
  (stdout, code = 0) =>
  (_command, args, _options, callback) => {
    assert.deepEqual(args, ["whoami"]);
    callback(code ? Object.assign(new Error("exit"), { code }) : null, stdout, "");
  };

test("whoami gives the sign-in method and email, and nothing more", () => {
  assert.deepEqual(parseWhoami(SIGNED_IN), { method: "IAM Identity Center", email: "dev@example.com" });
  assert.deepEqual(parseWhoami("Logged in with Builder ID\nEmail: me@example.com\n"), { method: "Builder ID", email: "me@example.com" });
  assert.equal(parseWhoami("Not logged in\n"), null);
});

test("a signed-in kiro-cli is a ready Account; the plan is how it signed in", async () => {
  assert.deepEqual(await inspectKiroAccount({ command: "/k", execImpl: whoami(SIGNED_IN) }), {
    state: "ready",
    email: "dev@example.com",
    plan: "IAM Identity Center",
  });
});

test("a signed-out kiro-cli says to sign in from a terminal", async () => {
  const account = await inspectKiroAccount({ command: "/k", execImpl: whoami("Not logged in\n", 1) });
  assert.equal(account.state, "signed-out");
  assert.match(account.message, /kiro-cli login/);
});

test("an answer that can't be read is an error, never raw output", async () => {
  const account = await inspectKiroAccount({ command: "/k", execImpl: whoami("thread 'main' panicked at src/main.rs\n", 101) });
  assert.equal(account.state, "error");
  assert.doesNotMatch(account.message, /panicked/);
  assert.equal((await inspectKiroAccount({})).state, "error");
});
