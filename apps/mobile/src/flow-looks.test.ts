import { test } from "node:test";
import assert from "node:assert/strict";
import { newStep } from "@milagre/shared/routine-flows";
import type { FlowRun, FlowStep, RoutineRun } from "@milagre/shared/model";
import { changeKind, changedStepIds, flowRunMatches, flowRunState, runName, runNumber, runSubtitle, runsInProgress, stepRunLine } from "./flow-looks.ts";

const agent = (id: string, prompt = "Do it"): FlowStep => ({ ...newStep("agent", []), id, name: id, prompt });
const flowRun = (flow: Partial<FlowRun>, extra: Partial<RoutineRun> = {}): RoutineRun => ({
  id: extra.id ?? "r1",
  routineId: "x",
  startedAt: extra.startedAt ?? 1000,
  status: "running",
  ...extra,
  flow: { revision: 4, steps: [], state: {}, status: "running", ...flow },
});

test("a draft marks the steps it adds, changes or moves, not an If whose path changed", () => {
  const published: FlowStep[] = [
    agent("classify"),
    { ...newStep("if", []), id: "check", field: "classify.size", yes: [agent("ask")], otherwise: [] },
    agent("implement"),
  ];
  const draft: FlowStep[] = [
    agent("classify", "Classify it better"),
    { ...newStep("if", []), id: "check", field: "classify.size", yes: [agent("ask"), agent("review")], otherwise: [] },
    agent("implement"),
  ];
  assert.deepEqual([...changedStepIds(published, draft)].sort(), ["classify", "review"]);
  assert.deepEqual([...changedStepIds(published, [published[2]!, published[0]!, published[1]!])].sort(), ["check", "classify", "implement"]);
  assert.equal(changedStepIds(published, published).size, 0);
});

test("Runs are numbered from the Routine's count, newest first, and Test runs have none", () => {
  const runs = [flowRun({}, { id: "a", startedAt: 1 }), flowRun({}, { id: "b", startedAt: 3 }), flowRun({ dryRun: true }, { id: "t", startedAt: 2 })];
  const routine = { runCount: 14, runs };
  assert.equal(runNumber(routine, runs[1]!), 14);
  assert.equal(runNumber(routine, runs[0]!), 13);
  assert.equal(runNumber(routine, runs[2]!), null);
  assert.equal(runName(routine, runs[2]!), "Test run");
  // A count behind the list still numbers every Run.
  assert.equal(runName({ runCount: 0, runs }, runs[0]!), "Run 1");
});

test("a Run's state, filters and subtitle follow its flow", () => {
  const steps: FlowStep[] = [agent("implement"), { ...newStep("ask", []), id: "ask", name: "Ask before implementing" }];
  const waiting = flowRun({ steps, status: "waiting", state: { ask: { status: "waiting", approval: { askedAt: 0, expiresAt: 3_600_000, message: "Go?" } } } });
  assert.equal(flowRunState(waiting), "you");
  assert.ok(flowRunMatches(waiting, "you"));
  assert.ok(!flowRunMatches(waiting, "stopped"));
  const failed = flowRun(
    {
      steps,
      status: "failed",
      state: {
        implement: {
          status: "failed",
          error: "tests fail",
          tries: [
            { startedAt: 0, endedAt: 1, error: "x" },
            { startedAt: 1, endedAt: 2, error: "y" },
          ],
        },
      },
    },
    { status: "failed" },
  );
  assert.equal(flowRunState(failed), "failed");
  assert.ok(flowRunMatches(failed, "stopped"));
  assert.equal(runSubtitle({ runCount: 15, runs: [failed] }, failed), "Run 15, stopped at implement after 3 tries");
  const done = flowRun(
    {
      steps,
      status: "done",
      state: { pr: { status: "done", receipt: { kind: "pull-request", url: "u", number: 861, branch: "b", draft: true, matched: false, at: 0 } } },
    },
    { status: "acted" },
  );
  assert.equal(runSubtitle({ runCount: 14, runs: [done] }, done), "Run 14, done, draft PR #861");
  assert.equal(runsInProgress([waiting, failed, done]).length, 1);
  assert.equal(runsInProgress([{ ...waiting, flow: { ...waiting.flow!, dryRun: true } }]).length, 0);
});

test("a step's timeline line says what it did", () => {
  const ask = { ...newStep("ask", []), id: "ask" } as FlowStep;
  assert.equal(
    stepRunLine(
      { kind: "step", step: ask, depth: 0, status: "waiting", run: { status: "waiting", approval: { askedAt: 0, expiresAt: 23 * 3_600_000, message: "" } } },
      0,
    ),
    "No answer in 23 h ends the Run",
  );
  assert.equal(
    stepRunLine(
      {
        kind: "step",
        step: ask,
        depth: 0,
        status: "failed",
        run: { status: "failed", approval: { askedAt: 0, expiresAt: 24 * 3_600_000, message: "", decision: "expired" } },
      },
      0,
    ),
    "Expired after 24 h",
  );
  const check = { ...newStep("if", []), id: "check" } as FlowStep;
  assert.equal(stepRunLine({ kind: "step", step: check, depth: 0, status: "done", run: { status: "done", taken: "yes" } }, 0), "Took Yes");
  assert.equal(stepRunLine({ kind: "step", step: check, depth: 1, status: "not-taken", run: null }, 0), "Not taken");
  assert.equal(
    stepRunLine({ kind: "step", step: agent("a"), depth: 0, status: "done", run: { status: "done", startedAt: 0, endedAt: 41_000 } }, 0),
    "Done in 41 s",
  );
});

test("a change line's kind comes from its first word", () => {
  assert.equal(changeKind("Added Review"), "added");
  assert.equal(changeKind("Removed Review"), "removed");
  assert.equal(changeKind("Classify: prompt changed"), "changed");
});
