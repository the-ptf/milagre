import { hasTranscriptTail } from "./subagent-transcript.mjs";
import { qualifyKey } from "./chat-scopes.mjs";
import { nativePlan } from "./chat-plan.mjs";

export { computerOfKey } from "./chat-scopes.mjs";

export const MAX_OUTPUT = 20_000;

export function capOutput(text) {
  return text.length > MAX_OUTPUT ? `… truncated\n${text.slice(-MAX_OUTPUT)}` : text;
}

/** `computerId`: a paired computer's chat key is `${computerId}|${path}#${id}`; this Mac's has no prefix. */
export function chatKey(projectPath, sessionId, computerId) {
  return `${qualifyKey(computerId, projectPath)}#${sessionId}`;
}

/** The session id after the last `#`, or NaN. */
export function sessionIdFromKey(key) {
  const match = /#(\d+)$/.exec(key);
  return match ? Number(match[1]) : Number.NaN;
}

export function projectOfKey(key) {
  const index = key.lastIndexOf("#");
  return index === -1 ? key : key.slice(0, index);
}

export function chatInProject(projectPath, key) {
  return key === chatKey(projectPath, sessionIdFromKey(key));
}

export function lastUserModel(state, sessionId) {
  const last = state.messages.findLast((message) => message.session_id === sessionId && message.role === "user");
  if (last) return last.model ?? "";
  return state.sessions?.[sessionId]?.summary?.lastModel ?? "";
}

export function startRun(runs, chatId, model, permissionMode) {
  const run = { text: "", model, startedAt: Date.now(), steps: [], approvals: [], questions: [], answered: {} };
  return { ...runs, [chatId]: permissionMode ? { ...run, permissionMode } : run };
}

function updateStep(run, id, update) {
  const index = run.steps.findIndex((step) => step.id === id);
  const next = index === -1 ? null : update(run.steps[index]);
  return next ? { ...run, steps: run.steps.map((step, position) => (position === index ? next : step)) } : null;
}

function endStep({ detail: streamed, ...step }, end) {
  const detail = end.detail ?? (step.kind === "thinking" ? streamed : undefined);
  return {
    ...step,
    status: end.status,
    title: end.title ?? step.title,
    ...(end.note === undefined ? {} : { note: end.note }),
    ...(detail === undefined ? {} : { detail }),
    ...(end.durationMs === undefined ? {} : { durationMs: end.durationMs }),
    ...(end.endedAt === undefined ? {} : { endedAt: end.endedAt }),
    ...(end.summary === undefined ? {} : { summary: end.summary }),
    ...(end.error === undefined ? {} : { error: end.error }),
    ...(end.file === undefined ? {} : { file: end.file }),
    ...(end.artifact === undefined ? {} : { artifact: end.artifact }),
    ...(end.routine === undefined ? {} : { routine: end.routine }),
  };
}

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

export function runStatus(run) {
  if (!run) return "idle";
  return run.approvals.length || run.questions.length ? "waiting" : "working";
}

const TURN_ENDS = new Set(["turn-completed", "turn-cancelled", "turn-failed"]);

export function isTurnEnd(event) {
  return TURN_ENDS.has(event.type);
}

export function subagentActive(agent) {
  return ["initializing", "running", "waiting"].includes(agent?.status);
}

function splitRun(run) {
  const finished = run.steps.filter((step) => step.status !== "running");
  if (!run.text.trim() && !finished.length) return null;
  const running = run.steps.filter((step) => step.status === "running").map((step) => ({ ...step, offset: 0 }));
  return { ...run, text: "", steps: running, split: true };
}

function splitBeforeEvent(run, event) {
  if (!run) return null;
  if (event.type === "message-sent") return splitRun(run);
  if (event.type !== "step-started" || !run.steered || !run.text.trim()) return null;
  const { steered: _answered, ...remaining } = splitRun(run);
  return remaining;
}

