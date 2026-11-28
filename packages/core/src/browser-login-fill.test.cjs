const test = require("node:test");
const assert = require("node:assert/strict");
const { fillLogin, refusal } = require("./browser-login-fill.cjs");

const SITE = "https://github.com";
const field = (overrides = {}) => ({ origins: [SITE], tag: "INPUT", type: "password", getForm: false, ...overrides });

test("a login is refused unless every frame up to the top is on its site and the field fits it", () => {
  assert.equal(refusal("password", field(), SITE), null);
  assert.equal(refusal("username", field({ type: "email" }), SITE), null);
  assert.equal(refusal("username", field({ type: "" }), SITE), null);
  assert.match(refusal("password", field({ origins: ["https://evil.example"] }), SITE), /isn't on https:\/\/github.com/);
  assert.match(refusal("password", field({ origins: [SITE, null] }), SITE), /every frame/, "a cross-origin parent frame reads as unknown and refuses");
  assert.match(refusal("password", field({ origins: [SITE, "https://evil.example"] }), SITE), /every frame/);
  assert.match(refusal("password", field({ type: "text" }), SITE), /only into a password field/);
  assert.match(refusal("username", field({ type: "password" }), SITE), /text or email field/);
  assert.match(refusal("password", field({ tag: "TEXTAREA" }), SITE), /input field/);
  assert.match(refusal("password", field({ getForm: true }), SITE), /in the address/);
  assert.match(refusal("password", null, SITE), /couldn't be checked/);
  assert.match(refusal("password", field({ origins: [] }), SITE), /couldn't be checked/);
});

test("filling types the value through the browser's input and returns nothing; a refused field gets no keystroke", async () => {
  const sent = [];
  const session = { send: async (method, params) => sent.push([method, params]) };
  const login = { origin: SITE, username: "octo", password: "gh-pass-123456" };
  const checks = [];
  const onElement = async (_session, _node, script) => {
    checks.push(script);
    return checks.length === 1 ? field() : undefined;
  };
  assert.equal(await fillLogin({ session, node: 7, login, field: "password", onElement }), undefined);
  assert.deepEqual(sent.at(-1), ["Input.insertText", { text: "gh-pass-123456" }]);
  assert.equal(
    checks.some((script) => script.includes("gh-pass")),
    false,
    "the value never goes into page script",
  );
  sent.length = 0;
  await assert.rejects(
    fillLogin({ session, node: 7, login, field: "password", onElement: async () => field({ origins: ["https://evil.example"] }) }),
    /isn't on/,
  );
  assert.deepEqual(sent, []);
});
