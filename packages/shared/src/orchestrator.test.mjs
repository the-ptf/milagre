import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ORCHESTRATOR_DEFAULTS,
  autopilotDecision,
  isMemoryImporting,
  boardColumn,
  isIrreversible,
  keywordRoute,
  normalizeOrchestratorMemory,
  normalizeOrchestratorSettings,
  normalizeOrchestratorTask,
  pickAccount,
  pickComputer,
  recordTrust,
  roleById,
  titleFromPrompt,
  trustScore,
} from "./orchestrator.mjs";

test("settings start off with the picked defaults and keep only known values", () => {
  const settings = normalizeOrchestratorSettings(null);
  assert.equal(settings.enabled, false);
  assert.equal(settings.autopilot, "answer");
  assert.equal(settings.useOtherComputers, true);
  assert.equal(settings.mascotColor, "#ffffff");
  assert.equal(settings.roles.length, ORCHESTRATOR_DEFAULTS.roles.length);
  const odd = normalizeOrchestratorSettings({
    autopilot: "always",
    vetoSeconds: 7,
    mascotColor: "blue",
    computerPreferences: { studio: "prefer", mbp: "sometimes" },
  });
  assert.equal(odd.autopilot, "answer");
  assert.equal(odd.vetoSeconds, 30);
  assert.equal(odd.mascotColor, "#ffffff");
  assert.deepEqual(odd.computerPreferences, { studio: "prefer" });
});

test("a role without a model is inactive, and roles always keep one with a model", () => {
  const settings = normalizeOrchestratorSettings({ roles: [{ id: "build", name: "Build", provider: null }] });
  assert.ok(
    settings.roles.some((role) => role.model),
    "falls back to the defaults when no role has a model",
  );
  const roles = normalizeOrchestratorSettings({}).roles;
  assert.equal(roleById(roles, "test")?.id, "build", "the inactive Test role routes to Build");
  assert.equal(roleById(roles, "security")?.provider, "codex");
});

test("keyword routing matches a Project by name first, then by its hints", () => {
  const projects = [
    { path: "/p/happiergym", name: "happiergym", hints: "Gym tracking app with HealthKit and a rest timer" },
    { path: "/p/rdfood", name: "rdfood", hints: "Restaurant ordering with Supabase auth" },
  ];
  assert.equal(keywordRoute("the rest timer skips on the lock screen", projects)?.projectPath, "/p/happiergym");
  assert.equal(keywordRoute("fix login in rdfood", projects)?.projectPath, "/p/rdfood");
  assert.equal(keywordRoute("write me a poem", projects), null);
});

test("board columns follow done, needs you and the pull request", () => {
  assert.equal(boardColumn({ done: false, needsYou: false }), "running");
  assert.equal(boardColumn({ done: false, needsYou: true, pullRequest: "open" }), "needs");
  assert.equal(boardColumn({ done: false, needsYou: false, pullRequest: "open" }), "review");
  assert.equal(boardColumn({ done: false, needsYou: false, pullRequest: "merged" }), "done");
  assert.equal(boardColumn({ done: true, needsYou: true }), "done");
  assert.equal(boardColumn({ done: false, needsYou: false, finished: true }), "review", "a finished turn waits for the owner to review it");
});

test("irreversible actions are recognized from commands, tools and questions", () => {
  assert.equal(isIrreversible({ command: "git push origin main" }), true);
  assert.equal(isIrreversible({ command: "git push --force origin feature" }), true);
  assert.equal(isIrreversible({ command: "git push origin feature/rest-timer" }), false);
  assert.equal(isIrreversible({ command: "gh pr merge 212 --squash" }), true);
  assert.equal(isIrreversible({ command: "npm test" }), false);
  assert.equal(isIrreversible({ command: "rm -rf build" }), true);
  assert.equal(isIrreversible({ tool: "mcp__slack__send_message" }), true);
  assert.equal(isIrreversible({ text: "Should I deploy this to production?" }), true);
  assert.equal(isIrreversible({ text: "Monthly or yearly first?" }), false);
});

