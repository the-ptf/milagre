const { chatInProject } = require("@milagre/shared/agent-runs");
const { reconcileState } = require("@milagre/shared/reconcile");
const { pullRequestRefs } = require("@milagre/shared/chats");

const failure = (status, message) => Object.assign(new Error(message), { status });
const TRANSCRIPT_TAIL = 4;

const TRANSCRIPT_TEXT = 600;

function projectPullRequestRefs(project) {
  const messages = new Map();
  for (const message of project.state.messages) {
    const list = messages.get(message.session_id) || [];
    list.push(message);
    messages.set(message.session_id, list);
  }
  const sessions = project.state.sessions ?? {};
  const ids = new Set([...Object.keys(sessions), ...[...messages.keys()].map(String)]);
  const refs = Object.fromEntries(
    [...ids]
      .map((id) => [
        id,
        sessions[id]?.summary ? (sessions[id].summary.pullRequests ?? []) : pullRequestRefs(messages.get(Number(id)) ?? messages.get(id) ?? []),
      ])
      .filter(([, refs]) => refs.length),
  );
  const stable = reconcileState(lastPullRequestRefs.get(project.path), refs);
  lastPullRequestRefs.delete(project.path);
  lastPullRequestRefs.set(project.path, stable);
  if (lastPullRequestRefs.size > 16) lastPullRequestRefs.delete(lastPullRequestRefs.keys().next().value);
  return stable;
}
const lastPullRequestRefs = new Map();

function forPhone(project) {
  const state = project?.state;
  if (!state) return project;
  const messages = state.messages.map(phoneMessage);
  const sessions = Object.fromEntries(Object.entries(state.sessions).map(([id, session]) => [id, phoneSession(session)]));
  return { ...project, pullRequestRefs: projectPullRequestRefs(project), state: { ...state, messages, sessions } };
}
const phoneMessages = new WeakMap();
const phoneSessions = new WeakMap();
const phoneAgents = new WeakMap();
const clip = (text) => (typeof text === "string" && text.length > TRANSCRIPT_TEXT ? `${text.slice(0, TRANSCRIPT_TEXT)}…` : text);
function phoneMessage(message) {
  if (!message.steps?.some((step) => step.detail)) return message;
  let slim = phoneMessages.get(message);
  if (!slim) {
    const thought = message.steps.findLastIndex((step) => step.kind === "thinking" && step.detail?.trim());
    const steps = message.steps.map((step, index) => (step.detail && index !== thought ? { ...step, detail: undefined, hasDetail: true } : step));
    slim = { ...message, steps };
    phoneMessages.set(message, slim);
  }
  return slim;
}
function phoneSession(session) {
  if (!session.subagents?.length) return session;
  let slim = phoneSessions.get(session);
  if (!slim) {
    slim = { ...session, subagents: session.subagents.map(phoneAgent) };
    phoneSessions.set(session, slim);
  }
  return slim;
}
function phoneAgent(agent) {
  let slim = phoneAgents.get(agent);
  if (!slim) {
    slim = {
      ...agent,
      latestActivity: clip(agent.latestActivity),
      transcript: (agent.transcript || [])
        .slice(-TRANSCRIPT_TAIL)
        .map((item) => ({ ...item, text: agent.source === "milagre-advisor" ? item.text.slice(0, 40_000) : clip(item.text) })),
    };
    phoneAgents.set(agent, slim);
  }
  return slim;
}
function withoutMessages(slim) {
  const strip = (owner) => (owner?.state ? { ...owner, state: { ...owner.state, messages: [], messagesInChats: true } } : owner);
  return slim.link ? { ...slim, link: strip(slim.link) } : { ...slim, project: strip(slim.project) };
}
function forNewWorktree(project, worktreeId) {
  const { messagesInChats: _lean, ...state } = project.state;
  const worktree = state.worktrees?.[worktreeId];
  const sessions = Object.fromEntries(Object.entries(state.sessions ?? {}).filter(([, session]) => session.worktree_id === worktreeId));
  return { ...project, state: { ...state, worktrees: worktree ? { [worktreeId]: worktree } : {}, sessions, messages: [] } };
}
function forChatList(project, runs) {
  const byChat = new Map();
  for (const message of project.state.messages) {
    let row = byChat.get(message.session_id);
    if (!row) {
      row = { first: message };
      byChat.set(message.session_id, row);
    }
    row.last = message;
    if (message.role !== "assistant") {
      row.lastInput = message;
    }
  }
  const sessions = Object.fromEntries(
    Object.entries(project.state.sessions).map(([id, session]) => {
      const { subagents: _subagents, ...metadata } = session;
      return [id, metadata];
    }),
  );
  const boundaries = new Set([...byChat.values()].flatMap((row) => [row.first, row.lastInput, row.last]));
  const messages = project.state.messages
    .filter((message) => message.clientMessageId || boundaries.has(message))
    .map(({ id, session_id, role, outcome, clientMessageId }) => ({ id, session_id, role, outcome, clientMessageId, body: "", context: null }));
  const marks = Object.fromEntries(
    Object.entries(runs.runs || {}).map(([key, run]) => [
      key,
      {
        model: run.model,
        startedAt: run.startedAt,
        approvals: run.approvals,
        questions: run.questions,
        answered: {},
        text: "",
        steps: [],
      },
    ]),
  );
  return {
    previewOnly: true,
    project: { ...project, pullRequestRefs: projectPullRequestRefs(project), state: { ...project.state, sessions, messages, tasks: {} } },
    runs: { ...runs, runs: marks },
  };
}

