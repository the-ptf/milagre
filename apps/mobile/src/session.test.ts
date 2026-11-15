import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { reconcileState } from "@milagre/shared/reconcile";
import { mergeRunsReply } from "./runs-reply.ts";
import type { Runs, RunsReply, Snapshot } from "./client.ts";

// Exercise each actual landing path without loading the phone's native session dependencies.
const source = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
const compile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const run = { text: "live", steps: [], model: "m", approvals: [], questions: [], answered: {} };
const initial = { seq: 1, runs: { "/p#1": run, "/p#2": run } };
const scoped: RunsReply = {
  seq: 2,
  runs: { "/p#1": run },
  summaries: { "/p#2": { model: "m", approvals: [], questions: [], answered: {} } },
  detailChats: [1],
};

test("RunsStore merges scoped replies and a newer snapshot prevents resurrection", () => {
  const code = source("./session.tsx").split("class RunsStore {")[1]!.split("\nconst NO_SUBSCRIBE")[0]!;
  const Store = new Function("mergeRunsReply", compile("class RunsStore {" + code + "\nreturn RunsStore;"))(mergeRunsReply);
  const store = new Store();
  const snapshot = { runs: initial } as unknown as Snapshot;
  store.confirm(snapshot);
  assert.equal(store.update("host|/p", snapshot, scoped), true);
  assert.deepEqual(store.runsFor("host|/p", snapshot), mergeRunsReply(initial, scoped));
  const ended = { runs: { seq: 3, runs: {} } } as Snapshot;
  store.confirm(ended);
  assert.equal(store.update("host|/p", ended, scoped), false);
  assert.deepEqual(store.runsFor("host|/p", ended).runs, {});
});

test("the beside pane uses the same merge and rejects a response after snapshot removal", async () => {
  const body = source("./beside-session.tsx").split("const refreshRuns = useCallback(async () => {")[1]!.split("\n  }, [client, path]);")[0]!;
  const client = { runs: async () => scoped };
  let held = { client, path: "/p", snapshot: { runs: initial } };
  const refresh = new Function(
    "client",
    "path",
    "run",
    "opened",
    "setHeld",
    "setError",
    "visibleRunChats",
    "mergeRunsReply",
    "reconcileState",
    compile("return async () => {" + body + "\n};"),
  )(
    client,
    "/p",
    { current: {} },
    { current: true },
    (update: (previous: typeof held) => typeof held) => {
      held = update(held);
    },
    () => {},
    () => [1],
    mergeRunsReply,
    reconcileState,
  );
  await refresh();
  assert.deepEqual(held.snapshot.runs, mergeRunsReply(initial, scoped));
  held = { ...held, snapshot: { runs: { seq: 3, runs: {} } as Runs as typeof initial } };
  await refresh();
  assert.deepEqual(held.snapshot.runs.runs, {});
});
