import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ORCHESTRATOR_DEFAULTS,
  autopilotDecision,
  autopilotPending,
  foldOrchestratorAnswers,
  isMemoryImporting,
  boardColumn,
  pullRequestState,
  isIrreversible,
  keywordRoute,
  needsYouLine,
  normalizeOrchestratorMemory,
  normalizeOrchestratorSettings,
  normalizeOrchestratorTask,
  pickAccount,
  pickComputer,
  recordTrust,
  roleById,
  taskBlockedText,
  taskDoneAt,
  taskOutcomePrompt,
  taskSwept,
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

test("the Orchestrator name is trimmed to one line of at most 40 characters and falls back when empty", () => {
  assert.equal(normalizeOrchestratorSettings(null).name, "Orchestrator");
  assert.equal(normalizeOrchestratorSettings({ name: "  Jarvis  " }).name, "Jarvis");
  assert.equal(normalizeOrchestratorSettings({ name: "a\nb" }).name, "a b");
  assert.equal(normalizeOrchestratorSettings({ name: "x".repeat(60) }).name, "x".repeat(40));
  assert.equal(normalizeOrchestratorSettings({ name: "   " }).name, "Orchestrator");
  assert.equal(normalizeOrchestratorSettings({ name: 5 }).name, "Orchestrator");
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

test("a finished reply cannot bypass the required PR, but marking the Chat Done accepts the task", () => {
  const base = { done: false, needsYou: false, outcome: "pull-request" };
  assert.equal(boardColumn(base), "running");
  assert.equal(boardColumn({ ...base, finished: true }), "needs");
  assert.equal(boardColumn({ ...base, done: true }), "done");
  assert.equal(boardColumn({ ...base, pullRequest: "open" }), "done");
  assert.equal(boardColumn({ ...base, pullRequest: "merged" }), "done");
  assert.equal(boardColumn({ ...base, pullRequest: "closed" }), "needs");
  assert.equal(boardColumn({ ...base, done: true, needsYou: true, pullRequest: "merged" }), "needs");
  assert.equal(boardColumn({ ...base, active: true, pullRequest: "open" }), "running");
  assert.equal(boardColumn({ ...base, outcome: "reply", finished: true }), "done");
  assert.equal(boardColumn({ ...base, outcome: "reply", done: true }), "done");
  assert.equal(boardColumn({ ...base, outcome: "merged", pullRequest: "open" }), "review");
  assert.equal(boardColumn({ ...base, outcome: "merged", pullRequest: "merged" }), "done");
  assert.equal(boardColumn({ ...base, outcome: "merged", pullRequest: "closed", done: true }), "done");
  assert.equal(boardColumn({ ...base, outcome: "merged", pullRequest: "closed" }), "needs");
  assert.equal(boardColumn({ done: false, needsYou: false, finished: true }), "done", "no recorded outcome finishes with its agent");
});

test("outcomes persist; unknown settings require a PR and tasks saved without one finish with their agent", () => {
  for (const outcome of ["pull-request", "merged", "reply"]) {
    assert.equal(normalizeOrchestratorSettings({ outcome }).outcome, outcome);
    assert.equal(normalizeOrchestratorTask({ id: "t", prompt: "fix", outcome }).outcome, outcome);
  }
  for (const outcome of [undefined, "invented", null]) {
    assert.equal(normalizeOrchestratorSettings({ outcome }).outcome, "pull-request");
    assert.equal(normalizeOrchestratorTask({ id: "t", prompt: "fix", outcome }).outcome, "reply");
  }
});

test("a Chat's pull requests read as one board state: open wins, then merged", () => {
  assert.equal(pullRequestState(["MERGED", "OPEN"]), "open");
  assert.equal(pullRequestState(["CLOSED", "MERGED"]), "merged");
  assert.equal(pullRequestState(["CLOSED"]), "closed");
  assert.equal(pullRequestState([]), null);
});

test("irreversible actions are recognized from commands, tools and questions", () => {
  assert.equal(isIrreversible({ command: "git push origin main" }), true);
  assert.equal(isIrreversible({ command: "git push --force origin feature" }), true);
  assert.equal(isIrreversible({ command: "git push origin feature/rest-timer" }), false);
  assert.equal(isIrreversible({ command: "gh pr merge 212 --squash" }), true);
  assert.equal(isIrreversible({ command: "npm test" }), false);
  assert.equal(
    isIrreversible({ command: `/tmp/hgq.sh "delete from public.nutrition_access where user_id in ('a')"` }),
    true,
    "a database delete always waits for the owner",
  );
  assert.equal(isIrreversible({ command: "psql -c 'UPDATE profiles SET plan = 1'" }), true);
  assert.equal(isIrreversible({ command: "supabase db push" }), true);
  assert.equal(isIrreversible({ command: "curl -X DELETE https://api.example.com/users/1" }), true);
  assert.equal(isIrreversible({ command: "security find-generic-password -s x -w" }), true, "reading a stored secret waits too");
  assert.equal(isIrreversible({ command: "grep -rn 'delete' src" }), false);
  assert.equal(isIrreversible({ command: "curl -s https://example.com" }), false);
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
  assert.equal(task.images, 0);
  assert.equal(normalizeOrchestratorTask({ id: "t", prompt: "x", images: 3 }).images, 3);
  assert.equal(normalizeOrchestratorTask({ id: "t", prompt: "x", images: -2 }).images, 0);
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

test("an answer waiting out its veto window keeps the request off the owner's plate until it runs", () => {
  const now = 1_800_000_000_000;
  const task = { answered: [{ requestId: "r1", decision: "vetoed", summary: "allowed ls", until: now + 20_000 }] };
  const run = { approvals: [{ requestId: "r1" }], questions: [], answered: {} };
  assert.equal(autopilotPending(task, run, now)?.summary, "allowed ls");
  assert.equal(autopilotPending(task, run, now + 30_000), null, "past the window it is the owner's again");
  assert.equal(autopilotPending(task, { ...run, answered: { r1: "allow" } }, now), null);
  assert.equal(autopilotPending({ answered: [...task.answered, { requestId: "r1", decision: "answered" }] }, run, now), null);
  assert.equal(autopilotPending(task, { approvals: [{ requestId: "r2" }] }, now), null);
});

test("back-to-back autopilot answers fold into one line that lists them all", () => {
  const answer = (id, summary) => ({ message: { id, context: { kind: "orchestrator-answer", summary } } });
  const reply = (id) => ({ message: { id, role: "assistant", context: null } });
  const entries = foldOrchestratorAnswers([answer(1, "allowed `ls`"), answer(2, "allowed Use Read?"), reply(3), answer(4, "picked Monthly")]);
  assert.deepEqual(entries[0].message.context.summaries, ["allowed `ls`", "allowed Use Read?"]);
  assert.equal(entries[1].hidden, true);
  assert.equal(entries[2].hidden, undefined);
  assert.deepEqual(entries[3].message.context.summaries, ["picked Monthly"], "a reply in between starts a new line");
});

test("answers saved before the Pebble line, as plain notes, fold in too", () => {
  const plain = (id, body) => ({ message: { id, role: "assistant", body, context: null } });
  const entries = foldOrchestratorAnswers([
    plain(1, "The Orchestrator answered for you: allowed `ls`."),
    plain(2, "The Orchestrator answered for you: picked Monthly."),
    plain(3, "Here is what I changed."),
  ]);
  assert.deepEqual(entries[0].message.context, { kind: "orchestrator-answer", summary: "allowed `ls`", summaries: ["allowed `ls`", "picked Monthly"] });
  assert.equal(entries[1].hidden, true);
  assert.equal(entries[2].message.context, null);
});

test("a task leaves the board when its Chat is gone, or after the Done retention like a Done Chat", () => {
  const HOUR = 60 * 60 * 1000;
  const now = 100 * HOUR;
  const finished = (lastAt, extra = {}) => ({ summary: { lastOutcome: "completed", lastAt, ...extra } });
  assert.equal(taskSwept(undefined, { retentionHours: 24, now }), true);
  assert.equal(taskSwept({ archived: true }, { retentionHours: 0, now }), true);
  assert.equal(taskSwept({ done_at: now - 24 * HOUR }, { retentionHours: 24, now }), true);
  assert.equal(taskSwept({ done_at: now - 23 * HOUR }, { retentionHours: 24, now }), false);
  assert.equal(taskSwept(finished(now - 2 * HOUR), { retentionHours: 1, now, outcome: "reply" }), true);
  assert.equal(taskSwept(finished(now - 2 * HOUR), { retentionHours: 0, now, outcome: "reply" }), false);
  assert.equal(taskSwept(finished(now - 2 * HOUR), { busy: true, retentionHours: 1, now, outcome: "reply" }), false);
  assert.equal(taskSwept(finished(now - 2 * HOUR, { pullRequests: ["https://x/pull/1"] }), { retentionHours: 1, now, outcome: "reply" }), false);
  assert.equal(
    taskSwept(finished(now - 2 * HOUR), { retentionHours: 1, now, outcome: "pull-request" }),
    false,
    "a task that still needs its PR stays on the board",
  );
  assert.equal(taskSwept({ summary: { lastOutcome: "failed", lastAt: 1 } }, { retentionHours: 1, now }), false);
  assert.equal(taskDoneAt({ summary: { lastOutcome: "cancelled", lastAt: 5 } }), 5);
  assert.equal(taskDoneAt({ done_at: 9, summary: { lastOutcome: "completed", lastAt: 5 } }, true), 9);
});

test("a task its agent marked blocked waits on the owner until a turn runs or its Chat is marked Done", () => {
  const blocked = { reason: "Sign in to the resend MCP server\nwith /mcp", at: 7 };
  const session = { summary: { lastOutcome: "completed", lastAt: 5 }, orchestrator: { taskId: "t", hidden: true, blocked } };
  assert.equal(taskBlockedText(session), "Blocked: Sign in to the resend MCP server with /mcp");
  assert.equal(taskBlockedText(session, true), null, "a running turn has cleared it");
  assert.equal(taskBlockedText({ ...session, done_at: 9 }), null);
  assert.equal(taskBlockedText({ ...session, orchestrator: { taskId: "t", hidden: true, blocked: { reason: "  ", at: 7 } } }), null);
  assert.equal(taskDoneAt(session), null, "a blocked task never counts as Done on its own");
  assert.equal(taskDoneAt({ ...session, done_at: 9 }), 9);
  assert.equal(taskSwept(session, { retentionHours: 1, now: 10 ** 12, outcome: "reply" }), false);
  for (const outcome of ["reply", "pull-request", "merged"]) assert.match(taskOutcomePrompt(outcome), /milagre task_blocked tool/);
});

test("the sidebar names the one task that needs the owner and why, else counts them", () => {
  const card = (title, detail) => ({ task: { title }, detail });
  assert.equal(needsYouLine([]), null);
  assert.equal(needsYouLine([card("Email templates", "Blocked: Sign in to resend")]), "Email templates. Blocked: Sign in to resend");
  assert.equal(needsYouLine([card("a", "x"), card("b", "y")]), "2 need you");
});
