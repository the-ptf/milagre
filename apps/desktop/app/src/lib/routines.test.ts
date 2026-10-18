import assert from "node:assert/strict";
import test from "node:test";
import { clock } from "@milagre/shared/routines";
import { groupRoutines, refreshRoutines, routineMeta, routineStatus, routinesSnapshot, subscribeRoutines, type RoutineWithRuns } from "./routines.ts";

// Local noon, so "today" and "yesterday" hold in any time zone.
const NOW = new Date(2026, 9, 17, 12, 0).getTime();
const HOUR = 3_600_000;
const base = { enabled: true, createdBy: { kind: "user" as const }, runCount: 0, createdAt: NOW - 48 * HOUR, updatedAt: NOW, runs: [] };

const heartbeat: RoutineWithRuns = {
  ...base,
  id: "h1",
  name: "Watch CI on #461",
  prompt: "Check CI",
  trigger: { kind: "schedule", cron: "*/10 * * * *", timezone: "UTC" },
  target: { kind: "chat", chatId: "/code/milagre#12" },
  maxRuns: 20,
  runCount: 17,
  nextRunAt: NOW + 12 * 60_000,
};
const pausedHeartbeat: RoutineWithRuns = { ...heartbeat, id: "h2", enabled: false, nextRunAt: null };
const linear: RoutineWithRuns = {
  ...base,
  id: "l1",
  name: "Take issues labelled agent",
  prompt: "Work on {{issue.key}}",
  trigger: { kind: "linear", workspace: "milagre", event: "label-added", team: "MIL", label: "agent" },
  target: { kind: "new-chat", projectPath: "/code/milagre-ade", workspace: "worktree" },
  provider: "claude",
  model: "claude-opus-5-5",
  permissionMode: "full",
  runs: [
    {
      id: "run1",
      routineId: "l1",
      startedAt: NOW - 2 * HOUR,
      status: "acted",
      event: {
        kind: "linear",
        key: "linear:i1:h1",
        change: "label-added",
        issue: { id: "i1", key: "MIL-142", title: "t", description: "", url: "u", labels: [], state: "Todo", team: "MIL", workspace: "milagre" },
      },
    },
  ],
};
const webhook: RoutineWithRuns = {
  ...base,
  id: "w1",
  name: "Triage new Sentry crashes",
  prompt: "Triage {{body}}",
  trigger: { kind: "webhook", hookId: "a".repeat(64), signed: true },
  target: { kind: "new-chat", projectPath: "/code/milagre-ade", workspace: "project" },
  enabled: false,
  pausedReason: "3 failed runs in a row: signature mismatch",
};

test("groupRoutines splits heartbeats from triggers and counts the paused ones in either", () => {
  const groups = groupRoutines([heartbeat, linear, pausedHeartbeat, webhook]);
  assert.deepEqual(
    groups.heartbeats.map((routine) => routine.id),
    ["h1", "h2"],
  );
  assert.deepEqual(
    groups.triggers.map((routine) => routine.id),
    ["l1", "w1"],
  );
  assert.deepEqual(
    groups.paused.map((routine) => routine.id),
    ["h2", "w1"],
  );
});

test("a heartbeat's meta says its cadence, its Chat and how many runs are left", () => {
  const meta = routineMeta(heartbeat, { chatTitle: () => "Notification chimes", now: NOW });
  assert.equal(meta, "Every 10 min · in Notification chimes · 3 of 20 Runs left");
  assert.equal(routineMeta({ ...heartbeat, maxRuns: undefined, expiresAt: NOW + 50 * HOUR }, { now: NOW }), "Every 10 min · in a Chat · ends in 2 days");
  // A Heartbeat set for 2 days, read a few seconds later, still ends in 2 days (not 1).
  assert.equal(routineMeta({ ...heartbeat, maxRuns: undefined, expiresAt: NOW + 48 * HOUR - 5000 }, { now: NOW }), "Every 10 min · in a Chat · ends in 2 days");
  assert.equal(routineMeta({ ...heartbeat, maxRuns: undefined, expiresAt: NOW + 3 * HOUR - 5000 }, { now: NOW }), "Every 10 min · in a Chat · ends in 3 h");
  assert.equal(routineStatus(heartbeat, NOW), `Next ${clock(heartbeat.nextRunAt!)}`);
});

test("a Linear trigger's meta names the trigger, where Runs go, and its model and mode", () => {
  const meta = routineMeta(linear, { modelName: () => "Opus 5.5", now: NOW });
  assert.equal(meta, "Linear · label agent added · team MIL · new Worktree in milagre-ade · Opus 5.5 · Full permission");
  assert.equal(routineStatus(linear, NOW), "MIL-142 · 2 h ago");
});

test("a paused webhook says Paused, and it has no model to name", () => {
  assert.equal(routineMeta(webhook, { now: NOW }), "Webhook · new Chat in milagre-ade");
  assert.equal(routineStatus(webhook, NOW), "Paused");
  assert.equal(routineStatus({ ...webhook, enabled: true }, NOW), "No Runs yet");
  const yesterday = NOW - 20 * HOUR;
  const ran = { ...webhook, enabled: true, runs: [{ id: "x", routineId: "w1", startedAt: yesterday, status: "acted" as const }] };
  assert.equal(routineStatus(ran, NOW), `Yesterday ${clock(yesterday)}`);
  assert.equal(routineStatus({ ...ran, runs: [{ ...ran.runs[0]!, startedAt: NOW - 3 * HOUR }] }, NOW), "3 h ago");
});

test("a refresh that reads the same Routines publishes nothing, and a change publishes once", async () => {
  let list = [heartbeat, linear];
  const globals = globalThis as unknown as { window?: unknown };
  globals.window = {
    milagre: {
      readRoutinesEnabled: async () => ({ enabled: true }),
      listRoutines: async () => ({ routines: structuredClone(list) }),
      onRoutinesChanged: () => () => {},
    },
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  let published = 0;
  const stop = subscribeRoutines(() => {
    published += 1;
  });
  try {
    await settle();
    assert.equal(published, 1);
    const first = routinesSnapshot();
    refreshRoutines();
    await settle();
    assert.equal(published, 1);
    assert.equal(routinesSnapshot(), first);
    list = [heartbeat];
    refreshRoutines();
    await settle();
    assert.equal(published, 2);
    assert.deepEqual(
      routinesSnapshot().routines.map((routine) => routine.id),
      ["h1"],
    );
  } finally {
    stop();
    delete globals.window;
  }
});
