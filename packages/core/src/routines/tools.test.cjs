const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { inputSchema, runTool } = require("../linked-tools.cjs");
const { createRoutineStore } = require("./store.cjs");
const { ROUTINE_TOOL_NAMES, createRoutineTools } = require("./tools.cjs");

const START = Date.UTC(2026, 0, 5, 10, 0, 0);
const DAY = 864e5;
const CHAT = "/code/app#s1";
const OTHER_CHAT = "/code/other#s9";
const SETTINGS = { provider: "claude", model: "opus", permissionMode: "default" };

function setup({ settings = SETTINGS, timezone = "UTC", workspaces = ["acme"], keepChat } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routine-tools-"));
  const clock = { t: START };
  let n = 0;
  const store = createRoutineStore({ file: path.join(dir, "routines.json"), now: () => clock.t, id: () => `id${++n}` });
  const ran = [];
  const scheduler = {
    async runNow(id) {
      ran.push(id);
      return { id: "run1", routineId: id, status: "acted", summary: "Pinged CI" };
    },
  };
  const tools = createRoutineTools({
    store,
    scheduler,
    chatSettings: () => settings,
    defaultTimezone: () => timezone,
    linearWorkspaces: () => workspaces,
    now: () => clock.t,
    ...(keepChat ? { keepChat } : {}),
  });
  const call = (name, args, chatId = CHAT) =>
    runTool(
      tools.definitions(chatId).find((tool) => tool.name === name),
      args,
    );
  return { store, call, clock, ran, tools };
}

const create = { name: "watch CI", prompt: "check the PR", every: "15m" };

