// Folds agent events into chats' saved state and the turns streaming in them. Shared by the main
// process, which saves every chat's turns (see agents/chat-host.cjs), and the renderer, which shows
// them as they stream. Types: agent-runs.d.mts.

import { hasTranscriptTail } from "./subagent-transcript.mjs";
import { qualifyKey } from "./chat-scopes.mjs";
import { nativePlan } from "./chat-plan.mjs";

export { LOCAL_COMPUTER, computerOfKey, qualifyKey, unqualifyKey } from "./chat-scopes.mjs";

export const MAX_OUTPUT = 20_000;

/** Command output keeps its end, where results and errors are. */
export function capOutput(text) {
  return text.length > MAX_OUTPUT ? `… truncated\n${text.slice(-MAX_OUTPUT)}` : text;
}

/**
 * Names a chat for the agent host. Session ids are counters per project, so every project has
 * a chat 2; the key carries the project path so chats in different projects never share a session.
 * `computerId`: a paired computer's chat carries its id (`${computerId}|${path}#${id}`); this Mac's doesn't.
 */
export function chatKey(projectPath, sessionId, computerId) {
  return `${qualifyKey(computerId, projectPath)}#${sessionId}`;
}

/** The session id at the end of a chat key (after the last `#`), or NaN. */
export function sessionIdFromKey(key) {
  const match = /#(\d+)$/.exec(key);
  return match ? Number(match[1]) : Number.NaN;
}

/** The project path at the start of a chat key (before the last `#`). */
export function projectOfKey(key) {
  const index = key.lastIndexOf("#");
  return index === -1 ? key : key.slice(0, index);
}

/** Whether a chat key names a chat of the project at `projectPath`, and not of a path that merely starts with it. */
export function chatInProject(projectPath, key) {
  return key === chatKey(projectPath, sessionIdFromKey(key));
}

/** The model of the chat's last message, which a turn the agent started by itself runs on. */
export function lastUserModel(state, sessionId) {
  const last = state.messages.findLast((message) => message.session_id === sessionId && message.role === "user");
  if (last) return last.model ?? "";
  // A window that holds no messages (chat-pages-v1) has it in the Chat's summary.
  return state.sessions?.[sessionId]?.summary?.lastModel ?? "";
}

export function startRun(runs, chatId, model, permissionMode) {
  const run = { text: "", model, startedAt: Date.now(), steps: [], approvals: [], questions: [], answered: {} };
  return { ...runs, [chatId]: permissionMode ? { ...run, permissionMode } : run };
}

/** The run with one step changed, or null when it has no such step or `update` declines. */
function updateStep(run, id, update) {
  const index = run.steps.findIndex((step) => step.id === id);
  const next = index === -1 ? null : update(run.steps[index]);
  return next ? { ...run, steps: run.steps.map((step, position) => (position === index ? next : step)) } : null;
}

/** The detail a step ends with replaces what streamed into it; a step that ends without one keeps none. */
function endStep({ detail: _streamed, ...step }, end) {
  return {
    ...step,
    status: end.status,
    title: end.title ?? step.title,
    ...(end.note === undefined ? {} : { note: end.note }),
    ...(end.detail === undefined ? {} : { detail: end.detail }),
    ...(end.durationMs === undefined ? {} : { durationMs: end.durationMs }),
    ...(end.endedAt === undefined ? {} : { endedAt: end.endedAt }),
    ...(end.summary === undefined ? {} : { summary: end.summary }),
    ...(end.error === undefined ? {} : { error: end.error }),
    ...(end.file === undefined ? {} : { file: end.file }),
    ...(end.artifact === undefined ? {} : { artifact: end.artifact }),
    ...(end.routine === undefined ? {} : { routine: end.routine }),
  };
}

/**
 * Steps as saved with a reply: none left running, and offsets into the reply's trimmed text.
 * A step still running when the turn ends is saved as `closeAs`, except thinking, which just stops.
 */
function savedSteps(text, steps, closeAs) {
  if (!steps.length) return {};
  const lead = text.length - text.trimStart().length;
  const length = text.trim().length;
  return {
    steps: steps.map((step) => ({
      ...step,
      status: step.status !== "running" ? step.status : step.kind === "thinking" ? "done" : closeAs,
      offset: Math.min(Math.max((step.offset ?? text.length) - lead, 0), length),
    })),
  };
}

