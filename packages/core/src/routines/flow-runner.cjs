const { isTurnEnd } = require("@milagre/shared/agent-runs");
const {
  checkOutput,
  fillTemplate,
  flattenSteps,
  outputInstructions,
  outputSummary,
  stepTitle,
  testCondition,
  triggerValues,
} = require("@milagre/shared/routine-flows");

// How often a Linear state or review wait looks again.
const WAIT_CHECK_MS = 60_000;
const DONE = new Set(["done", "skipped"]);
const errorText = (error) => error?.message ?? String(error);

/**
 * Runs Routine flows step by step (see RoutineFlow in model.ts). A flow Run keeps every step's progress on its RoutineRun
 * (store.cjs updateFlowRun), so the daemon can stop at any point and pick up where it was: a done step never runs again, an
 * action with an intent and no receipt is checked (a pull request looked for on its branch) rather than repeated.
 *
 * `chats` is the scheduler's Chat adapter plus `startStepChat({ routine, run, worktreeId, title })` (a Chat of its own in
 * the Run's Worktree) and `stop(chatId)`. `actions` does what steps change outside Milagre: `findPullRequest({ chatId })`,
 * `pullRequestPreview({ chatId, base, title, body, draft })`, `openPullRequest({ chatId, base, title, body, draft })`,
 * `commentOnLinear({ issue, body })`, `issueState(issue)` and `reviewDecision({ chatId, number })`; `notify(routine, run,
 * text)` tells the owner a Run waits for them.
 */
