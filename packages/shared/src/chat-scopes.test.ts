import test from "node:test";
import assert from "node:assert/strict";

test("scope keys preserve Project paths and separate named Link Chats", async () => {
  const helpers = await import("./chat-scopes.mjs");
  const project = { kind: "project" as const, projectPath: "/code/my#project" };
  assert.equal(helpers.chatKeyForScope(project, 7), "/code/my#project#7");
  assert.deepEqual(helpers.scopeFromChatKey("/code/my#project#7"), project);
  const link = { kind: "link" as const, linkId: "f1713d69-569d-405b-a0b2-19bfdf565a76" };
  assert.equal(helpers.chatKeyForScope(link, 7), "milagre-link:f1713d69-569d-405b-a0b2-19bfdf565a76#7");
  assert.deepEqual(helpers.scopeFromChatKey("milagre-link:f1713d69-569d-405b-a0b2-19bfdf565a76#7"), link);
  assert.throws(() => helpers.chatKeyForScope(link, Number.NaN));
  assert.throws(() => helpers.scopeKey({ kind: "link", linkId: "../../outside" }));
});

test("a paired computer's keys carry its id, and this Mac's keys are unchanged", async () => {
  const s = await import("./chat-scopes.mjs");
  const id = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
  const linkId = "f1713d69-569d-405b-a0b2-19bfdf565a76";
  assert.equal(s.LOCAL_COMPUTER, "local");
  assert.equal(s.qualifyKey("local", "/code/app"), "/code/app");
  assert.equal(s.qualifyKey(undefined, "/code/app"), "/code/app");
  assert.equal(s.qualifyKey(id, "/code/app"), `${id}|/code/app`);
  assert.equal(s.qualifyKey(id, `${id}|/code/app`), `${id}|/code/app`, "never twice");
  assert.equal(s.qualifyKey(id, "/code/app#3"), `${id}|/code/app#3`);
  assert.equal(s.qualifyKey(id, `milagre-link:${linkId}`), `milagre-link:${id}|${linkId}`);
  assert.notEqual(s.qualifyKey(id, "/code/app"), "/code/app", "the same path on two Macs is two keys");
  for (const key of ["/code/app", `${id}|/code/app`, `milagre-link:${linkId}`, `milagre-link:${id}|${linkId}#2`, `${id}|/code/my#project#7`, "C:\\code\\app"])
    assert.equal(s.qualifyKey(s.computerOfKey(key), s.unqualifyKey(key)), key, key);
  assert.equal(s.computerOfKey("/code/app#3"), "local");
  assert.equal(s.computerOfKey(`${id}|/code/app#3`), id);
  assert.equal(s.computerOfKey(`milagre-link:${id}|${linkId}#2`), id);
  assert.equal(s.unqualifyKey(`milagre-link:${id}|${linkId}#2`), `milagre-link:${linkId}#2`);
  assert.equal(s.isLinkScopeKey(`milagre-link:${id}|${linkId}`), true);
  assert.equal(s.isLinkScopeKey(`milagre-link:${id}|../outside`), false);
  assert.equal(s.isLinkScopeKey(`${id}|/code/app`), false);
  assert.equal(s.scopeKey({ kind: "project", projectPath: `${id}|/code/app` }), `${id}|/code/app`);
  assert.equal(s.scopeKey({ kind: "link", linkId: `${id}|${linkId}` }), `milagre-link:${id}|${linkId}`);
  assert.throws(() => s.scopeKey({ kind: "project", projectPath: `${id}|relative` }));
  assert.deepEqual(s.scopeFromChatKey(`${id}|/code/app#4`), { kind: "project", projectPath: `${id}|/code/app` });
  assert.deepEqual(s.scopeFromChatKey(`milagre-link:${id}|${linkId}#4`), { kind: "link", linkId: `${id}|${linkId}` });
  assert.equal(s.validLinkId(`${id}|${linkId}`), false, "the daemon's own check of a Link id stays strict");
});

test("an invalid computer id throws instead of collapsing onto this Mac's key, and `local|` is never a qualifier", async () => {
  const s = await import("./chat-scopes.mjs");
  for (const bad of ["a_b", "a.b", "a|b", "a".repeat(65)]) assert.throws(() => s.qualifyKey(bad, "/code/app"), bad);
  assert.equal(s.qualifyKey("", "/code/app"), "/code/app");
  assert.equal(s.qualifyKey(null, "/code/app"), "/code/app");
  assert.equal(s.computerOfKey("/code/a|b#1"), "local");
  assert.equal(s.unqualifyKey("/code/a|b#1"), "/code/a|b#1");
  assert.equal(s.computerOfKey("local|/x"), "local");
  assert.equal(s.unqualifyKey("local|/x"), "local|/x");
  assert.equal(s.isLinkScopeKey("milagre-link:local|f1713d69-569d-405b-a0b2-19bfdf565a76"), false);
});

test("a simulator viewer asks for full quality only on the computer that runs the device", async () => {
  const { simulatorQualityFor } = await import("./simulator.ts");
  assert.equal(simulatorQualityFor("/code/app#3"), "full");
  assert.equal(simulatorQualityFor("milagre-link:f1713d69-569d-405b-a0b2-19bfdf565a76#3"), "full");
  assert.equal(simulatorQualityFor("studio-mac|/code/app#3"), "reduced", "a paired computer's Project goes over the Link or relay");
  assert.equal(simulatorQualityFor("milagre-link:studio-mac|f1713d69-569d-405b-a0b2-19bfdf565a76#3"), "reduced");
});
