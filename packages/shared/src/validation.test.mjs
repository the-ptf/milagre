import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeValidationSettings, validationFixPrompt, validationMeta, validationStaleText, validationStatus, validationText } from "./validation.mjs";

test("settings keep commands with text, name unnamed ones and refuse folders outside the Worktree", () => {
  assert.deepEqual(
    normalizeValidationSettings({
      commands: [{ name: " ", command: " npm test " }, { command: "" }, { name: "Lint", command: "npm run lint", cwd: "./packages/core/" }],
    }),
    {
      commands: [
        { name: "npm", command: "npm test", cwd: "" },
        { name: "Lint", command: "npm run lint", cwd: "packages/core" },
      ],
      afterTask: true,
    },
  );
  assert.equal(normalizeValidationSettings({ afterTask: false }).afterTask, false);
  assert.throws(() => normalizeValidationSettings({ commands: [{ command: "x", cwd: "../other" }] }), /inside the Worktree/);
  assert.throws(() => normalizeValidationSettings({ commands: [{ command: "x", cwd: "/etc" }] }), /inside the Worktree/);
});

test("a run's status comes from its commands: interrupted wins, then failed; nothing run is not run", () => {
  const passed = { status: "passed" };
  assert.equal(validationStatus([passed, passed]), "passed");
  assert.equal(validationStatus([passed, { status: "failed" }]), "failed");
  assert.equal(validationStatus([{ status: "failed" }, { status: "interrupted" }]), "interrupted");
  assert.equal(validationStatus([passed, { status: "not-run" }], { interrupted: true }), "interrupted");
  assert.equal(validationStatus([{ status: "not-run" }]), "not-run");
  assert.equal(validationStatus([], { running: true }), "running");
});

test("the copy says what ran and what changed after it", () => {
  const context = {
    kind: "validation",
    runId: "r",
    status: "failed",
    trigger: "task",
    startedAt: 0,
    endedAt: 64_000,
    worktreePath: "/w",
    results: [
      { name: "Typecheck", command: "npm run typecheck", cwd: "", status: "passed", exitCode: 0 },
      { name: "Tests", command: "npm test", cwd: "packages/core", status: "failed", exitCode: 1, tail: "1 failed" },
    ],
  };
  assert.equal(validationMeta(context), "1 of 2 failed · after this task · 1m 04s");
  assert.equal(validationText(context), "Validation failed: 1 of 2 failed · after this task · 1m 04s");
  assert.equal(validationFixPrompt(context), "Validation failed. Fix it:\n\n`npm test` in packages/core exit 1.\n\n```\n1 failed\n```");
  assert.equal(validationStaleText({ at: 1, files: ["a", "b", "c", "d"] }), "Out of date: 4 files changed after this run (a, b, c and 1 more)");
});