/** How a chat's turn stands: waiting on the user (an approval or a question), working, or idle (no run). */
export function runStatus(run) {
  if (!run) return "idle";
  return run.approvals.length || run.questions.length ? "waiting" : "working";
}

const TURN_ENDS = new Set(["turn-completed", "turn-cancelled", "turn-failed"]);

/** Whether the event ends a turn. */
export function isTurnEnd(event) {
  return TURN_ENDS.has(event.type);
}

/** Whether a subagent is still at work: not ended yet, or waiting on an approval (see Subagent.status). */
export function subagentActive(agent) {
  return ["initializing", "running", "waiting"].includes(agent?.status);
}

/**
 * The run left once a steering message splits it: the streamed text and finished steps are saved
 * above the new message, and steps still running carry on at the start of the rest of the reply.
 * Null when there is nothing to save yet.
 */
function splitRun(run) {
  const finished = run.steps.filter((step) => step.status !== "running");
  if (!run.text.trim() && !finished.length) return null;
  const running = run.steps.filter((step) => step.status === "running").map((step) => ({ ...step, offset: 0 }));
  return { ...run, text: "", steps: running, split: true };
}

/**
 * Folds one agent event into the turns streaming per chat (keyed by chat key), whatever project
 * they belong to. `model` names the model of a turn that starts without a message from this
 * window (see `turn-started`). Unchanged runs are returned as they are.
 */
export function applyRunEvent(runs, chatId, event, model = "") {
  const run = runs[chatId];
  switch (event.type) {
    // A message sent while a turn runs steers it; otherwise it starts one.
    case "message-sent": {
      if (!run) return startRun(runs, chatId, event.model, event.permissionMode);
      const split = splitRun(run);
      return split ? { ...runs, [chatId]: split } : runs;
    }
    // A turn this window didn't start, such as a steering message that arrived as the last turn ended.
    case "turn-started": {
      const next = run ? runs : startRun(runs, chatId, model);
      return event.turnId === undefined || next[chatId].turnId === event.turnId ? next : { ...next, [chatId]: { ...next[chatId], turnId: event.turnId } };
    }
    case "permission-request": {
      if (!run) return runs;
      const { type: _type, ...request } = event;
      return { ...runs, [chatId]: { ...run, approvals: [...run.approvals.filter((item) => item.requestId !== request.requestId), request] } };
    }
    case "permission-resolved": {
      if (!run) return runs;
      const approvals = run.approvals.filter((item) => item.requestId !== event.requestId);
      const { [event.requestId]: _answered, ...answered } = run.answered;
      if (approvals.length === run.approvals.length && !(event.requestId in run.answered)) return runs;
      return { ...runs, [chatId]: { ...run, approvals, answered } };
    }
    case "question-request": {
      if (!run) return runs;
      const { type: _type, ...request } = event;
      return { ...runs, [chatId]: { ...run, questions: [...run.questions.filter((item) => item.requestId !== request.requestId), request] } };
    }
    case "question-resolved": {
      if (!run) return runs;
      const questions = run.questions.filter((item) => item.requestId !== event.requestId);
      const { [event.requestId]: _answered, ...answered } = run.answered;
      if (questions.length === run.questions.length && !(event.requestId in run.answered)) return runs;
      return { ...runs, [chatId]: { ...run, questions, answered } };
    }
    case "subagents-waiting":
      return run ? { ...runs, [chatId]: { ...run, waitingForSubagents: event.waiting } } : runs;
    case "context-usage":
      return run ? { ...runs, [chatId]: { ...run, contextUsage: { used: event.used, size: event.size } } } : runs;
    // The user's answers to a question were saved as their message, after the reply so far (see recordAnswers).
    case "answers-sent":
      return run ? { ...runs, [chatId]: splitRun(run) ?? { ...run, split: true } } : runs;
    // Text from the parent agent means it's no longer waiting on its subagents.
    case "text-delta":
      return run ? { ...runs, [chatId]: { ...run, text: run.text + event.text, ...(run.waitingForSubagents ? { waitingForSubagents: false } : {}) } } : runs;
    case "step-started": {
      if (!run) return runs;
      const viewed = event.step.kind === "image" && event.step.imageOrigin === "viewed";
      const existing = run.steps.findIndex((step) => step.id === event.step.id);
      const admitted = existing !== -1 && run.steps[existing].kind === "image" && run.steps[existing].imageOrigin === "viewed";
      // Count the reply after steering splits, not the provider turn. Replays keep their slot.
      if (viewed && !admitted && run.steps.filter((step) => step.kind === "image" && step.imageOrigin === "viewed").length >= 16) return runs;
      const step = {
        ...event.step,
        ...(event.step.detail === undefined ? {} : { detail: capOutput(event.step.detail) }),
        status: "running",
        offset: run.text.length,
      };
      const steps =
        viewed && existing !== -1
          ? run.steps.map((item, index) => (index === existing ? step : item))
          : [...run.steps.filter((item) => item.id !== step.id), step];
      return { ...runs, [chatId]: { ...run, steps } };
    }
    case "step-output": {
      const next =
        run && updateStep(run, event.id, (step) => (step.status === "running" ? { ...step, detail: capOutput((step.detail ?? "") + event.text) } : null));
      return next ? { ...runs, [chatId]: next } : runs;
    }
    case "step-completed": {
      const next = run && updateStep(run, event.id, (step) => endStep(step, event));
      return next ? { ...runs, [chatId]: next } : runs;
    }
    case "turn-completed":
    case "turn-cancelled":
    case "turn-failed": {
      if (!run) return runs;
      const { [chatId]: _finished, ...remaining } = runs;
      return remaining;
    }
    // Event types added by later steps change nothing.
    default:
      return runs;
  }
}