function createFlowRunner({ store, chats, actions = {}, now = Date.now, onChange = () => {} }) {
  // chatId -> the agent step turn the Chat runs for a flow: { runId, stepId, sent, turnStarted, turnId }.
  const turns = new Map();
  // Runs being advanced, and those asked to advance again once that ends.
  const advancing = new Set();
  const again = new Set();
  // Work going on off the caller (an action, a Chat being made), so idle() can wait for it.
  const background = new Set();
  const track = (work) => {
    background.add(work);
    void work.finally(() => background.delete(work));
    return work;
  };

  const update = (runId, change) => store.updateFlowRun(runId, change);

  // What `{{ref}}` reads in a Run: the trigger, each agent step's output, each pull request's link.
  function values(run) {
    const out = { trigger: triggerValues(run.event, run.startedAt) };
    for (const [id, state] of Object.entries(run.flow?.state ?? {})) {
      if (state.output) out[id] = state.output;
      if (state.receipt?.kind === "pull-request") out[id] = { ...out[id], url: state.receipt.url, number: state.receipt.number };
    }
    return out;
  }

  // The next step to act on: the first one not done or skipped, going into the path each If took.
  function nextStep(flow) {
    const walk = (steps) => {
      for (const step of steps) {
        const state = flow.state[step.id];
        if (!state || !DONE.has(state.status)) return step;
        if (step.kind === "if") {
          const inner = walk(step[state.taken] ?? []);
          if (inner) return inner;
        }
      }
      return null;
    };
    return walk(flow.steps);
  }

  // Every step that hasn't run is marked not-run (the path an If didn't take stays as it was: no state).
  function markRest(flow) {
    const taken = (step) => flow.state[step.id]?.taken;
    const walk = (steps) => {
      for (const step of steps) {
        const state = flow.state[step.id];
        if (!state) flow.state[step.id] = { status: "not-run" };
        else if (state.status === "pending" || state.status === "running" || state.status === "waiting") flow.state[step.id] = { ...state, status: "not-run" };
        if (step.kind === "if" && taken(step)) walk(step[taken(step)]);
      }
    };
    walk(flow.steps);
  }

  function issueOf(run) {
    return run.event?.kind === "linear" ? run.event.issue : null;
  }

  function runTitle(run) {
    const issue = issueOf(run);
    return issue ? `${issue.key} ${issue.title}`.trim() : undefined;
  }

  /** Ends a flow Run: `status` "done" (acted), "failed" or "ended", with what the Runs list says. */
  function end(runId, status, error) {
    for (const [chatId, turn] of turns) if (turn.runId === runId) turns.delete(chatId);
    const saved = update(runId, (flow) => {
      if (!flow) return false;
      flow.status = status;
      if (status !== "done") markRest(flow);
    });
    if (!saved) return;
    const finished = store.finishRun(runId, { status: status === "done" ? "acted" : status, ...(error ? { error } : {}) });
    const title = runTitle(saved);
    if (finished && title) {
      try {
        store.setRunTitle(runId, title);
      } catch {}
    }
    onChange();
  }

  function setStep(runId, stepId, patch, flowPatch) {
    return update(runId, (flow) => {
      if (!flow) return false;
      flow.state[stepId] = { ...flow.state[stepId], ...patch };
      if (flowPatch) Object.assign(flow, flowPatch);
    });
  }

  /** Starts a flow Run the scheduler claimed: copies the steps it runs on, then goes. */
  async function start(routine, run) {
    if (!routine.flow) return;
    if (!run.flow) {
      const saved = update(run.id, (flow, draft) => {
        if (flow) return false;
        draft.flow = { revision: routine.flow.revision, steps: structuredClone(routine.flow.steps), state: {}, status: "running" };
      });
      if (!saved) return;
    }
    onChange();
    await advance(run.id);
  }

  /** Goes as far as the Run can without waiting: through Ifs and done steps, up to a turn, an approval or a wait. */
  async function advance(runId) {
    if (advancing.has(runId)) {
      again.add(runId);
      return;
    }
    advancing.add(runId);
    try {
      do {
        again.delete(runId);
        await step(runId);
      } while (again.has(runId));
    } catch (error) {
      console.warn("[routines] flow step failed", error);
      end(runId, "failed", errorText(error));
    } finally {
      advancing.delete(runId);
    }
  }

  async function step(runId) {
    for (let guard = 0; guard < 200; guard += 1) {
      const found = store.getRun(runId);
      if (!found || found.run.status !== "running" || !found.run.flow) return;
      const { routine, run } = found;
      const flow = run.flow;
      if (flow.status === "paused") return;
      const next = nextStep(flow);
      if (!next) {
        end(runId, "done");
        return;
      }
      const state = flow.state[next.id] ?? { status: "pending" };
      if (state.status === "failed") return;
      if (state.status === "running" || state.status === "waiting") {
        // An action left mid-way by a restart is checked; anything else waits for its turn end, answer or deadline.
        if (state.intentAt && !state.receipt && !actionBusy.has(runId)) await runAction(routine, run, next, state);
        return;
      }
      if (flow.pauseRequested) {
        update(runId, (current) => {
          if (!current) return false;
          current.status = "paused";
        });
        onChange();
        return;
      }
      const at = now();
      switch (next.kind) {
        case "if": {
          const taken = testCondition(next, values(run)) ? "yes" : "otherwise";
          setStep(runId, next.id, { status: "done", startedAt: at, endedAt: at, taken, summary: taken === "yes" ? "Took Yes" : "Took Otherwise" });
          continue;
        }
        case "agent":
          await startAgent(routine, run, next, state);
          return;
        case "ask":
          if (flow.dryRun) {
            setStep(runId, next.id, { status: "done", startedAt: at, endedAt: at, summary: "Passed by itself in a test run" });
            continue;
          }
          ask(routine, run, next, fillTemplate(next.message, values(run)));
          return;
        case "wait":
          wait(run, next);
          return;
        case "pull-request":
          if (flow.dryRun) {
            setStep(runId, next.id, { status: "skipped", startedAt: at, endedAt: at, summary: "Skipped in a test run" });
            continue;
          }
          if (next.askFirst && state.approval?.decision !== "approved") {
            await askPullRequest(routine, run, next);
            return;
          }
          await runAction(routine, run, next, state);
          continue;
        case "linear-comment":
          if (flow.dryRun) {
            setStep(runId, next.id, { status: "skipped", startedAt: at, endedAt: at, summary: "Skipped in a test run" });
            continue;
          }
          await runAction(routine, run, next, state);
          continue;
        default:
          throw new Error(`Unknown step type ${next.kind}`);
      }
    }
  }

  // ---- agent steps ----------------------------------------------------------------------------------------------------

  function settingsFor(routine, step) {
    return {
      provider: step.provider ?? routine.provider,
      model: step.model ?? routine.model,
      permissionMode: step.permissionMode ?? routine.permissionMode,
      ...(step.effort ? { effort: step.effort } : {}),
    };
  }

  function promptFor(run, step, state, followUp) {
    if (followUp) {
      return `You ended without handing back the step's fields. ${outputInstructions(step.output)}`;
    }
    const body = fillTemplate(step.prompt, values(run));
    const note = state.note ? `\n\nNote from the owner for this try: ${state.note}` : "";
    return { body: body + note, prompt: `${body}${note}\n\n${outputInstructions(step.output)}` };
  }

  // The Chat an agent step runs in: the Run's (made by the first step that needs it, with the Run's Worktree), or one of its
  // own in that Worktree.
  async function chatFor(routine, run, step) {
    if (step.chat === "own" && run.worktreeId && chats.startStepChat) {
      const made = await chats.startStepChat({ routine, run, worktreeId: run.worktreeId, title: `${routine.name} · ${step.name}` });
      return { chatId: made.chatId, context: null };
    }
    if (run.chatId && step.chat !== "own") return { chatId: run.chatId, context: null };
    const made = await chats.startChat({ routine, run });
    if (!store.attachChat(run.id, { chatId: made.chatId, worktreeId: made.worktreeId })) throw new Error("The Run is gone");
    return { chatId: made.chatId, context: made.context ?? null };
  }

  async function startAgent(routine, run, step, state, followUp = false) {
    const at = now();
    let chatId = followUp ? state.chatId : undefined;
    let firstContext = null;
    if (!chatId) {
      const made = await chatFor(routine, run, step);
      chatId = made.chatId;
      firstContext = made.context;
    }
    const fresh = store.getRun(run.id)?.run ?? run;
    const words = promptFor(fresh, step, state, followUp);
    const body = followUp ? words : words.body;
    const prompt = followUp ? words : words.prompt;
    setStep(run.id, step.id, {
      status: "running",
      startedAt: state.startedAt && followUp ? state.startedAt : at,
      chatId,
      ...(followUp ? { askedForOutput: true } : { askedForOutput: false }),
    });
    onChange();
    const turn = { runId: run.id, stepId: step.id, sent: false, turnStarted: false };
    turns.set(chatId, turn);
    const context = firstContext ?? {
      kind: "routine-run",
      routineId: routine.id,
      runId: run.id,
      name: routine.name,
      at,
      label: followUp ? `${step.name} · fields` : step.name,
    };
    let started;
    try {
      ({ started } = await chats.send(chatId, { body, prompt, context, settings: settingsFor(routine, step) }));
      turn.sent = true;
    } catch (error) {
      if (turns.get(chatId) === turn) turns.delete(chatId);
      await turnFailed(run.id, step, chatId, error?.busy ? "the Chat was busy" : errorText(error));
      return;
    }
    Promise.resolve(started).then(
      (result) => {
        if (result?.turnId) turn.turnId ??= result.turnId;
        if (result?.steered || !result?.turnId) {
          if (turns.get(chatId) !== turn) return null;
          turns.delete(chatId);
          return turnFailed(run.id, step, chatId, result?.steered ? "the Chat was busy" : "turn did not start");
        }
        return null;
      },
      (error) => {
        if (turns.get(chatId) !== turn) return null;
        turns.delete(chatId);
        return turnFailed(run.id, step, chatId, errorText(error));
      },
    );
  }

  /** A turn of an agent step ended without what the step needs: retried while it has tries left, else the Run stops. */
  async function turnFailed(runId, step, chatId, error) {
    const found = store.getRun(runId);
    if (!found || found.run.status !== "running") return;
    const state = found.run.flow?.state[step.id] ?? {};
    const tries = [...(state.tries ?? []), { startedAt: state.startedAt ?? now(), endedAt: now(), error, chatId }];
    if (tries.length <= (step.retries ?? 0)) {
      setStep(runId, step.id, { status: "pending", tries, error });
      onChange();
      await advance(runId);
      return;
    }
    setStep(runId, step.id, { status: "failed", tries, error, endedAt: now() });
    end(runId, "failed", `${step.name}: ${error}`);
  }

  /** Called by the flow_step_output tool from `chatId`: checks the fields against the step and keeps them. */
  function recordOutput(chatId, value) {
    for (const { run } of store.runningFlows()) {
      for (const { step } of flattenSteps(run.flow.steps)) {
        const state = run.flow.state[step.id];
        if (step.kind !== "agent" || state?.status !== "running" || state.chatId !== chatId) continue;
        const checked = checkOutput(step.output, value ?? {});
        if (!checked.ok) return { ok: false, error: `Not saved: ${checked.error}. Call flow_step_output again with every field.` };
        setStep(run.id, step.id, { output: checked.output, summary: outputSummary(checked.output) || undefined });
        onChange();
        return { ok: true, text: `Saved the fields for "${step.name}". End your turn now; the flow goes on by itself.` };
      }
    }
    return { ok: false, error: "This Chat isn't running a flow step that hands back fields." };
  }

  /** Whether `chatId` runs a flow step (the tool is only offered there). */
  function runsStep(chatId) {
    return store.runningFlows().some(({ run }) => Object.values(run.flow.state).some((state) => state.status === "running" && state.chatId === chatId));
  }

  // A turn of an agent step ended well: done when it handed back its fields (or has none), else asked once, else failed.
  async function turnCompleted(runId, stepId, chatId) {
    const found = store.getRun(runId);
    if (!found || found.run.status !== "running") return;
    const { routine, run } = found;
    const step = flattenSteps(run.flow.steps).find((entry) => entry.step.id === stepId)?.step;
    const state = run.flow.state[stepId];
    if (!step || state?.status !== "running") return;
    if (state.output || step.output.length === 0) {
      setStep(runId, stepId, { status: "done", endedAt: now(), output: state.output ?? {}, error: undefined });
      onChange();
      await advance(runId);
      return;
    }
    if (step.onInvalid === "ask-once" && !state.askedForOutput) {
      await startAgent(routine, run, step, state, true);
      return;
    }
    await turnFailed(runId, step, chatId, "the turn ended without the step's fields");
  }

  /** The scheduler passes every Chat event here first; true when it was a flow step's turn. */
  function observe(chatId, event) {
    const turn = turns.get(chatId);
    if (!turn) return false;
    if (event.type === "message-sent") {
      turn.sent = true;
      return true;
    }
    if (event.type === "turn-started") {
      if (!turn.sent || (turn.turnId && event.turnId && event.turnId !== turn.turnId)) return true;
      turn.turnStarted = true;
      turn.turnId ??= event.turnId;
      return true;
    }
    if (!isTurnEnd(event)) return true;
    if (!turn.turnStarted && !(turn.sent && event.type !== "turn-completed")) return true;
    turns.delete(chatId);
    const found = store.getRun(turn.runId);
    const step = found && flattenSteps(found.run.flow?.steps ?? []).find((entry) => entry.step.id === turn.stepId)?.step;
    if (!step) return true;
    if (event.type === "turn-completed") track(turnCompleted(turn.runId, turn.stepId, chatId));
    else track(turnFailed(turn.runId, step, chatId, event.type === "turn-failed" ? (event.message ?? "turn failed") : "cancelled"));
    return true;
  }

  // ---- approvals and waits ------------------------------------------------------------------------------------------

  function ask(routine, run, step, message) {
    const at = now();
    setStep(
      run.id,
      step.id,
      { status: "waiting", startedAt: at, approval: { askedAt: at, expiresAt: at + step.expiresInHours * 3600_000, message } },
      { status: "waiting" },
    );
    onChange();
    actions.notify?.(routine, run, `${routine.name} waits for you: ${step.name}`);
  }

  async function askPullRequest(routine, run, step) {
    const at = now();
    const vals = values(run);
    const title = fillTemplate(step.title, vals).trim() || stepTitle(step);
    const body = fillTemplate(step.body, vals);
    let preview = { branch: "", base: step.base ?? "", title, body, draft: step.draft };
    try {
      if (run.chatId && actions.pullRequestPreview)
        preview = { ...preview, ...(await actions.pullRequestPreview({ chatId: run.chatId, base: step.base, title, body, draft: step.draft })) };
    } catch (error) {
      console.warn("[routines] pull request preview failed", error);
    }
    setStep(
      run.id,
      step.id,
      { status: "waiting", startedAt: at, approval: { askedAt: at, expiresAt: at + 24 * 3600_000, message: `Open "${title}"?`, preview } },
      { status: "waiting" },
    );
    onChange();
    actions.notify?.(routine, run, `${routine.name} waits for you: ${step.name}`);
  }

  function wait(run, step) {
    const at = now();
    const until = step.until.kind === "time" ? at + step.until.minutes * 60_000 : at + step.timeoutHours * 3600_000;
    setStep(run.id, step.id, { status: "waiting", startedAt: at, waitUntil: until }, { status: "waiting" });
    onChange();
  }

  // ---- actions ------------------------------------------------------------------------------------------------------

  const actionBusy = new Set();

  /**
   * Runs a pull request or Linear comment step once. The intent is saved first; a receipt after. A Run that finds an intent
   * without a receipt (it stopped in between) looks for the pull request on its branch instead of opening another; a comment
   * that may have posted stops the Run for the owner to check.
   */
  async function runAction(routine, run, step, state) {
    if (actionBusy.has(run.id)) return;
    actionBusy.add(run.id);
    try {
      const at = now();
      const resumed = Boolean(state.intentAt) && !state.receipt;
      setStep(run.id, step.id, { status: "running", startedAt: state.startedAt ?? at, intentAt: state.intentAt ?? at });
      onChange();
      const vals = values(run);
      if (step.kind === "pull-request") {
        if (!run.chatId) throw new Error("No Worktree to open a pull request from: an agent step must come first");
        const title = state.approval?.preview?.title ?? (fillTemplate(step.title, vals).trim() || stepTitle(step));
        const body = state.approval?.preview?.body ?? fillTemplate(step.body, vals);
        const found = await actions.findPullRequest({ chatId: run.chatId });
        let receipt;
        if (found)
          receipt = { kind: "pull-request", url: found.url, number: found.number, branch: found.branch, draft: Boolean(found.draft), matched: true, at: now() };
        else {
          const opened = await actions.openPullRequest({ chatId: run.chatId, base: step.base, title, body, draft: step.draft });
          if (!opened?.ok) throw new Error(opened?.message ?? "gh couldn't open the pull request");
          receipt = { kind: "pull-request", url: opened.url, number: opened.number, branch: opened.branch ?? "", draft: step.draft, matched: false, at: now() };
        }
        const summary = receipt.matched
          ? `Found #${receipt.number} on this branch, receipt kept`
          : `Opened ${receipt.draft ? "draft " : ""}#${receipt.number}, receipt kept`;
        setStep(run.id, step.id, { status: "done", endedAt: now(), receipt, summary, error: undefined });
      } else {
        const issue = issueOf(run);
        if (!issue) throw new Error("This Run has no Linear issue to comment on");
        if (resumed) throw new Error(`The comment may have posted before Milagre stopped; check ${issue.key}, then retry or end`);
        const posted = await actions.commentOnLinear({ issue: { key: issue.key, workspace: issue.workspace }, body: fillTemplate(step.body, vals) });
        const receipt = { kind: "linear-comment", issue: issue.key, ...(posted?.url ? { url: posted.url } : {}), at: now() };
        setStep(run.id, step.id, { status: "done", endedAt: now(), receipt, summary: `Commented on ${issue.key}`, error: undefined });
      }
      onChange();
    } catch (error) {
      setStep(run.id, step.id, {
        status: "failed",
        endedAt: now(),
        error: errorText(error),
        tries: [...(state.tries ?? []), { startedAt: state.startedAt ?? now(), endedAt: now(), error: errorText(error) }],
      });
      end(run.id, "failed", `${step.name}: ${errorText(error)}`);
    } finally {
      actionBusy.delete(run.id);
    }
  }

  // ---- the owner's hand -----------------------------------------------------------------------------------------------

  function waitingStep(run) {
    return flattenSteps(run.flow?.steps ?? []).find((entry) => run.flow.state[entry.step.id]?.status === "waiting")?.step ?? null;
  }

  function runningAgent(run) {
    return flattenSteps(run.flow?.steps ?? []).find((entry) => entry.step.kind === "agent" && run.flow.state[entry.step.id]?.status === "running");
  }

  /**
   * What the owner does to a flow Run: `approve` or `reject` (with `reason`) the step waiting for them, `pause`, `resume`,
   * `end`, or `retry` the step it stopped at (with `note` for the agent). Returns the Run as it is after.
   */
  async function act(runId, action, { reason, note } = {}) {
    let found = store.getRun(runId);
    if (!found?.run.flow) throw new Error("No such flow Run");
    if (action === "retry") {
      if (found.run.status === "failed") store.reopenFlowRun(runId);
      found = store.getRun(runId);
      if (found?.run.status !== "running") throw new Error("Only a stopped Run can be retried");
      const failed = flattenSteps(found.run.flow.steps).find((entry) => found.run.flow.state[entry.step.id]?.status === "failed")?.step;
      if (!failed) throw new Error("Nothing failed to retry");
      update(runId, (flow) => {
        if (!flow) return false;
        flow.status = "running";
        // The steps the stop marked as not run go back to waiting their turn.
        for (const [id, state] of Object.entries(flow.state)) if (state.status === "not-run") delete flow.state[id];
        const old = flow.state[failed.id];
        flow.state[failed.id] = {
          status: "pending",
          tries: [],
          ...(note ? { note: String(note).slice(0, 2000) } : {}),
          ...(old?.receipt ? { receipt: old.receipt } : {}),
        };
        if (old?.approval?.decision === "approved") flow.state[failed.id].approval = old.approval;
      });
      onChange();
      await advance(runId);
      return store.getRun(runId)?.run ?? null;
    }
    if (found.run.status !== "running") throw new Error("This Run has ended");
    const run = found.run;
    if (action === "approve" || action === "reject") {
      const step = waitingStep(run);
      const approval = step && run.flow.state[step.id].approval;
      if (!approval || approval.decision) throw new Error("Nothing waits for an answer");
      const at = now();
      if (action === "reject") {
        const cleanReason = typeof reason === "string" ? reason.trim().slice(0, 2000) : "";
        setStep(runId, step.id, {
          status: "done",
          endedAt: at,
          approval: { ...approval, decision: "rejected", decidedAt: at, ...(cleanReason ? { reason: cleanReason } : {}) },
          summary: "Rejected by you",
        });
        const issue = issueOf(run);
        if (cleanReason && issue && actions.commentOnLinear) {
          track(
            Promise.resolve(actions.commentOnLinear({ issue: { key: issue.key, workspace: issue.workspace }, body: `Not going ahead: ${cleanReason}` })).catch(
              (error) => console.warn("[routines] couldn't post the reason", error),
            ),
          );
        }
        end(runId, "ended", "approval rejected");
        return store.getRun(runId)?.run ?? null;
      }
      const decided = { ...approval, decision: "approved", decidedAt: at };
      if (step.kind === "ask") setStep(runId, step.id, { status: "done", endedAt: at, approval: decided, summary: "Approved by you" }, { status: "running" });
      else setStep(runId, step.id, { status: "pending", approval: decided }, { status: "running" });
      onChange();
      await advance(runId);
      return store.getRun(runId)?.run ?? null;
    }
    if (action === "pause") {
      update(runId, (flow) => {
        if (!flow) return false;
        flow.pauseRequested = true;
        // Nothing is under way: it pauses now. A turn under way finishes first (step() pauses before the next one).
        if (!runningAgent({ flow }) && flow.status !== "waiting") flow.status = "paused";
      });
      onChange();
      return store.getRun(runId)?.run ?? null;
    }
    if (action === "resume") {
      update(runId, (flow) => {
        if (!flow) return false;
        delete flow.pauseRequested;
        if (flow.status === "paused") flow.status = waitingStep({ flow }) ? "waiting" : "running";
      });
      onChange();
      await advance(runId);
      return store.getRun(runId)?.run ?? null;
    }
    if (action === "end") {
      const agent = runningAgent(run);
      if (agent?.step && run.flow.state[agent.step.id].chatId) {
        try {
          await chats.stop?.(run.flow.state[agent.step.id].chatId);
        } catch (error) {
          console.warn("[routines] couldn't stop the step's turn", error);
        }
      }
      end(runId, "ended", "ended by you");
      return store.getRun(runId)?.run ?? null;
    }
    throw new Error(`Unknown action ${action}`);
  }

  /** A Test run of the flow's draft, on the last real Run's event. */
  async function test(routineId) {
    const routine = store.get(routineId);
    if (!routine?.flow) throw new Error("This Routine isn't a flow");
    const last = store.runs(routineId).find((run) => run.event && !run.flow?.dryRun && !run.rejected);
    if (routine.trigger.kind === "linear" && !last?.event) throw new Error("A test run uses the last Linear issue this flow ran on, and it hasn't run yet");
    const started = store.startTestRun(routineId, now(), last?.event);
    if (!started) throw new Error("This Routine can't run");
    onChange();
    track(advance(started.run.id));
    return started.run;
  }

  // ---- the clock and restarts -------------------------------------------------------------------------------------------

  /** Deadlines and waits, once a second from the scheduler's tick. */
  async function tick() {
    const at = now();
    for (const { run } of store.runningFlows()) {
      const flow = run.flow;
      if (flow.status === "paused") continue;
      const step = waitingStep(run);
      if (!step) {
        // A Run that went on running with nothing under way (resumed, approved while busy) is moved on.
        if (!advancing.has(run.id) && !runningAgent(run) && !nextIsActive(run)) track(advance(run.id));
        continue;
      }
      const state = flow.state[step.id];
      if (state.approval && !state.approval.decision) {
        if (at >= state.approval.expiresAt) {
          setStep(run.id, step.id, {
            status: "done",
            endedAt: at,
            approval: { ...state.approval, decision: "expired", decidedAt: at },
            summary: "Nobody answered in time",
          });
          end(run.id, "ended", "approval expired");
        }
        continue;
      }
      if (step.kind !== "wait") continue;
      if (step.until.kind === "time") {
        if (at >= state.waitUntil) {
          setStep(run.id, step.id, { status: "done", endedAt: at, summary: "Waited" }, { status: "running" });
          track(advance(run.id));
        }
        continue;
      }
      if (at >= state.waitUntil) {
        setStep(run.id, step.id, { status: "failed", endedAt: at, error: "waited too long" });
        end(run.id, "failed", `${step.name}: waited too long`);
        continue;
      }
      if (state.checkedAt && at - state.checkedAt < WAIT_CHECK_MS) continue;
      setStep(run.id, step.id, { checkedAt: at });
      track(checkWait(run, step));
    }
  }

  function nextIsActive(run) {
    const next = nextStep(run.flow);
    const status = next ? run.flow.state[next.id]?.status : null;
    return status === "running" || status === "waiting" || status === "failed";
  }

  async function checkWait(run, step) {
    try {
      let done = false;
      let summary = "";
      if (step.until.kind === "linear-state") {
        const issue = issueOf(run);
        const state = issue ? await actions.issueState?.({ key: issue.key, workspace: issue.workspace }) : null;
        done = typeof state === "string" && state.toLowerCase() === step.until.state.toLowerCase();
        summary = `Issue moved to ${state}`;
      } else {
        const pr = Object.values(run.flow.state).find((state) => state.receipt?.kind === "pull-request")?.receipt;
        const decision = pr && run.chatId ? await actions.reviewDecision?.({ chatId: run.chatId, number: pr.number }) : null;
        done = decision === "APPROVED" || decision === "CHANGES_REQUESTED";
        summary = decision === "APPROVED" ? "Review approved" : "Changes requested";
      }
      if (!done) return;
      setStep(run.id, step.id, { status: "done", endedAt: now(), summary }, { status: "running" });
      onChange();
      await advance(run.id);
    } catch (error) {
      console.warn("[routines] couldn't check a wait", error);
    }
  }

  /**
   * Once per daemon start: flow Runs pick up where they were. A step's turn that the restart cut off (its Chat no longer
   * busy) counts as a failed try; one still going (the Chat resumed it) is followed again; an action with an intent and no
   * receipt is checked.
   */
  function resume() {
    for (const { run } of store.runningFlows()) {
      const agent = runningAgent(run);
      if (agent) {
        const state = run.flow.state[agent.step.id];
        if (state.chatId && chats.busy?.(state.chatId)) {
          turns.set(state.chatId, { runId: run.id, stepId: agent.step.id, sent: true, turnStarted: true });
          continue;
        }
        if (state.output) {
          track(turnCompleted(run.id, agent.step.id, state.chatId));
          continue;
        }
        track(turnFailed(run.id, agent.step, state.chatId, "Milagre restarted during the turn"));
        continue;
      }
      track(advance(run.id));
    }
  }

  return {
    start,
    advance,
    observe,
    recordOutput,
    runsStep,
    act,
    test,
    tick,
    resume,
    idle: async () => {
      while (background.size) await Promise.allSettled(background);
    },
  };
}

module.exports = { createFlowRunner };
