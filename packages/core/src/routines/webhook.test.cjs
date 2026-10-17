const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { newHookSecret, hookUrl, verifySignature, webhookPrompt, DEFAULT_SIGNING_HEADER } = require("./webhook.cjs");

const encode = (text) => new TextEncoder().encode(text);
const hmac = (secret, body) => crypto.createHmac("sha256", secret).update(body).digest("hex");

test("a new secret is 43 base64url characters and its hook id is the hex sha256", () => {
  const { secret, hookId } = newHookSecret();
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(hookId, crypto.createHash("sha256").update(secret).digest("hex"));
  assert.notEqual(newHookSecret().secret, secret);
});

test("hook URLs use the relay's https origin", () => {
  assert.equal(hookUrl("wss://relay.milagre.cloud", "abc"), "https://relay.milagre.cloud/hook/abc");
  assert.equal(hookUrl("ws://127.0.0.1:9000/", "abc"), "http://127.0.0.1:9000/hook/abc");
});

test("a signature verifies as plain hex or with sha256=, in the named header only", () => {
  const body = encode('{"a":1}');
  const good = hmac("shh", body);
  assert.equal(verifySignature({ body, headers: { [DEFAULT_SIGNING_HEADER]: good }, signingSecret: "shh" }), true);
  assert.equal(verifySignature({ body, headers: { "x-sig": `sha256=${good.toUpperCase()}` }, header: "x-sig", signingSecret: "shh" }), true);
  assert.equal(verifySignature({ body, headers: { "x-sig": good }, signingSecret: "shh" }), false, "wrong header");
  assert.equal(verifySignature({ body, headers: { [DEFAULT_SIGNING_HEADER]: hmac("other", body) }, signingSecret: "shh" }), false);
  assert.equal(verifySignature({ body, headers: { [DEFAULT_SIGNING_HEADER]: "abc" }, signingSecret: "shh" }), false);
  assert.equal(verifySignature({ body, headers: { [DEFAULT_SIGNING_HEADER]: good }, signingSecret: "" }), false);
});

test("the prompt fills body, paths, headers, query and request, all as untrusted data, and keeps unknown placeholders", () => {
  const delivery = {
    headers: { "x-env": "prod", "content-type": "application/json" },
    query: { team: "web" },
    body: encode('{"event":{"title":"Boom","tags":["a","b"]},"__proto__":{"x":1}}'),
  };
  const text = webhookPrompt(
    "B {{body}} T {{body.event.title}} G {{body.event.tags}} I {{body.event.tags.1}} M {{body.missing}} P {{body.constructor}} H {{headers.X-Env}} Q {{query.team}} R {{request}} U {{other}}",
    delivery,
  );
  assert.match(text, /^Text inside untrusted-data/);
  assert.match(text, /<untrusted-data source="webhook body">\n\{"event"/);
  assert.match(text, /T (<untrusted-data source="webhook body.event.title">\n)?Boom/);
  assert.match(text, /G (<untrusted-data source="webhook body.event.tags">\n)?\["a","b"\]/);
  assert.match(text, /I (<untrusted-data source="webhook body.event.tags.1">\n)?b/);
  assert.match(text, /M  P  H/, "a missing path and a prototype path are empty");
  assert.match(text, /H (<untrusted-data source="webhook header x-env">\n)?prod/);
  assert.match(text, /Q (<untrusted-data source="webhook query team">\n)?web/);
  assert.match(text, /<untrusted-data source="webhook request">\nPOST \?team=web\nx-env: prod\ncontent-type: application\/json\n\n\{"event"/);
  assert.match(text, /U \{\{other\}\}$/);
});

test("a body that isn't JSON still fills {{body}}, and its paths are empty", () => {
  const text = webhookPrompt("{{body}}|{{body.a}}|", { headers: {}, query: {}, body: encode("plain text") });
  assert.match(text, /plain text\n<\/untrusted-data>\|\|$/);
});
