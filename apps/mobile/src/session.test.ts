import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { mergeRunsReply } from "./runs-reply.ts";
import type { RunsReply, Snapshot } from "./client.ts";

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
  assert.deepEqual(store.runsFor("host|/p", snapshot), {
    seq: 2,
    runs: { "/p#1": run, "/p#2": { model: "m", approvals: [], questions: [], answered: {}, text: "", steps: [] } },
  });
  const ended = { runs: { seq: 3, runs: {} } } as Snapshot;
  store.confirm(ended);
  assert.equal(store.update("host|/p", ended, scoped), false);
  assert.deepEqual(store.runsFor("host|/p", ended).runs, {});
});
