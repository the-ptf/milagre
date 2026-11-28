const { flattenSteps } = require("@milagre/shared/routine-flows");

/**
 * What the Orchestrator's autopilot needs from flow Runs: which approval waits, the answer it plans, and its own approval.
 * It hooks the flow's "waits for you" notice, which goes out exactly when an approval starts waiting.
 */
function flowAutopilot({ store, scheduler, changed, actions }) {
  let listener = () => {};
  const notify = actions.notify;
  actions.notify = (routine, run, text) => {
    notify?.(routine, run, text);
    const current = store.getRun(run.id)?.run;
    const step = flattenSteps(current?.flow?.steps ?? []).find((entry) => {
      const approval = current.flow.state[entry.step.id]?.approval;
      return approval && !approval.decision;
    })?.step;
    if (!step) return;
    try {
      listener({ routine, run: current, step });
    } catch (error) {
      console.warn("[routines] autopilot couldn't look at an approval", error);
    }
  };
  return {
    onApprovalWaiting(next) {
      listener = next ?? (() => {});
    },
    flowApproval: (runId, stepId) => store.getRun(runId)?.run.flow?.state[stepId]?.approval ?? null,
    runPrompt(routineRun) {
      const routine = store.getRun(routineRun.runId)?.routine;
      return routine ? `The Routine "${routine.name}" runs a flow of steps on its own.` : "A Routine flow's Run.";
    },
    autopilotPlan(runId, stepId, plan) {
      let planned = false;
      store.updateFlowRun(runId, (flow) => {
        const state = flow?.state[stepId];
        if (!state?.approval || state.approval.decision) return false;
        flow.state[stepId] = { ...state, approval: { ...state.approval, autopilot: { at: plan.at, summary: String(plan.summary ?? "").slice(0, 200) } } };
        planned = true;
      });
      if (planned) changed();
      return planned;
    },
    /** Not an IPC command, so no client can sign an answer as autopilot. */
    async autopilotApprove(runId, summary) {
      const run = await scheduler.flowAct(runId, "approve", { by: "autopilot", summary: String(summary ?? "").slice(0, 200) });
      changed();
      return run;
    },
  };
}

/** An approved approval and the words its step shows, for an answer from the owner or from autopilot. */
function approvedBy(approval, at, { by, summary } = {}) {
  if (by !== "autopilot") return { approval: { ...approval, decision: "approved", decidedAt: at }, said: "Approved by you" };
  return { approval: { ...approval, decision: "approved", decidedAt: at, by: "autopilot" }, said: `Approved by autopilot${summary ? `: ${summary}` : ""}` };
}

module.exports = { flowAutopilot, approvedBy };