test("the tool text asks for a Heartbeat's end up front, since deleting it later may need the user's approval", () => {
  const { tools } = setup();
  const description = (name) => tools.definitions(CHAT).find((tool) => tool.name === name).description;
  assert.match(description("heartbeat_create"), /end now with expiresIn or maxRuns/);
  assert.match(description("heartbeat_create"), /deleting it later may need the user's approval/);
  assert.match(description("routine_delete"), /may need the user's approval/);
  // Product nouns as GLOSSARY.md has them.
  for (const tool of tools.definitions(CHAT)) assert.doesNotMatch(tool.description, /\b(routine|heartbeat|worktree)s?\b/, tool.name);
});

test("the tool names and definitions line up", () => {
  const { tools } = setup();
  assert.deepEqual(ROUTINE_TOOL_NAMES, ["routine_list", "heartbeat_create", "routine_create", "routine_update", "routine_delete", "routine_run_now"]);
  assert.deepEqual(
    tools.definitions(CHAT).map((tool) => tool.name),
    ROUTINE_TOOL_NAMES,
  );
  for (const tool of tools.definitions(CHAT)) assert.doesNotMatch(JSON.stringify(inputSchema(tool)), /\$ref|\$defs/, tool.name);
});

test("heartbeat_create with every stores the cron, the default expiry and the Chat's settings", async () => {
  const { store, call } = setup();
  const result = await call("heartbeat_create", create);
  assert.equal(result.isError, false);
  assert.equal(
    result.text,
    '{"routine":{"id":"id1","name":"watch CI"}}\nHeartbeat "watch CI" set: every 15 min, next 10:15, ends 2026-01-12 10:00. Reply "(pass) <reason>" on beats where nothing needs doing.',
  );
  const [routine] = store.list();
  assert.equal(routine.trigger.cron, "*/15 * * * *");
  assert.equal(routine.trigger.timezone, "UTC");
  assert.equal(routine.expiresAt, START + 7 * DAY);
  assert.deepEqual(routine.target, { kind: "chat", chatId: CHAT });
  assert.deepEqual(routine.createdBy, { kind: "agent", chatId: CHAT });
  assert.equal(routine.provider, "claude");
  assert.equal(routine.model, "opus");
  assert.equal(routine.permissionMode, "default");
});

test("heartbeat_create tells the agent to delete the heartbeat when the work is done", () => {
  const { tools } = setup();
  const tool = tools.definitions(CHAT).find((item) => item.name === "heartbeat_create");
  assert.match(tool.description, /delete/i);
  assert.match(tool.description, /merged/);
  assert.equal(tool.readOnly, false);
});

test("heartbeat_create works without chat settings, and uses the default timezone in its times", async () => {
  const { store, call } = setup({ settings: null, timezone: "America/Sao_Paulo" });
  const result = await call("heartbeat_create", { ...create, maxRuns: 3 });
  assert.equal(result.isError, false);
  assert.match(result.text, /next 07:15, ends after 3 runs\./);
  const [routine] = store.list();
  assert.equal(routine.trigger.timezone, "America/Sao_Paulo");
  assert.equal(routine.provider, undefined);
  assert.equal(routine.expiresAt, undefined);
});

test("heartbeat_create takes a cron, a timezone and an expiresIn", async () => {
  const { store, call } = setup();
  const result = await call("heartbeat_create", { name: "daily", prompt: "p", cron: "0 9 * * *", timezone: "America/New_York", expiresIn: "2d" });
  assert.equal(result.isError, false);
  assert.match(result.text, /set: daily 09:00, next 09:00, ends 2026-01-07 05:00\./);
  assert.equal(store.list()[0].expiresAt, START + 2 * DAY);
});

test("heartbeat_create needs exactly one of cron or every", async () => {
  const { store, call } = setup();
  const both = await call("heartbeat_create", { ...create, cron: "*/5 * * * *" });
  assert.equal(both.isError, true);
  assert.match(both.text, /cron/);
  assert.match(both.text, /every/);
  const neither = await call("heartbeat_create", { name: "x", prompt: "y" });
  assert.equal(neither.isError, true);
  assert.match(neither.text, /cron/);
  assert.equal(store.list().length, 0);
});

test("heartbeat_create surfaces store errors and checks its limits", async () => {
  const { call } = setup();
  const badEvery = await call("heartbeat_create", { ...create, every: "90s" });
  assert.equal(badEvery.isError, true);
  assert.match(badEvery.text, /Invalid every/);
  const badCron = await call("heartbeat_create", { ...create, every: undefined, cron: "* * *" });
  assert.equal(badCron.isError, true);
  assert.match(badCron.text, /Invalid cron/);
  const longName = await call("heartbeat_create", { ...create, name: "n".repeat(81) });
  assert.equal(longName.isError, true);
  assert.match(longName.text, /Invalid arguments/);
  const manyRuns = await call("heartbeat_create", { ...create, maxRuns: 1001 });
  assert.equal(manyRuns.isError, true);
});

test("a second heartbeat_create with the same name updates the same Routine", async () => {
  const { store, call } = setup();
  await call("heartbeat_create", create);
  const first = store.list()[0];
  await call("heartbeat_create", { ...create, every: "1h", prompt: "check again" });
  const all = store.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, first.id);
  assert.equal(all[0].trigger.cron, "0 */1 * * *");
  assert.equal(all[0].prompt, "check again");
});

test("routine_list shows this Project's heartbeats and nothing else", async () => {
  const { call } = setup();
  assert.equal((await call("routine_list", {})).text, "No Routines in this Project.");
  await call("heartbeat_create", create);
  await call("heartbeat_create", { name: "hourly", prompt: "p", cron: "30 * * * *" });
  await call("heartbeat_create", { name: "elsewhere", prompt: "p", every: "1h" }, OTHER_CHAT);
  // Another Chat in the same Project counts.
  await call("heartbeat_create", { name: "sibling", prompt: "p", every: "30m" }, "/code/app#s2");
  const result = await call("routine_list", {});
  const lines = result.text.split("\n");
  assert.equal(lines.length, 3);
  assert.ok(lines.every((line) => !line.includes("elsewhere")));
  assert.match(
    lines.find((line) => line.includes("watch CI")),
    /^id1 · watch CI · every 15 min · 10:15 · enabled$/,
  );
  assert.match(
    lines.find((line) => line.includes("hourly")),
    /^id2 · hourly · cron "30 \* \* \* \*" · 10:30 · enabled$/,
  );
});

test("routine_update changes the pieces and converts every and expiresIn", async () => {
  const { store, call, clock } = setup();
  await call("heartbeat_create", create);
  clock.t += 60_000;
  const result = await call("routine_update", { id: "id1", every: "2h", expiresIn: "1d", name: "renamed", prompt: "new", maxRuns: 5 });
  assert.equal(result.isError, false);
  assert.match(result.text, /^Updated "renamed": every 2 h, next 12:00, ends 2026-01-06 10:01 or after 5 runs\.$/);
  const routine = store.get("id1");
  assert.equal(routine.trigger.cron, "0 */2 * * *");
  assert.equal(routine.expiresAt, START + 60_000 + DAY);
  assert.equal(routine.maxRuns, 5);
  assert.equal(routine.prompt, "new");
});

test("routine_update can pause and resume, and set a timezone and cron", async () => {
  const { store, call } = setup();
  await call("heartbeat_create", create);
  const paused = await call("routine_update", { id: "id1", enabled: false });
  assert.equal(paused.isError, false);
  assert.equal(store.get("id1").enabled, false);
  assert.match(paused.text, /paused/);
  const moved = await call("routine_update", { id: "id1", enabled: true, cron: "0 9 * * *", timezone: "Asia/Tokyo" });
  assert.equal(moved.isError, false);
  assert.equal(store.get("id1").trigger.timezone, "Asia/Tokyo");
  assert.match(moved.text, /next 09:00/);
});

test("routine_update errors are clear", async () => {
  const { call } = setup();
  await call("heartbeat_create", create);
  const both = await call("routine_update", { id: "id1", cron: "* * * * *", every: "1h" });
  assert.equal(both.isError, true);
  assert.match(both.text, /cron/);
  assert.match(both.text, /every/);
  const badExpiry = await call("routine_update", { id: "id1", expiresIn: "soon" });
  assert.equal(badExpiry.isError, true);
  assert.match(badExpiry.text, /Invalid expiresIn/);
  const badCron = await call("routine_update", { id: "id1", cron: "nope" });
  assert.equal(badCron.isError, true);
  assert.match(badCron.text, /Invalid cron/);
});

test("update, delete and run now are limited to the caller's Project", async () => {
  const { store, call, ran } = setup();
  await call("heartbeat_create", { name: "elsewhere", prompt: "p", every: "1h" }, OTHER_CHAT);
  for (const [name, args] of [
    ["routine_update", { id: "id1", enabled: false }],
    ["routine_delete", { id: "id1" }],
    ["routine_run_now", { id: "id1" }],
  ]) {
    const result = await call(name, args);
    assert.equal(result.isError, true, name);
    assert.match(result.text, /not found/, name);
  }
  assert.equal(store.get("id1").enabled, true);
  assert.deepEqual(ran, []);
  const missing = await call("routine_delete", { id: "nope" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /not found/);
});

test("routine_delete removes a Routine in the Project", async () => {
  const { store, call } = setup();
  await call("heartbeat_create", create);
  const result = await call("routine_delete", { id: "id1" });
  assert.equal(result.isError, false);
  assert.equal(result.text, 'Deleted "watch CI".');
  assert.equal(store.list().length, 0);
});

test("routine_run_now runs it through the scheduler and reports how it went", async () => {
  const { call, ran } = setup();
  await call("heartbeat_create", create);
  const result = await call("routine_run_now", { id: "id1" });
  assert.equal(result.isError, false);
  assert.deepEqual(ran, ["id1"]);
  assert.equal(result.text, 'Ran "watch CI": acted. Pinged CI');
});

test("Codex and ACP auto-approve routine_list only: every routine write follows the Chat's permission mode", () => {
  const { isAcpPlanToolPermission, isCodexPlanToolApproval } = require("../agents/permissions.cjs");
  const params = (tool) => ({
    serverName: "milagre",
    mode: "form",
    message: `Allow the milagre MCP server to run tool "${tool}"?`,
    requestedSchema: { type: "object", properties: {} },
    _meta: { codex_approval_kind: "mcp_tool_call", tool_params: {} },
  });
  for (const name of ROUTINE_TOOL_NAMES) {
    const ungated = name === "routine_list";
    assert.equal(isCodexPlanToolApproval(params(name)), ungated, name);
    assert.equal(isAcpPlanToolPermission({ toolCall: { _meta: { mcp: { server: "milagre", tool: name } } } }), ungated, name);
  }
  // Claude takes the ungated ones as allowedTools: the reads (routine_list is read-only) and no routine write.
  const { isUngatedMilagreTool } = require("../agents/permissions.cjs");
  const { tools } = setup();
  for (const tool of tools.definitions(CHAT)) assert.equal(isUngatedMilagreTool(tool), tool.name === "routine_list", tool.name);
});

test("expiresIn is capped at 30 days in heartbeat_create and routine_update, and a refused one saves nothing", async () => {
  const { store, call } = setup();
  const tooLong = await call("heartbeat_create", { ...create, expiresIn: "45d" });
  assert.equal(tooLong.isError, true);
  assert.match(tooLong.text, /at most 30d/);
  const huge = await call("heartbeat_create", { ...create, expiresIn: "9999999999d" });
  assert.equal(huge.isError, true);
  assert.deepEqual(store.list(), []);
  const badZone = await call("heartbeat_create", { ...create, timezone: "Mars/Base" });
  assert.equal(badZone.isError, true);
  assert.deepEqual(store.list(), []);
  assert.equal((await call("heartbeat_create", { ...create, expiresIn: "30d" })).isError, false);
  const update = await call("routine_update", { id: "id1", expiresIn: "31d" });
  assert.equal(update.isError, true);
  assert.match(update.text, /at most 30d/);
  assert.equal(store.get("id1").expiresAt, START + 30 * DAY);
});

test("routine_create with a Linear label trigger stores a new-chat Routine for the caller's Project", async () => {
  const { store, call } = setup();
  const result = await call("routine_create", { name: "triage", prompt: "look at it", trigger: "linear", linearEvent: "label-added", label: "agent" });
  assert.equal(result.isError, false);
  assert.equal(result.text, 'Routine "triage" set: Linear · label agent added, runs in a new Worktree in app.');
  const [routine] = store.list();
  assert.deepEqual(routine.trigger, { kind: "linear", workspace: "acme", event: "label-added", label: "agent" });
  assert.deepEqual(routine.target, { kind: "new-chat", projectPath: "/code/app", workspace: "worktree" });
  assert.deepEqual(routine.createdBy, { kind: "agent", chatId: CHAT });
  assert.equal(routine.model, "opus");
});

test("routine_create schedules, validates and rejects webhooks", async () => {
  const { store, call, tools } = setup({ workspaces: ["a", "b"] });
  const ok = await call("routine_create", { name: "nightly", prompt: "p", trigger: "schedule", every: "2h", projectWorkspace: "project" });
  assert.equal(ok.isError, false);
  assert.match(ok.text, /runs in the Project folder in app\.$/);
  assert.equal(store.list()[0].trigger.cron, "0 */2 * * *");
  assert.equal((await call("routine_create", { name: "x", prompt: "p", trigger: "schedule" })).isError, true);
  assert.equal((await call("routine_create", { name: "x", prompt: "p", trigger: "linear", linearEvent: "label-added" })).isError, true);
  assert.equal((await call("routine_create", { name: "x", prompt: "p", trigger: "linear", linearEvent: "state" })).isError, true);
  const noWorkspace = await call("routine_create", { name: "x", prompt: "p", trigger: "linear", linearEvent: "assigned" });
  assert.match(noWorkspace.text, /Say which Linear workspace/);
  assert.equal((await call("routine_create", { name: "x", prompt: "p", trigger: "linear", linearEvent: "assigned", workspace: "b" })).isError, false);
  assert.equal((await call("routine_create", { name: "w", prompt: "p", trigger: "webhook" })).isError, true);
  const tool = tools.definitions(CHAT).find((item) => item.name === "routine_create");
  assert.match(tool.description, /New Routine form/);
  assert.match(tool.description, /fresh Chat/);
  assert.equal(store.list().length, 2);
});

test("routines of the Project are found from a sibling Chat, by chat or by projectPath", async () => {
  const { store, call } = setup();
  await call("routine_create", { name: "triage", prompt: "p", trigger: "linear", linearEvent: "assigned", workspace: "acme" });
  await call("heartbeat_create", create);
  const sibling = "/code/app#s2";
  const listed = await call("routine_list", {}, sibling);
  assert.match(listed.text, /triage/);
  assert.match(listed.text, /watch CI/);
  assert.match((await call("routine_list", {}, OTHER_CHAT)).text, /No Routines/);
  const [triage] = store.list();
  assert.equal((await call("routine_update", { id: triage.id, enabled: false }, sibling)).isError, false);
  assert.equal((await call("routine_run_now", { id: triage.id }, sibling)).isError, false);
  assert.equal((await call("routine_delete", { id: triage.id }, OTHER_CHAT)).isError, true);
  assert.equal((await call("routine_delete", { id: triage.id }, sibling)).isError, false);
});

test("an uneven every is refused with the rule, by every tool that takes one, and nothing is saved", async () => {
  const { store, call } = setup();
  const minutes = "Every N minutes must divide 60 (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30)";
  const hours = "Every N hours must divide 24 (1, 2, 3, 4, 6, 8, 12, 24)";
  for (const [every, rule] of [
    ["59m", minutes],
    ["23h", hours],
  ]) {
    const heartbeat = await call("heartbeat_create", { ...create, every });
    assert.equal(heartbeat.isError, true);
    assert.match(heartbeat.text, new RegExp(rule.replace(/[()]/g, "\\$&")));
    const routine = await call("routine_create", { name: "x", prompt: "p", trigger: "schedule", every });
    assert.equal(routine.isError, true);
    assert.match(routine.text, new RegExp(rule.replace(/[()]/g, "\\$&")));
  }
  assert.deepEqual(store.list(), []);
  await call("heartbeat_create", create);
  const update = await call("routine_update", { id: store.list()[0].id, every: "45m" });
  assert.equal(update.isError, true);
  assert.match(update.text, /Every N minutes must divide 60/);
  assert.equal(store.list()[0].trigger.cron, "*/15 * * * *");
  const tool = setup()
    .tools.definitions(CHAT)
    .find((item) => item.name === "heartbeat_create");
  assert.match(JSON.stringify(inputSchema(tool)), /divide 60/);
});

test("routine_update changes a Linear trigger's filters and keeps every trigger field it wasn't given", async () => {
  const { store, call } = setup();
  await call("routine_create", { name: "triage", prompt: "p", trigger: "linear", linearEvent: "label-added", label: "agent", team: "MIL" });
  const [routine] = store.list();
  const relabeled = await call("routine_update", { id: routine.id, label: "bug" });
  assert.equal(relabeled.isError, false, relabeled.text);
  assert.deepEqual(store.get(routine.id).trigger, { kind: "linear", workspace: "acme", event: "label-added", label: "bug", team: "MIL" });

  // Another event takes its own filter; the label goes with the event it belonged to.
  assert.equal((await call("routine_update", { id: routine.id, linearEvent: "state" })).isError, true, "state needs a state");
  assert.deepEqual(store.get(routine.id).trigger.label, "bug");
  const moved = await call("routine_update", { id: routine.id, linearEvent: "state", state: "In Review" });
  assert.equal(moved.isError, false, moved.text);
  assert.deepEqual(store.get(routine.id).trigger, { kind: "linear", workspace: "acme", event: "state", state: "In Review", team: "MIL" });
  const team = await call("routine_update", { id: routine.id, team: "ENG" });
  assert.equal(team.isError, false, team.text);
  assert.deepEqual(store.get(routine.id).trigger, { kind: "linear", workspace: "acme", event: "state", state: "In Review", team: "ENG" });

  // A schedule has no Linear filters.
  await call("heartbeat_create", create);
  const beat = store.list().find((item) => item.trigger.kind === "schedule");
  assert.equal((await call("routine_update", { id: beat.id, label: "bug" })).isError, true);
});

test("a Linear trigger without the filter its event needs is refused by the store, however it arrives", () => {
  const { store } = setup();
  const target = { kind: "new-chat", projectPath: "/code/app", workspace: "worktree" };
  const make = (trigger) => store.create({ name: "x", prompt: "p", trigger, target, createdBy: { kind: "user" } });
  assert.throws(() => make({ kind: "linear", workspace: "acme", event: "label-added" }), /label/);
  assert.throws(() => make({ kind: "linear", workspace: "acme", event: "state" }), /state/);
  const ok = make({ kind: "linear", workspace: "acme", event: "state", state: "Done" });
  assert.throws(() => store.update(ok.id, { trigger: { kind: "linear", workspace: "acme", event: "label-added" } }), /label/);
});

test("routine_update clears a Linear trigger's team filter with null or an empty string", async () => {
  const { store, call } = setup();
  await call("routine_create", { name: "triage", prompt: "p", trigger: "linear", linearEvent: "assigned", team: "MIL" });
  const [routine] = store.list();
  for (const team of [null, ""]) {
    assert.equal((await call("routine_update", { id: routine.id, team: "ENG" })).isError, false);
    const cleared = await call("routine_update", { id: routine.id, team });
    assert.equal(cleared.isError, false, cleared.text);
    assert.deepEqual(store.get(routine.id).trigger, { kind: "linear", workspace: "acme", event: "assigned" }, JSON.stringify(team));
  }
});

test("heartbeat_create keeps its Chat once the Heartbeat is saved; a refused one keeps nothing", async () => {
  const kept = [];
  const { store, call } = setup({ keepChat: async (chatId) => void kept.push([chatId, store.list().length]) });
  assert.equal((await call("heartbeat_create", { ...create, every: "7m" })).isError, true);
  assert.deepEqual(kept, []);
  assert.equal((await call("heartbeat_create", create)).isError, false);
  // The Heartbeat was in the store when its Chat was kept.
  assert.deepEqual(kept, [[CHAT, 1]]);
});

test("routine_update keeps a Heartbeat's Chat; routine_create, whose Runs start Chats of their own, keeps none", async () => {
  const kept = [];
  const { call } = setup({ keepChat: async (chatId) => void kept.push(chatId) });
  const made = await call("routine_create", { name: "triage", prompt: "look", trigger: "schedule", every: "1h" });
  assert.equal(made.isError, false, made.text);
  assert.deepEqual(kept, []);
  const heartbeat = JSON.parse((await call("heartbeat_create", create)).text.split("\n")[0]).routine;
  kept.length = 0;
  assert.equal((await call("routine_update", { id: heartbeat.id, prompt: "check the PR again" })).isError, false);
  assert.deepEqual(kept, [CHAT]);
});

test("routine_create and routine_update set the fallback a failed Run retries on, and null clears it", async () => {
  const { store, call } = setup();
  const made = await call("routine_create", {
    name: "nightly",
    prompt: "p",
    trigger: "schedule",
    every: "2h",
    fallbackProvider: "codex",
    fallbackModel: "gpt-6.1-sol",
    fallbackEffort: "high",
  });
  assert.equal(made.isError, false);
  assert.match(made.text, /retries on codex gpt-6\.1-sol \(high\)\.$/);
  const [routine] = store.list();
  assert.deepEqual(routine.fallback, { provider: "codex", model: "gpt-6.1-sol", effort: "high" });

  const changed = await call("routine_update", { id: routine.id, fallbackProvider: "claude", fallbackModel: "claude-opus-5-5" });
  assert.equal(changed.isError, false);
  assert.deepEqual(store.get(routine.id).fallback, { provider: "claude", model: "claude-opus-5-5" });
  const cleared = await call("routine_update", { id: routine.id, fallbackProvider: null });
  assert.match(cleared.text, /retries on another installed provider's recommended model\.$/);
  assert.equal(store.get(routine.id).fallback, undefined);

  // A provider without a model, or a model without a provider, is refused before anything is saved.
  assert.equal((await call("routine_update", { id: routine.id, fallbackModel: "gpt-6.1-sol" })).isError, true);
  assert.equal((await call("routine_create", { name: "x", prompt: "p", trigger: "schedule", every: "2h", fallbackProvider: "claude" })).isError, true);
  assert.equal(
    (await call("routine_create", { name: "y", prompt: "p", trigger: "schedule", every: "2h", fallbackProvider: "gpt", fallbackModel: "m" })).isError,
    true,
  );
  assert.equal(store.list().length, 1);
});

test("the prompt limit stays at 4000 characters", async () => {
  const { call } = setup();
  assert.equal((await call("routine_create", { name: "long", prompt: "p".repeat(4001), trigger: "schedule", every: "2h" })).isError, true);
  assert.equal((await call("routine_create", { name: "fits", prompt: "p".repeat(4000), trigger: "schedule", every: "2h" })).isError, false);
});