/**
 * Folds one agent event into the saved state (the project at `projectPath`) and the in-memory
 * runs. `changed` is true when `state` changed and must be saved; streamed text only lives in
 * `runs` until the turn ends. Events for another project's chats, or for a session this state
 * doesn't have, change nothing.
 */
export function applyAgentEvent(state, runs, projectPath, chatId, event) {
  const sessionId = sessionIdFromKey(chatId);
  let session = state.sessions[sessionId];
  if (!chatInProject(projectPath, chatId) || !session) return { state, runs, changed: false };
  const run = runs[chatId];
  // Input, reset and a new turn invalidate even a suggestion still in flight from the old turn.
  const clearSuggestion = ["message-sent", "turn-started", "session-reset"].includes(event.type);
  const suggestionChanged = clearSuggestion && (session.suggestion !== undefined || session.suggestionTurnId !== undefined);
  if (suggestionChanged) {
    const { suggestion: _suggestion, suggestionTurnId: _turn, ...rest } = session;
    session = rest;
    state = { ...state, sessions: { ...state.sessions, [sessionId]: session } };
  }
  switch (event.type) {
    case "prompt-suggestion": {
      if (run || session.provider !== "claude" || !event.turnId || event.turnId !== session.suggestionTurnId || !event.text.trim())
        return { state, runs, changed: false };
      return {
        state: { ...state, sessions: { ...state.sessions, [sessionId]: { ...session, suggestion: { text: event.text, turnId: event.turnId } } } },
        runs,
        changed: true,
      };
    }
    case "subagent-update": {
      if (event.agent.id === session.native_session_id) return { state, runs, changed: false };
      const children = (session.subagents ?? []).filter((agent) => agent.id !== session.native_session_id);
      const previous = children.find((agent) => agent.id === event.agent.id);
      if (previous && previous.updatedAt > event.agent.updatedAt) return { state, runs, changed: false };
      // A resumed provider can rediscover a child before it has replayed the earlier output.
      // A client that holds transcript tails (subagent-transcript.mjs) gets the host's merged transcript, or its tail,
      // and keeps it as it comes.
      const tail = hasTranscriptTail(event.agent) || hasTranscriptTail(previous);
      const agent = previous
        ? {
            ...previous,
            ...event.agent,
            // One that ended and runs again (a resumed session picks up its background agents, as after an account
            // switch) is back on the track; one archived while it runs stays archived.
            archived: previous.archived && !(!subagentActive(previous) && subagentActive(event.agent)),
            title: event.agent.title === "Subagent" ? previous.title : event.agent.title,
            prompt: event.agent.prompt ?? previous.prompt,
            parentId: event.agent.parentId ?? previous.parentId,
            startedAt: Math.min(previous.startedAt, event.agent.startedAt),
            transcript:
              event.agent.source === "milagre-advisor" || tail
                ? event.agent.transcript
                : [...new Map([...previous.transcript, ...event.agent.transcript].map((entry) => [entry.id, entry])).values()].slice(-100),
            transcriptLength: event.agent.transcriptLength,
            // A child that runs again comes without an end (subagents.cjs); the old one must not stop its clock.
            endedAt: event.agent.endedAt,
            // An archived subagent's summary stays one only while updates come as summaries (subagent-transcript.mjs).
            detailsOnDemand: event.agent.detailsOnDemand,
          }
        : event.agent;
      if (agent.transcriptLength === undefined) delete agent.transcriptLength;
      if (agent.endedAt === undefined) delete agent.endedAt;
      if (agent.detailsOnDemand === undefined) delete agent.detailsOnDemand;
      const subagents = previous ? children.map((child) => (child.id === agent.id ? agent : child)) : [...children, agent];
      return { state: { ...state, sessions: { ...state.sessions, [sessionId]: { ...session, subagents } } }, runs, changed: true };
    }
    // The agent process's background work besides subagents (chat-activity.mjs) outlasts the turn too; each set replaces the last.
    case "background-tasks": {
      const tasks = Array.isArray(event.tasks) ? event.tasks : [];
      if (JSON.stringify(tasks) === JSON.stringify(session.backgroundTasks ?? [])) return { state, runs, changed: false };
      const { backgroundTasks: _previous, ...rest } = session;
      const next = tasks.length ? { ...rest, backgroundTasks: tasks } : rest;
      return { state: { ...state, sessions: { ...state.sessions, [sessionId]: next } }, runs, changed: true };
    }
    // A Chat's plan lives on its session (chat-plan.mjs), so it outlasts the turn. Milagre's task tools replace it whole.
    case "plan-updated": {
      const { plan: _previous, ...rest } = session;
      const next = event.plan ? { ...rest, plan: event.plan } : rest;
      return { state: { ...state, sessions: { ...state.sessions, [sessionId]: next } }, runs, changed: true };
    }
    // A provider's own todo list fills the plan until Milagre's tools own it.
    case "tasks-updated": {
      const plan = nativePlan(session.plan, event.tasks, Date.now());
      if (plan === session.plan) return { state, runs, changed: false };
      const { plan: _previous, ...rest } = session;
      return { state: { ...state, sessions: { ...state.sessions, [sessionId]: plan ? { ...rest, plan } : rest } }, runs, changed: true };
    }
    case "session-started": {
      if (session.native_session_id === event.nativeId) return { state, runs, changed: false };
      return { state: { ...state, sessions: { ...state.sessions, [sessionId]: { ...session, native_session_id: event.nativeId } } }, runs, changed: true };
    }
    case "session-reset": {
      if (!session.native_session_id) return { state, runs, changed: suggestionChanged };
      const { native_session_id: _forgotten, ...rest } = session;
      return { state: { ...state, sessions: { ...state.sessions, [sessionId]: rest } }, runs, changed: true };
    }
    case "message-sent": {
      const next = run ? splitRunForSteer(state, runs, projectPath, chatId) : { state, runs: applyRunEvent(runs, chatId, event), changed: false };
      // A steered run's first text is likely the answer to that message: see step-started.
      if (run) next.runs = { ...next.runs, [chatId]: { ...next.runs[chatId], steered: true } };
      return { ...next, changed: next.changed || suggestionChanged };
    }
    case "turn-started":
      return { state, runs: applyRunEvent(runs, chatId, event, lastUserModel(state, sessionId)), changed: suggestionChanged };
    // A /compact the user asked for shows its progress on its divider: Claude's own compaction step stays out of the reply.
    case "step-started":
      if (event.step.id.startsWith("compact-") && pendingCompaction(state, sessionId)) return { state, runs, changed: false };
      // Text written after a steering message, before the agent goes back to its tools, answers the user: it is saved
      // as its own reply, so it isn't folded into the activity with the text between steps.
      // ponytail: the first text after the steer, even when the agent wrote it before it read the message.
      if (run?.steered && run.text.trim()) {
        const split = splitRunForSteer(state, runs, projectPath, chatId);
        const { steered: _answered, ...rest } = split.runs[chatId];
        return { state: split.state, runs: applyRunEvent({ ...split.runs, [chatId]: rest }, chatId, event), changed: split.changed };
      }
      return { state, runs: applyRunEvent(runs, chatId, event), changed: false };
    case "context-compacting":
      return pendingCompaction(state, sessionId) ? { state, runs, changed: false } : addCompaction(state, runs, projectPath, chatId, "preparing");
    case "context-compacted": {
      // The boundary may be the last usage event of a /compact turn. Keep the gauge accurate even without a later API request.
      const size = run?.contextUsage?.size ?? session.contextUsage?.size;
      if (Number.isFinite(event.after) && event.after >= 0 && size > 0) {
        const contextUsage = { used: event.after, size };
        session = { ...session, contextUsage };
        state = { ...state, sessions: { ...state.sessions, [sessionId]: session } };
        if (run) runs = { ...runs, [chatId]: { ...run, contextUsage } };
      }
      const request = pendingCompaction(state, sessionId);
      if (!request) return addCompaction(state, runs, projectPath, chatId, "done", event);
      const before = request.role === "user" ? (request.context.before ?? event.before) : (event.before ?? request.context.before);
      const context = {
        ...request.context,
        status: "done",
        ...(before === undefined ? {} : { before }),
        ...(event.after === undefined ? {} : { after: event.after }),
      };
      return { state: withContext(state, request, context), runs, changed: true };
    }
    case "turn-completed":
    case "turn-cancelled":
    case "turn-failed": {
      if (!run) return { state, runs, changed: false };
      const remaining = applyRunEvent(runs, chatId, event);
      const { suggestion: _suggestion, suggestionTurnId: _turn, ...rest } = session;
      const suggestionTurnId = event.type === "turn-completed" && session.provider === "claude" ? run.turnId : null;
      const suggestionUpdated = Boolean(suggestionTurnId) || session.suggestion !== undefined || session.suggestionTurnId !== undefined;
      if (suggestionUpdated) {
        session = { ...rest, ...(suggestionTurnId ? { suggestionTurnId } : {}) };
        state = { ...state, sessions: { ...state.sessions, [sessionId]: session } };
      }
      // The context gauge outlives the run, so the composer still shows it between turns.
      if (run.contextUsage) state = { ...state, sessions: { ...state.sessions, [sessionId]: { ...session, contextUsage: run.contextUsage } } };
      // A compaction request whose turn ends before its boundary did not happen.
      const unfinished = pendingCompaction(state, sessionId);
      if (unfinished) state = withContext(state, unfinished, { ...unfinished.context, status: "failed" });
      // The reply so far was saved when a steering message split it; there is nothing left to show.
      if (event.type === "turn-completed" && run.split && !run.text.trim() && !run.steps.length)
        return { state, runs: remaining, changed: Boolean(run.contextUsage) || Boolean(unfinished) || suggestionUpdated };
      // A /compact turn says nothing: its divider is the whole reply.
      if (event.type === "turn-completed" && !run.text.trim() && !run.steps.length && isCompactionRequest(lastUserMessage(state, sessionId)))
        return { state, runs: remaining, changed: true };
      const message = {
        id: state.next_id,
        session_id: sessionId,
        body: replyBody(run.text, event, run.steps.length > 0),
        // A turn the plan's usage limit stopped carries the limit, so the Chat can offer another account.
        context: event.type === "turn-failed" && event.limit ? { kind: "limit", ...event.limit } : null,
        role: "assistant",
        model: run.model,
        outcome: event.type === "turn-completed" ? "completed" : event.type === "turn-cancelled" ? "cancelled" : "failed",
        // What the turn cost, when the agent reports it (Kiro's credits).
        ...(event.type === "turn-completed" && Number.isFinite(event.credits) ? { credits: event.credits } : {}),
        // Codex sends no end for a command still running when a turn stops, so the turn's end closes it.
        ...savedSteps(run.text, run.steps, event.type === "turn-completed" ? "done" : "failed"),
      };
      return { state: { ...state, next_id: state.next_id + 1, messages: [...state.messages, message] }, runs: remaining, changed: true };
    }
    default:
      return { state, runs: applyRunEvent(runs, chatId, event), changed: false };
  }
}