export function applyRunEvent(runs, chatId, event, model = "", split = splitBeforeEvent(runs[chatId], event)) {
  if (split) runs = { ...runs, [chatId]: split };
  const run = runs[chatId];
  switch (event.type) {
    case "message-sent": {
      if (!run) return startRun(runs, chatId, event.model, event.permissionMode);
      return { ...runs, [chatId]: { ...run, steered: true } };
    }
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
      return run
        ? { ...runs, [chatId]: { ...run, contextUsage: { used: event.used, size: event.size, ...(event.cost > 0 ? { cost: event.cost } : {}) } } }
        : runs;
    case "answers-sent":
      return run ? { ...runs, [chatId]: splitRun(run) ?? { ...run, split: true } } : runs;
    case "text-delta":
      return run ? { ...runs, [chatId]: { ...run, text: run.text + event.text, ...(run.waitingForSubagents ? { waitingForSubagents: false } : {}) } } : runs;
    case "step-started": {
      if (!run) return runs;
      const viewed = event.step.kind === "image" && event.step.imageOrigin === "viewed";
      const existing = run.steps.findIndex((step) => step.id === event.step.id);
      const admitted = existing !== -1 && run.steps[existing].kind === "image" && run.steps[existing].imageOrigin === "viewed";
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
    default:
      return runs;
  }
}

/** `changed` is true when `state` must be saved; streamed text lives only in `runs` until the turn ends. */
// What a finished turn leaves on its session: the context it used, what a Pi Chat has spent, and how fast a local model ran.
function withTurnTotals(state, sessionId, session, run, event) {
  const metrics = event.type === "turn-completed" ? event.metrics : undefined;
  const usage = run.contextUsage ?? (metrics ? session.contextUsage : undefined);
  if (!usage) return state;
  const contextUsage = metrics ? { ...usage, metrics } : usage;
  return { ...state, sessions: { ...state.sessions, [sessionId]: { ...session, contextUsage } } };
}

// Compaction shrinks the context, not what a Pi Chat has spent.
function compactedUsage(used, size, run, session) {
  const cost = run?.contextUsage?.cost ?? session.contextUsage?.cost;
  return { used, size, ...(cost ? { cost } : {}) };
}

export function applyAgentEvent(state, runs, projectPath, chatId, event) {
  const sessionId = sessionIdFromKey(chatId);
  let session = state.sessions[sessionId];
  if (!chatInProject(projectPath, chatId) || !session) return { state, runs, changed: false };
  const run = runs[chatId];
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
      const tail = hasTranscriptTail(event.agent) || hasTranscriptTail(previous);
      const agent = previous
        ? {
            ...previous,
            ...event.agent,
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
            endedAt: event.agent.endedAt,
            detailsOnDemand: event.agent.detailsOnDemand,
          }
        : event.agent;
      if (agent.transcriptLength === undefined) delete agent.transcriptLength;
      if (agent.endedAt === undefined) delete agent.endedAt;
      if (agent.detailsOnDemand === undefined) delete agent.detailsOnDemand;
      const subagents = previous ? children.map((child) => (child.id === agent.id ? agent : child)) : [...children, agent];
      return { state: { ...state, sessions: { ...state.sessions, [sessionId]: { ...session, subagents } } }, runs, changed: true };
    }
    case "background-tasks": {
      const tasks = Array.isArray(event.tasks) ? event.tasks : [];
      if (JSON.stringify(tasks) === JSON.stringify(session.backgroundTasks ?? [])) return { state, runs, changed: false };
      const { backgroundTasks: _previous, ...rest } = session;
      const next = tasks.length ? { ...rest, backgroundTasks: tasks } : rest;
      return { state: { ...state, sessions: { ...state.sessions, [sessionId]: next } }, runs, changed: true };
    }
    case "plan-updated": {
      const { plan: _previous, ...rest } = session;
      const next = event.plan ? { ...rest, plan: event.plan } : rest;
      return { state: { ...state, sessions: { ...state.sessions, [sessionId]: next } }, runs, changed: true };
    }
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
    case "message-sent":
    case "step-started": {
      if (event.type === "step-started" && event.step.id.startsWith("compact-") && pendingCompaction(state, sessionId)) return { state, runs, changed: false };
      const split = splitBeforeEvent(run, event);
      return {
        state: split ? saveSplitReply(state, sessionId, run) : state,
        runs: applyRunEvent(runs, chatId, event, "", split),
        changed: Boolean(split) || suggestionChanged,
      };
    }
    case "turn-started":
      return { state, runs: applyRunEvent(runs, chatId, event, lastUserModel(state, sessionId)), changed: suggestionChanged };
    case "context-compacting":
      return pendingCompaction(state, sessionId) ? { state, runs, changed: false } : addCompaction(state, runs, projectPath, chatId, "preparing");
    case "context-compacted": {
      const size = run?.contextUsage?.size ?? session.contextUsage?.size;
      if (Number.isFinite(event.after) && event.after >= 0 && size > 0) {
        const contextUsage = compactedUsage(event.after, size, run, session);
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
      state = withTurnTotals(state, sessionId, session, run, event);
      const unfinished = pendingCompaction(state, sessionId);
      if (unfinished) state = withContext(state, unfinished, { ...unfinished.context, status: "failed" });
      if (event.type === "turn-completed" && run.split && !run.text.trim() && !run.steps.length)
        return { state, runs: remaining, changed: Boolean(run.contextUsage) || Boolean(unfinished) || suggestionUpdated };
      if (event.type === "turn-completed" && !run.text.trim() && !run.steps.length && isCompactionRequest(lastUserMessage(state, sessionId)))
        return { state, runs: remaining, changed: true };
      const message = {
        id: state.next_id,
        session_id: sessionId,
        body: replyBody(run.text, event, run.steps.length > 0),
        context: event.type === "turn-failed" && event.limit ? { kind: "limit", ...event.limit } : null,
        role: "assistant",
        model: run.model,
        outcome: event.type === "turn-completed" ? "completed" : event.type === "turn-cancelled" ? "cancelled" : "failed",
        ...(event.type === "turn-completed" && Number.isFinite(event.credits) ? { credits: event.credits } : {}),
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

function pendingCompaction(state, sessionId) {
  const request = state.messages.findLast((message) => message.session_id === sessionId && isCompactionRequest(message));
  return request?.context.status === "preparing" ? request : null;
}

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
    const failure = event.notice ? event.message : `Agent error: ${event.message}`;
    return reply ? `${reply}\n\n${failure}` : failure;
  }
  if (event.type === "turn-cancelled") return reply;
  return reply || (hasSteps ? "" : "The agent finished without a reply.");
}

export function splitRunForSteer(state, runs, projectPath, chatId) {
  const sessionId = sessionIdFromKey(chatId);
  const run = runs[chatId];
  if (!chatInProject(projectPath, chatId) || !state.sessions[sessionId] || !run) return { state, runs, changed: false };
  const split = splitRun(run);
  if (!split) return { state, runs, changed: false };
  return { state: saveSplitReply(state, sessionId, run), runs: { ...runs, [chatId]: split }, changed: true };
}

function saveSplitReply(state, sessionId, run) {
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
  return { ...state, next_id: state.next_id + 1, messages: [...state.messages, message] };
}

export function recordAnswers(state, runs, projectPath, chatId, body, answered, images) {
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
    ...(images?.length ? { images } : {}),
  };
  return {
    state: { ...split.state, next_id: message.id + 1, messages: [...split.state.messages, message] },
    runs: applyRunEvent(runs, chatId, { type: "answers-sent" }),
    messageId: message.id,
  };
}

/** Null when nothing was answered; a typed answer to a secret question is masked. */
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
