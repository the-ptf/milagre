const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeBabysitSettings } = require("@milagre/shared/babysit");
const { babysitPrompt, effectiveLevel } = require("./babysit-prompt.cjs");

const pr = { url: "https://github.com/acme/app/pull/7", number: 7 };
const event = {
  kind: "pull-request",
  key: "pr:1",
  summary: "Review comment from @ana: please rename this\nCheck failed: lint",
  changes: [
    { id: "comment:1", text: "Review comment from @ana: please rename this" },
    { id: "check:lint", text: "Check failed: lint" },
  ],
  branch: "feature",
};
const prompt = (over = {}, onBranch = true) => babysitPrompt({ settings: normalizeBabysitSettings(over), event, pr, onBranch });

test("the prompt names the PR, what changed, the level and the skills", () => {
  const text = prompt({ level: 3 });
  assert.match(text, /https:\/\/github\.com\/acme\/app\/pull\/7/);
  assert.match(text, /please rename this/);
  assert.match(text, /Fix and push/);
  for (const skill of ["milagre-fix-ci", "milagre-address-review", "milagre-resolve-conflicts", "milagre-update-branch"])
    assert.ok(text.includes(skill), skill);
  assert.ok(text.includes("End every GitHub comment you post with <!-- milagre-babysit -->"));
  assert.match(text, /never merge/i);
});

test("text from GitHub is fenced as data", () => {
  const text = prompt();
  assert.match(text, /<untrusted-data source="PR #7 changes">/);
});

test("instructions appear after Milagre's section", () => {
  const text = prompt({ instructions: "Ping me in Slack when done." });
  const at = text.indexOf("## Your instructions\nPing me in Slack when done.");
  assert.ok(at > text.indexOf("milagre-babysit"));
  assert.equal(text.endsWith("Ping me in Slack when done."), true);
});

test("no instructions section when empty", () => {
  assert.ok(!prompt({ instructions: "" }).includes("## Your instructions"));
  assert.ok(!prompt({ instructions: "   \n" }).includes("## Your instructions"));
});

test("wrong branch forces report only", () => {
  const text = prompt({ level: 5 }, false);
  assert.match(text, /Report only/);
  assert.match(text, /another branch/);
  assert.ok(!text.includes("Fix, push and reply and"));
  assert.equal(effectiveLevel({ level: 5 }, false), 1);
  assert.equal(effectiveLevel({ level: 5 }, true), 5);
});

test("each level says what it allows and forbids", () => {
  assert.match(prompt({ level: 1 }), /Do not change any file/);
  assert.match(prompt({ level: 2 }), /Do not push/);
  assert.match(prompt({ level: 3 }), /Push the fix to the PR branch/);
  assert.match(prompt({ level: 3 }), /Do not reply on review threads/);
  assert.match(prompt({ level: 4 }), /Reply on each review thread/);
  assert.match(prompt({ level: 4 }), /Do not request a new review/);
  assert.match(prompt({ level: 5 }), /re-request review/i);
});

test("threads are resolved only when the setting is on and the level replies", () => {
  assert.match(prompt({ level: 4, resolveThreads: true }), /Resolve a review thread/);
  assert.match(prompt({ level: 4, resolveThreads: false }), /Do not resolve review threads/);
  assert.match(prompt({ level: 3, resolveThreads: true }), /Do not resolve review threads/);
  assert.match(prompt({ level: 5, resolveThreads: true }, false), /Do not resolve review threads/);
});

test("own rule tells the agent to delete the heartbeat", () => {
  const text = prompt({ ownRule: true, ownRuleText: "Two reviewers approved" });
  assert.match(text, /Two reviewers approved/);
  assert.match(text, /delete this Heartbeat with routine_delete and say why/);
});

test("an own rule that is off or empty adds nothing", () => {
  assert.ok(!prompt({ ownRule: false, ownRuleText: "Two reviewers approved" }).includes("routine_delete"));
  assert.ok(!prompt({ ownRule: true, ownRuleText: "  " }).includes("routine_delete"));
});

test("the settings are never printed", () => {
  const text = prompt({ intervalMinutes: 15, stopAfterDays: { on: true, days: 14 } });
  assert.ok(!text.includes("intervalMinutes"));
  assert.ok(!text.includes("stopAfter"));
  assert.ok(!text.includes("{"));
});