const isCompactionRequest = (message) => message?.context?.kind === "compaction";
const lastUserMessage = (state, sessionId) => state.messages.findLast((message) => message.session_id === sessionId && message.role === "user");

/** The manual or automatic compaction that has not reached its boundary yet, if any. */
function pendingCompaction(state, sessionId) {
  const request = state.messages.findLast((message) => message.session_id === sessionId && isCompactionRequest(message));
  return request?.context.status === "preparing" ? request : null;
}

/** Save the reply so far above the divider; the same turn continues below it. */
function addCompaction(state, runs, projectPath, chatId, status, event = {}) {
  const sessionId = sessionIdFromKey(chatId);
  const usage = runs[chatId]?.contextUsage ?? state.sessions[sessionId].contextUsage;
  const split = splitRunForSteer(state, runs, projectPath, chatId);
  const before = event.before ?? usage?.used;
  const message = {
    id: split.state.next_id,
    session_id: sessionId,
    role: "assistant",
    body: "",
    model: runs[chatId]?.model ?? lastUserModel(state, sessionId),
    context: {
      kind: "compaction",
      status,
      ...(before === undefined ? {} : { before }),
      ...(event.after === undefined ? {} : { after: event.after }),
      ...(usage?.size > 0 ? { size: usage.size } : {}),
    },
  };
  const run = split.runs[chatId];
  return {
    state: { ...split.state, next_id: message.id + 1, messages: [...split.state.messages, message] },
    runs: run ? { ...split.runs, [chatId]: { ...run, split: true } } : split.runs,
    changed: true,
  };
}