const LIVE_STEPS = 3;
const LIVE_DETAIL = 4096;

function runsForPhone(runs) {
  if (!runs?.runs) return runs;
  const slimSteps = (steps) => {
    const thought = steps.findLastIndex((step) => step.kind === "thinking" && step.detail?.trim());
    return steps.map((step, index) => {
      if (!step.detail || index === thought) return step;
      if (index >= steps.length - LIVE_STEPS || step.status === "running") {
        return step.detail.length > LIVE_DETAIL ? { ...step, detail: `…${step.detail.slice(-LIVE_DETAIL)}` } : step;
      }
      return { ...step, detail: undefined, hasDetail: true };
    });
  };
  return {
    ...runs,
    runs: Object.fromEntries(
      Object.entries(runs.runs).map(([key, run]) => [key, run?.steps?.some((step) => step.detail) ? { ...run, steps: slimSteps(run.steps) } : run]),
    ),
  };
}
function projectRuns({ runs, seq }, projectPath) {
  const own = {};
  for (const key in runs ?? {}) if (Object.hasOwn(runs, key) && chatInProject(projectPath, key)) own[key] = runs[key];
  return { runs: own, seq };
}
function projectRunsForPhone(all, projectPath, chats) {
  const own = projectRuns(all, projectPath);
  if (chats === undefined) return runsForPhone(own);
  const detailChats = [...new Set(chats)].sort((a, b) => a - b);
  const selected = new Set(detailChats.map((id) => `${projectPath}#${id}`));
  const runs = {};
  const summaries = {};
  for (const [key, run] of Object.entries(own.runs)) {
    if (selected.has(key)) runs[key] = run;
    else {
      const { text: _text, steps: _steps, ...summary } = run;
      summaries[key] = summary;
    }
  }
  return { ...runsForPhone({ seq: own.seq, runs }), summaries, detailChats };
}

function requestedRunChats(params) {
  if (!params.has("chats")) return undefined;
  let chats;
  try {
    chats = JSON.parse(params.get("chats"));
  } catch {
    throw failure(400, "Choose a valid array of Chat ids");
  }
  if (params.getAll("chats").length !== 1 || !Array.isArray(chats) || chats.some((id) => !Number.isSafeInteger(id) || id <= 0))
    throw failure(400, "Choose a valid array of Chat ids");
  return [...new Set(chats)].sort((a, b) => a - b);
}
module.exports = {
  failure,
  forPhone,
  phoneMessage,
  phoneSession,
  withoutMessages,
  forNewWorktree,
  forChatList,
  runsForPhone,
  projectRuns,
  projectRunsForPhone,
  requestedRunChats,
};