test("autopilot never answers irreversible actions and follows the mode", () => {
  assert.equal(autopilotDecision({ mode: "answer", irreversible: true, confidence: 1, trust: 1 }), "ask");
  assert.equal(autopilotDecision({ mode: "off", irreversible: false, confidence: 1, trust: 1 }), "ask");
  assert.equal(autopilotDecision({ mode: "answer", irreversible: false, confidence: 0.9, trust: 0.8 }), "answer");
  assert.equal(autopilotDecision({ mode: "answer", irreversible: false, confidence: 0.5, trust: 0.5 }), "veto");
  assert.equal(autopilotDecision({ mode: "answer", irreversible: false, confidence: 0.1, trust: 0.2 }), "ask");
  assert.equal(autopilotDecision({ mode: "ask", irreversible: false, confidence: 0.9, trust: 0.9 }), "propose");
});

test("corrections lower trust faster than answers raise it", () => {
  let trust = {};
  for (let i = 0; i < 4; i += 1) trust = recordTrust(trust, "approval", "answered");
  const before = trustScore(trust.approval);
  trust = recordTrust(trust, "approval", "corrected");
  assert.ok(trustScore(trust.approval) < before - 0.15);
  assert.equal(trustScore(undefined), 0.5);
});

test("accounts: least used under its limit, else the Project's", () => {
  const accounts = [
    { id: "team", usedPercent: 61 },
    { id: "personal", usedPercent: 22 },
    { id: "full", usedPercent: 100, limited: true },
  ];
  assert.equal(pickAccount({ mode: "least-used", accounts, projectAccountId: "team" }).accountId, "personal");
  assert.equal(pickAccount({ mode: "project", accounts, projectAccountId: "team" }).accountId, "team");
  assert.equal(pickAccount({ mode: "least-used", accounts: [], projectAccountId: "team" }).accountId, "team");
});

test("computers: the one with most room wins, preferences weigh it, manual ones are skipped", () => {
  const candidates = [
    { id: "this", local: true, online: true, cpu: 0.6, memoryFree: 0.3 },
    { id: "studio", local: false, online: true, cpu: 0.1, memoryFree: 0.7 },
    { id: "mbp", local: false, online: false, cpu: 0, memoryFree: 1 },
  ];
  assert.equal(pickComputer({ candidates, preferences: {} })?.id, "studio");
  assert.equal(pickComputer({ candidates, preferences: { studio: "manual" } })?.id, "this");
});

test("tasks and memory drop malformed entries", () => {
  assert.equal(normalizeOrchestratorTask({ id: 3 }), null);
  const task = normalizeOrchestratorTask({ id: "t", prompt: "please fix the rest timer. it skips" });
  assert.equal(task.title, "Fix the rest timer");
  assert.equal(task.state, "routing");
  const memory = normalizeOrchestratorMemory({
    notes: [
      { id: "a", text: "  Short replies  ", group: "work" },
      { id: "b", text: "" },
    ],
    trust: { x: { answered: 2.7 } },
  });
  assert.deepEqual(
    memory.notes.map((note) => note.text),
    ["Short replies"],
  );
  assert.deepEqual(memory.trust.x, { answered: 2, corrected: 0 });
  assert.equal(titleFromPrompt(""), "New task");
});

test("a memory read counts as running until it finishes or five minutes pass", () => {
  const now = 1_800_000_000_000;
  assert.equal(isMemoryImporting({ importStartedAt: now - 1000, importedAt: null }, now), true);
  assert.equal(isMemoryImporting({ importStartedAt: now - 1000, importedAt: now - 500 }, now), false);
  assert.equal(isMemoryImporting({ importStartedAt: now - 6 * 60_000, importedAt: now - 9 * 60_000 }, now), false, "a read cut off by a restart ends");
});