function withContext(state, message, context) {
  return { ...state, messages: state.messages.map((item) => (item === message ? { ...item, context } : item)) };
}

function replyBody(text, event, hasSteps) {
  const reply = text.trim();
  if (event.type === "turn-failed") {
    // Milagre's own messages are full sentences that name the CLI and the fix; the agent's raw errors get a prefix.
    const failure = event.notice ? event.message : `Agent error: ${event.message}`;
    return reply ? `${reply}\n\n${failure}` : failure;
  }
  // Cancellation belongs to the message's outcome, not to the agent's words (or language).
  if (event.type === "turn-cancelled") return reply;
  return reply || (hasSteps ? "" : "The agent finished without a reply.");
}

/**
 * Before a steering message joins a running turn, the reply streamed so far is saved as its own
 * message, so the chat reads in order: the reply so far, the new message, then the rest of the reply.
 * Finished steps are saved with it; steps still running carry on at the start of the rest of the reply.
 */
export function splitRunForSteer(state, runs, projectPath, chatId) {
  const sessionId = sessionIdFromKey(chatId);
  const run = runs[chatId];
  if (!chatInProject(projectPath, chatId) || !state.sessions[sessionId] || !run) return { state, runs, changed: false };
  const split = splitRun(run);
  if (!split) return { state, runs, changed: false };
  const finished = run.steps.filter((step) => step.status !== "running");
  const message = {
    id: state.next_id,
    session_id: sessionId,
    body: run.text.trim(),
    context: null,
    role: "assistant",
    model: run.model,
    ...savedSteps(run.text, finished, "done"),
  };
  return {
    state: { ...state, next_id: state.next_id + 1, messages: [...state.messages, message] },
    runs: { ...runs, [chatId]: split },
    changed: true,
  };
}

