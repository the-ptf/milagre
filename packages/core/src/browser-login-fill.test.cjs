const test = require("node:test");
const assert = require("node:assert/strict");
const { fillLogin, refusal, FILL } = require("./browser-login-fill.cjs");

const SITE = "https://github.com";
const field = (overrides = {}) => ({ origins: [SITE], tag: "INPUT", type: "password", getForm: false, sendsTo: [], ...overrides });

test("a login is refused unless every frame up to the top is on its site, the form keeps it there and the field fits it", () => {
  assert.equal(refusal("password", field(), SITE), null);
  assert.equal(refusal("username", field({ type: "email" }), SITE), null);
  assert.equal(refusal("username", field({ type: "" }), SITE), null);
  assert.equal(refusal("password", field({ sendsTo: [SITE] }), SITE), null);
  assert.match(refusal("password", field({ origins: ["https://evil.example"] }), SITE), /isn't on https:\/\/github.com/);
  assert.match(refusal("password", field({ origins: [SITE, null] }), SITE), /every frame/, "a cross-origin parent reads as unknown and refuses");
  assert.match(refusal("password", field({ origins: ["null"] }), SITE), /every frame/, "a sandboxed frame has an opaque origin");
  assert.match(refusal("password", field({ sendsTo: ["https://evil.example"] }), SITE), /sends its fields away/);
  assert.match(refusal("password", field({ sendsTo: [null] }), SITE), /sends its fields away/);
  assert.match(refusal("password", field({ getForm: true }), SITE), /in the address/);
  assert.match(refusal("password", field({ type: "text" }), SITE), /only into a password field/);
  assert.match(refusal("username", field({ type: "password" }), SITE), /text or email field/);
  assert.match(refusal("password", field({ tag: "TEXTAREA" }), SITE), /input field/);
  assert.match(refusal("password", null, SITE), /couldn't be checked/);
  assert.match(refusal("password", field({ origins: [] }), SITE), /couldn't be checked/);
});

function fakeSession(outcomes) {
  const sent = [];
  const session = {
    send: async (method, params) => {
      sent.push([method, params]);
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "top" }, childFrames: [{ frame: { id: "inner" } }] } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: params.frameId === "top" ? 1 : 2 };
      if (method === "DOM.resolveNode") return { object: { objectId: `node-in-${params.executionContextId}` } };
      if (method === "Runtime.callFunctionOn") return { result: { value: outcomes[params.objectId] } };
      throw new Error(`unexpected ${method}`);
    },
  };
  return { session, sent };
}

test("the fill runs in an isolated world of the field's own frame, checks and sets in one call, and never puts the value in script", async () => {
  const login = { origin: SITE, username: "octo", password: "gh-pass-123456" };
  const { session, sent } = fakeSession({ "node-in-1": { elsewhere: true }, "node-in-2": { filled: true } });
  assert.equal(await fillLogin({ session, node: 7, login, field: "password" }), undefined);
  const calls = sent.filter(([method]) => method === "Runtime.callFunctionOn");
  assert.equal(calls.length, 2, "the top frame said the field is elsewhere, the inner frame filled it");
  assert.deepEqual(calls[1][1].arguments, [{ value: SITE }, { value: "password" }, { value: "gh-pass-123456" }]);
  assert.equal(calls[1][1].returnByValue, true);
  assert.equal(FILL.includes("gh-pass"), false);
  assert.equal(
    sent.some(([method]) => method.startsWith("Input.")),
    false,
    "nothing is typed into whatever has focus",
  );
  assert.ok(sent.every(([method, params]) => method !== "Page.createIsolatedWorld" || params.worldName === "milagre-login"));
});

test("a refusal or a field no frame owns fills nothing and says why", async () => {
  const login = { origin: SITE, username: "octo", password: "gh-pass-123456" };
  const refused = fakeSession({ "node-in-1": { problem: "The field isn't on https://github.com in every frame, so the login wasn't filled." } });
  await assert.rejects(fillLogin({ session: refused.session, node: 7, login, field: "password" }), /isn't on/);
  const nowhere = fakeSession({ "node-in-1": { elsewhere: true }, "node-in-2": { elsewhere: true } });
  await assert.rejects(fillLogin({ session: nowhere.session, node: 7, login, field: "password" }), /couldn't be checked/);
});
