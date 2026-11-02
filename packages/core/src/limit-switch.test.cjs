const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLimitSwitch, UNKNOWN_RESET_MS } = require("./limit-switch.cjs");

const PROJECT = "/work/app";
const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const RESET = "2026-10-13T16:10:00.000Z";

function setup({ effectiveId = "default", accounts } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "limit-switch-"));
  const choices = accounts ?? [
    { id: "default", provider: "claude", label: "Default", state: "ready", email: "me@home.com" },
    { id: "work", provider: "claude", label: "Work", state: "ready", email: "me@work.com" },
    { id: "old", provider: "claude", label: "Old", state: "signed-out" },
  ];
  const snapshot = () => ({ scopeKey: PROJECT, providers: [{ provider: "claude", accountId: null, effectiveId, defaultId: "default", accounts: choices }] });
  const calls = [];
  const limits = createLimitSwitch({
    file: path.join(dir, "limit-switch.json"),
    now: () => NOW,
    scope: async () => snapshot(),
    assign: async (scopeKey, provider, id) => {
      calls.push(["assign", scopeKey, provider, id]);
      effectiveId = id;
      return snapshot();
    },
    chats: {
      continueAfterLimit: async (projectPath, sessionId, provider, label) => {
        calls.push(["continue", projectPath, sessionId, provider, label]);
        return true;
      },
    },
  });
  return { limits, calls, snapshot };
}

const failed = (accountId, resetsAt) => ({
  type: "turn-failed",
  message: "limit",
  notice: true,
  limit: { provider: "claude", accountId, ...(resetsAt ? { resetsAt } : {}) },
});

test("a switch assigns the account to the Chat's Project, then continues the Chat on it", async () => {
  const { limits, calls } = setup();
  assert.deepEqual(await limits.switchTo(PROJECT, "3", "claude", "work"), { continued: true, label: "me@work.com" });
  assert.deepEqual(calls, [
    ["assign", PROJECT, "claude", "work"],
    ["continue", PROJECT, 3, "claude", "me@work.com"],
  ]);
});

test("a limited account is marked until it resets, or for an hour when the reset is unknown", async () => {
  const { limits, snapshot } = setup();
  await limits.observe(`${PROJECT}#3`, failed("default", RESET));
  await limits.observe(`${PROJECT}#4`, failed("work"));
  const accounts = limits.decorate(snapshot()).providers[0].accounts;
  assert.equal(accounts[0].limitedUntil, RESET);
  assert.equal(accounts[1].limitedUntil, new Date(NOW + UNKNOWN_RESET_MS).toISOString());
  assert.equal(accounts[2].limitedUntil, undefined);
});

test("auto-switch is off by default and is saved", async () => {
  const { limits, calls } = setup();
  assert.equal(limits.autoSwitch(), false);
  assert.equal(await limits.observe(`${PROJECT}#3`, failed("default", RESET)), null);
  assert.deepEqual(calls, []);
  assert.equal(limits.setAutoSwitch(true), true);
  assert.equal(limits.autoSwitch(), true);
});

test("auto-switch moves to the next ready account that isn't limited, and stops when none is left", async () => {
  const { limits, calls } = setup();
  limits.setAutoSwitch(true);
  assert.deepEqual(await limits.observe(`${PROJECT}#3`, failed("default", RESET)), { continued: true, label: "me@work.com" });
  assert.deepEqual(calls, [
    ["assign", PROJECT, "claude", "work"],
    ["continue", PROJECT, 3, "claude", "me@work.com"],
  ]);
  // The work account hits its limit too: the default one is still limited and the old one is signed out.
  assert.equal(await limits.observe(`${PROJECT}#3`, failed("work")), null);
  assert.equal(calls.length, 2);
});

test("auto-switch leaves a Project someone already moved to another account", async () => {
  const { limits, calls } = setup({ effectiveId: "work" });
  limits.setAutoSwitch(true);
  assert.equal(await limits.observe(`${PROJECT}#3`, failed("default", RESET)), null);
  assert.deepEqual(calls, []);
});

test("failures that aren't the usage limit are ignored", async () => {
  const { limits, snapshot } = setup();
  limits.setAutoSwitch(true);
  assert.equal(await limits.observe(`${PROJECT}#3`, { type: "turn-failed", message: "boom" }), null);
  assert.equal(await limits.observe(`${PROJECT}#3`, { type: "turn-completed" }), null);
  assert.ok(limits.decorate(snapshot()).providers[0].accounts.every((account) => !account.limitedUntil));
});

test("continue-at-reset defaults on and saving either setting preserves the other", () => {
  const { limits } = setup();
  assert.equal(limits.resumeAtReset(), true);
  assert.equal(limits.autoSwitch(), false);
  limits.setResumeAtReset(false);
  limits.setAutoSwitch(true);
  assert.equal(limits.resumeAtReset(), false);
  limits.setResumeAtReset(true);
  assert.equal(limits.autoSwitch(), true);
});