/**
 * Shows the user's answers to a question as their message: the reply so far is saved first (as for a
 * steering message), so the answers sit between what the agent asked and what it does next.
 * `messageId` is the new message's id, so it can be taken back if the answers don't reach the agent.
 */
export function recordAnswers(state, runs, projectPath, chatId, body, answered) {
  const sessionId = sessionIdFromKey(chatId);
  const run = runs[chatId];
  if (!chatInProject(projectPath, chatId) || !state.sessions[sessionId] || !run || !body) return { state, runs, messageId: null };
  const split = splitRunForSteer(state, runs, projectPath, chatId);
  const message = {
    id: split.state.next_id,
    session_id: sessionId,
    body,
    context: null,
    role: "user",
    model: run.model,
    ...(answered?.length ? { answered } : {}),
  };
  return {
    state: { ...split.state, next_id: message.id + 1, messages: [...split.state.messages, message] },
    runs: applyRunEvent(runs, chatId, { type: "answers-sent" }),
    messageId: message.id,
  };
}

/**
 * The answers to a question request as the user's message keeps them, for its answer card: each question with what
 * was answered, in the request's order. A typed answer to a secret question is masked; null when nothing was answered.
 */
export function answeredQuestions(request, answers) {
  if (!request || !answers) return null;
  const answered = request.questions.flatMap((question) => {
    const values = Array.isArray(answers[question.id]) ? answers[question.id] : [];
    if (!values.length) return [];
    const shown = values.map((value) => (question.secret && !question.options.some((option) => option.label === value) ? "••••••" : value));
    return [{ header: question.header, question: question.question, answers: shown }];
  });
  return answered.length ? answered : null;
}
