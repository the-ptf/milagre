const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { ChatImages } = require("../chat-images.cjs");
const { storeImages } = require("../project-content.cjs");
const { ipcErrorMessage } = require("@milagre/shared/result");
const {
  answeredQuestions,
  applyAgentEvent,
  chatKey,
  isTurnEnd,
  lastUserModel,
  projectOfKey,
  recordAnswers,
  sessionIdFromKey,
  splitRunForSteer,
} = require("@milagre/shared/agent-runs");
const { archiveFinishedSubagents, patchSession } = require("@milagre/shared/project-edits");
const { catchUpStart, handoffKind, isHandoff, lastTurnProvider } = require("@milagre/shared/handoff");
const { framedBrief, renderTranscript } = require("./handover.cjs");
const { providerCapabilities } = require("@milagre/shared/provider-capabilities");
const { backgroundBusyMessage, processWork } = require("@milagre/shared/chat-activity");
const { summarizeStep } = require("@milagre/shared/tool-activity");
const { providerName } = require("@milagre/shared/providers");
const { accountSwitchText, limitResetText } = require("@milagre/shared/usage-limit");
const { eligibleLimitTurn, DAY_MS, RESET_ALLOWANCE_MS, RESET_PROMPT } = require("../limit-resume.cjs");
const { PERMISSION_MODES } = require("./permissions.cjs");
const { compactionMessage } = require("@milagre/shared/compaction");
const { CONTEXT_DEFAULTS, shouldAutoCompact } = require("@milagre/shared/context-settings");
const { routineRunOf } = require("@milagre/shared/routines");
const { ESCALATION_LEVEL, owesTurn } = require("../escalation-guard.cjs");

const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;
function withLimitFields(state, sessionId, fields) {
  const session = state.sessions[sessionId];
  const next = { ...session };
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) delete next[name];
    else next[name] = value;
  }
  return { ...state, sessions: { ...state.sessions, [sessionId]: next } };
}
function duplicateSend(message) {
  return { sessionId: message.session_id, started: Promise.resolve(null), duplicate: true };
}

const RESUME_BODY = "Milagre restarted. Continue where you left off.";
const RESUME_PROMPT =
  "Milagre, the app running you, closed while you were working and has just opened again, so your last turn was cut off. Continue where you left off. Check what is already done before repeating any of it.";

const resumePrompt = (questions = []) =>
  questions.length
    ? `${RESUME_PROMPT} You were waiting for the user's answer to ${questions.map((question) => `"${question}"`).join(" and ")}. That question is gone: ask it again with your question tool.`
    : RESUME_PROMPT;

const LIMIT_PROMPT =
  "Your last turn stopped because the account hit its plan's usage limit, and Milagre switched this chat to another account. Continue where you left off; if the last request has no answer yet, answer it now. Check what is already done before repeating any of it.";

const withoutDraft = ({
  handoverDraft: _handoverDraft,
  resumeTurn: _resumeTurn,
  limitResume: _limitResume,
  limitTurn: _limitTurn,
  suggestion: _suggestion,
  suggestionTurnId: _suggestionTurn,
  ...rest
}) => rest;

const withLead = (lead, prompt) => [lead, prompt].filter((part) => part?.trim()).join("\n\n");

function applySwitch(session, from, to) {
  const parked = { ...session.native_sessions };
  if (session.native_session_id) parked[from] = session.native_session_id;
  const resumeId = parked[to];
  delete parked[to];
  return withNativeSessions({ ...session, provider: to }, resumeId, parked);
}

function revertSwitch(session, from, to) {
  const parked = { ...session.native_sessions };
  if (session.native_session_id) parked[to] = session.native_session_id;
  const resumeId = parked[from];
  delete parked[from];
  return withNativeSessions({ ...session, provider: from }, resumeId, parked);
}

function compactionProvider(session) {
  const provider = session.provider ?? "claude";
  if (!providerCapabilities(provider).compact) throw new Error("Only Claude chats can be compacted from here.");
  return provider;
}

function failHandoff(latest, divider, sessionId, from, to) {
  const session = latest.sessions[sessionId];
  return {
    ...latest,
    sessions: session && from !== to && session.provider === to ? { ...latest.sessions, [sessionId]: revertSwitch(session, from, to) } : latest.sessions,
    messages: latest.messages.map((item) => (item === divider ? { ...item, context: { ...item.context, status: "failed" } } : item)),
  };
}

function withoutQueued(session, id) {
  const { queued = [], queueHeld: _held, ...rest } = session;
  const left = queued.filter((item) => item.id !== id);
  if (!left.length) return rest;
  return { ...rest, queued: left, ...(session.queueHeld ? { queueHeld: true } : {}) };
}

const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

async function queuedImages(images = []) {
  const read = await Promise.all(
    images.map(async (image) => {
      const mime = IMAGE_TYPES[path.extname(image.path ?? "").toLowerCase()];
      if (!mime) return image.dataUrl ? image : null;
      const bytes = await fs.readFile(image.path).catch(() => null);
      return bytes ? { id: image.id, name: image.name, dataUrl: `data:${mime};base64,${bytes.toString("base64")}` } : null;
    }),
  );
  return read.filter(Boolean);
}

function withNativeSessions(session, current, parked) {
  const { native_session_id: _current, native_sessions: _parked, ...rest } = session;
  return { ...rest, ...(current ? { native_session_id: current } : {}), ...(Object.keys(parked).length ? { native_sessions: parked } : {}) };
}

const hasMessages = (state, session) => (session.summary?.count ?? 0) > 0 || state.messages.some((message) => message.session_id === session.id);

const FORMER_WORKTREE = "This Run's Worktree was removed because the Run left nothing in it. Start a new Chat to continue.";

function starterChat(latest, worktree) {
  const existing = Object.values(latest.sessions).find(
    (item) =>
      item.worktree_id === worktree.id &&
      !item.readOnlyReason &&
      !item.handoverPending &&
      item.handoverDraft === undefined &&
      !item.routine &&
      !hasMessages(latest, item),
  );
  if (existing) return { state: latest, session: existing };
  return newChat(latest, worktree);
}

function newChat(latest, worktree) {
  const session = { id: latest.next_id, worktree_id: worktree.id, agent_name: worktree.name, status: "Created" };
  return { state: { ...latest, next_id: latest.next_id + 1, sessions: { ...latest.sessions, [session.id]: session } }, session };
}

class ChatHost {
  constructor({
    states,
    startTurn,
    interrupt = async () => {},
    publish,
    broadcast,
    isFocused = () => true,
    isChatFocused,
    nameChat = async () => {},
    readSubagents = async () => [],
    handoverTools,
    beforeSend = async () => {},
    assertWritable = () => {},
    contextSettings = () => CONTEXT_DEFAULTS,
    beforeTask = async () => {},
    onUnblocked = () => {},
    onQueuedStart = () => {},
    onQueuedRemoved = () => {},
    now = Date.now,
  }) {
    Object.assign(this, {
      states,
      startTurn,
      interrupt,
      publish,
      broadcast,
      isFocused,
      isChatFocused,
      nameChat,
      readSubagents,
      handoverTools,
      beforeSend,
      assertWritable,
      contextSettings,
      beforeTask,
      onUnblocked,
      onQueuedStart,
      onQueuedRemoved,
      now,
    });
    this.preparing = new Map();
    this.pendingSends = new Map();
    this.limitResumeGenerations = new Map();
    this.limitResumeFlights = new Map();
    this.limitResumeReasons = new Map();
    this.subagentRecoveries = new Map();
    this.runs = {};
    this.images = new ChatImages({ states, runs: () => this.runs, broadcast });
    this.seq = 0;
    this.openChat = null;
    this.notes = new Map();
    this.turns = new Map();
    this.routineTurns = new Set();
    this.quitting = false;
    this.startingTurns = new Map();
    this.queueWaiters = new Map();
    this.sendNext = new Map();
    this.wakeTurns = new Set();
  }

  isBusy(chatId) {
    return Boolean(this.runs[chatId]) || this.preparing.has(chatId) || this.notes.has(chatId) || this.subagentRecoveries.has(chatId);
  }

  busyChats() {
    return new Set([
      ...Object.keys(this.runs),
      ...this.preparing.keys(),
      ...this.notes.keys(),
      ...this.subagentRecoveries.keys(),
      ...this.startingTurns.keys(),
      ...this.pendingSends.keys(),
    ]);
  }

  snapshot() {
    return { runs: this.runs, seq: this.seq };
  }

  turnSettings(chatId) {
    if (!this.turns.has(chatId)) return null;
    const { prompt: _prompt, guard: _guard, ...settings } = this.turns.get(chatId);
    return settings;
  }

  async notePermissionMode(chatId, mode) {
    if (!PERMISSION_MODES.has(mode)) throw new Error(`Unknown permission mode: ${mode}`);
    const turn = this.turns.get(chatId);
    if (turn) this.turns.set(chatId, { ...turn, permissionMode: mode });
    const projectPath = projectOfKey(chatId);
    const sessionId = sessionIdFromKey(chatId);
    const { state, changed } = await this.states.update(
      projectPath,
      (latest) => {
        const session = latest.sessions[sessionId];
        if (!session || session.permissionMode === mode) return latest;
        return { ...latest, sessions: { ...latest.sessions, [sessionId]: { ...session, permissionMode: mode } } };
      },
      { chats: [] },
    );
    if (changed) this.broadcast(projectPath, state);
  }

  async adoptSubchat(childKey, parentKey) {
    const projectPath = projectOfKey(childKey);
    if (projectPath !== projectOfKey(parentKey) || childKey === parentKey) return false;
    const childId = sessionIdFromKey(childKey);
    const parentId = sessionIdFromKey(parentKey);
    let adopted = false;
    const { state, changed } = await this.states.update(
      projectPath,
      (latest) => {
        const child = latest.sessions[childId];
        if (!child || child.parent !== undefined || !latest.sessions[parentId]) return latest;
        for (let id = parentId, seen = new Set(); id !== undefined && !seen.has(id); id = latest.sessions[id]?.parent) {
          if (id === childId) return latest;
          seen.add(id);
        }
        adopted = true;
        return { ...latest, sessions: { ...latest.sessions, [childId]: { ...child, parent: parentId } } };
      },
      { chats: [] },
    );
    if (changed) this.broadcast(projectPath, state);
    return adopted;
  }

  async detachSubchat(childKey, parentKey) {
    const projectPath = projectOfKey(childKey);
    const childId = sessionIdFromKey(childKey);
    const parentId = parentKey === undefined ? undefined : sessionIdFromKey(parentKey);
    if (parentKey !== undefined && projectOfKey(parentKey) !== projectPath) return false;
    let detached = false;
    const { state, changed } = await this.states.update(
      projectPath,
      (latest) => {
        const child = latest.sessions[childId];
        if (child?.parent === undefined || (parentId !== undefined && child.parent !== parentId)) return latest;
        detached = true;
        const { parent: _parent, ...rest } = child;
        return { ...latest, sessions: { ...latest.sessions, [childId]: rest } };
      },
      { chats: [] },
    );
    if (changed) this.broadcast(projectPath, state);
    return detached;
  }

  async setPermissionMode(chatId, mode, live) {
    let failure = null;
    try {
      await live(chatId, mode);
    } catch (error) {
      failure = error;
    }
    try {
      await this.notePermissionMode(chatId, mode);
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
  }

  forget(chatId) {
    this.invalidateLimitResume(projectOfKey(chatId), sessionIdFromKey(chatId));
    this.routineTurns.delete(chatId);
  }

  async emptyChat(projectPath, worktreeId, { operationId, assertActive, origin, title, generatedTitle, fresh = false } = {}) {
    let sessionId;
    const { state, changed } = await this.states.update(
      projectPath,
      (latest) => {
        assertActive?.();
        const worktree = latest.worktrees[worktreeId];
        if (!worktree) throw new Error("That worktree is no longer in the project.");
        this.assertWritable(projectPath, latest, null, worktree);
        if (worktree.sharedChat) throw new Error("This Worktree belongs to a shared Link Chat. Open its Link instead.");
        const result = fresh ? newChat(latest, worktree) : starterChat(latest, worktree);
        sessionId = result.session.id;
        if (!operationId && !origin && title === undefined && generatedTitle === undefined) return result.state;
        const session = {
          ...result.session,
          ...(operationId ? { localMcpOperations: [...(result.session.localMcpOperations ?? []), operationId] } : {}),
          ...(origin ? { routine: { routineId: origin.routineId, runId: origin.runId, hidden: true } } : {}),
          ...(title !== undefined ? { title } : {}),
          ...(generatedTitle !== undefined ? { generatedTitle } : {}),
        };
        return { ...result.state, sessions: { ...result.state.sessions, [sessionId]: session } };
      },
      { chats: [] },
    );
    if (changed) this.broadcast(projectPath, state);
    return sessionId;
  }

  async nameRunChat(projectPath, sessionId, runId, generatedTitle) {
    let named = false;
    const { state, changed } = await this.states.update(
      projectPath,
      (latest) => {
        const session = latest.sessions[sessionId];
        if (!session || session.routine?.runId !== runId || session.title?.trim()) return latest;
        named = true;
        if (session.generatedTitle === generatedTitle) return latest;
        return { ...latest, sessions: { ...latest.sessions, [sessionId]: { ...session, generatedTitle } } };
      },
      { chats: [] },
    );
    if (changed) this.broadcast(projectPath, state);
    return named;
  }

  setOpenChat(chatId) {
    this.openChat = typeof chatId === "string" ? chatId : null;
  }

  recoverSubagents(chatId) {
    if (this.subagentRecoveries.has(chatId)) return this.subagentRecoveries.get(chatId);
    const pending = (async () => {
      const projectPath = projectOfKey(chatId);
      const sessionId = sessionIdFromKey(chatId);
      if (!this.states.has(projectPath) || this.runs[chatId] || this.quitting) return;
      const saved = await this.states.get(projectPath);
      const session = saved.sessions[sessionId];
      const cwd = session?.workspacePath ?? saved.worktrees?.[session?.worktree_id]?.path;
      if (!cwd || !providerCapabilities(session?.provider).subagentRecovery || !session.native_session_id || session.archived) return;
      const unknown = (session.subagents ?? []).filter(
        (agent) => agent.status === "unknown" && agent.source !== "milagre-advisor" && !agent.archived && agent.id !== session.native_session_id,
      );
      if (!unknown.length) return;
      const events = await this.readSubagents({ cwd, agents: unknown, projectPath, provider: session.provider, nativeSessionId: session.native_session_id });
      if (!events.length) return;
      const { state, changed } = await this.states.update(
        projectPath,
        (latest) => {
          const current = latest.sessions[sessionId];
          if (
            this.quitting ||
            this.runs[chatId] ||
            !current ||
            current.archived ||
            current.provider !== session.provider ||
            current.native_session_id !== session.native_session_id ||
            current.worktree_id !== session.worktree_id ||
            (current.workspacePath ?? latest.worktrees?.[current.worktree_id]?.path) !== cwd
          )
            return latest;
          let next = latest;
          for (const event of events) {
            if (event.type !== "subagent-update" || !["completed", "failed", "cancelled"].includes(event.agent?.status)) continue;
            const previous = unknown.find((agent) => agent.id === event.agent.id);
            if (!previous || current.subagents?.find((agent) => agent.id === previous.id) !== previous) continue;
            next = applyAgentEvent(next, this.runs, projectPath, chatId, event).state;
          }
          return next;
        },
        { chats: [sessionId] },
      );
      if (changed) this.broadcast(projectPath, state);
    })().finally(() => this.subagentRecoveries.delete(chatId));
    this.subagentRecoveries.set(chatId, pending);
    return pending;
  }

  receive(chatId, event) {
    if (this.quitting && event.type === "turn-cancelled") event = { ...event, quit: true };
    return this.fold(chatId, event).then(
      (folded) => this.settle(chatId, folded),
      (error) => {
        console.warn(`Milagre couldn't record an agent event for ${chatId}:`, error.message);
        this.publish(chatId, event);
      },
    );
  }

  async afterTurn(chatId, event) {
    if (this.quitting || event.quit) return void this.sendNext.delete(chatId);
    const projectPath = projectOfKey(chatId);
    const state = await this.states.get(projectPath);
    const session = state.sessions[sessionIdFromKey(chatId)];
    if (this.runs[chatId] || this.preparing.has(chatId) || this.startingTurns.has(chatId)) return;
    const next = this.sendNext.get(chatId);
    this.sendNext.delete(chatId);
    const queued = session?.queued ?? [];
    if (
      event.type === "turn-completed" &&
      !next &&
      !session?.archived &&
      session?.provider === "claude" &&
      session.native_session_id &&
      !session.queueHeld &&
      !queued.some((item) => item.context?.kind === "compaction")
    ) {
      const last = state.messages.findLast((item) => item.session_id === session.id && item.role === "user");
      const settings = this.contextSettings();
      if (last?.context?.kind !== "compaction" && shouldAutoCompact(settings, session.contextUsage)) {
        const message = compactionMessage(session.contextUsage);
        const sent = await this.send({
          ...this.turnSettings(chatId),
          projectPath,
          sessionId: session.id,
          worktreeId: session.worktree_id,
          provider: "claude",
          model: lastUserModel(state, session.id),
          ...message,
          context: { ...message.context, automatic: true, quiet: true, threshold: settings.autoThreshold },
        }).catch((error) => {
          if (error.autoCompactDeferred) return null;
          throw error;
        });
        if (sent) {
          void sent.started.catch(() => {});
          return;
        }
      }
    }
    if (!queued.length) return;
    const start = (id) =>
      this.startQueued(chatId, id).catch(async (error) => {
        await this.holdQueue(chatId);
        throw error;
      });
    if (next && queued.some((item) => item.id === next)) return void (await start(next));
    if (session.queueHeld) return;
    if (event.type === "turn-completed") return void (await start(queued[0].id));
    await this.holdQueue(chatId);
  }

  async holdQueue(chatId) {
    const projectPath = projectOfKey(chatId);
    const sessionId = sessionIdFromKey(chatId);
    const { state, changed } = await this.states.update(
      projectPath,
      (latest) => {
        const current = latest.sessions[sessionId];
        return current?.queued?.length && !current.queueHeld
          ? { ...latest, sessions: { ...latest.sessions, [sessionId]: { ...current, queueHeld: true } } }
          : latest;
      },
      { chats: [] },
    );
    if (changed) this.broadcast(projectPath, state);
  }

  async startQueued(chatId, id, token, steer = false) {
    const projectPath = projectOfKey(chatId);
    const sessionId = sessionIdFromKey(chatId);
    if (!steer && (this.runs[chatId] || this.preparing.has(chatId) || this.startingTurns.has(chatId))) return false;
    const entry = (await this.states.get(projectPath)).sessions[sessionId]?.queued?.find((item) => item.id === id);
    if (!entry) return false;
    const { body, images, files = [], context, turn, prompt, clientMessageId, operationId } = entry;
    let sent;
    try {
      sent = await this.send({
        ...turn,
        provider: entry.provider,
        model: entry.model,
        projectPath,
        sessionId,
        body,
        images: await queuedImages(images),
        files,
        context: context ?? undefined,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(clientMessageId ? { clientMessageId } : {}),
        ...(operationId ? { operationId } : {}),
        fromQueue: id,
        steerQueued: steer,
        ...(token ? { canStart: token.valid, queueReleaseToken: true, queueReleaseEntry: entry } : {}),
      });
    } catch (error) {
      if (token && !token.valid()) {
        if (this.limitResumeReasons.get(chatId) !== "send") await this.holdQueue(chatId);
        return false;
      }
      if (error.queueBusy) return false;
      throw error;
    }
    const waiter = this.queueWaiters.get(id);
    this.queueWaiters.delete(id);
    if (waiter) void sent.started.then(waiter, () => waiter(null));
    else this.onQueuedStart(chatId, entry, sent.started);
    return true;
  }

  async sendQueuedNow(chatId, id, { ifPresent = false } = {}) {
    const state = await this.states.get(projectOfKey(chatId));
    const session = state.sessions[sessionIdFromKey(chatId)];
    if (!session?.queued?.some((item) => item.id === id)) {
      if (ifPresent) return { interrupt: false };
      throw new Error("That queued message was already sent or removed.");
    }
    const entry = session.queued.find((item) => item.id === id);
    if (entry.context?.kind !== "compaction" && this.canSteerQueued(chatId, session, state)) {
      if (await this.startQueued(chatId, id, undefined, true)) return { interrupt: false };
    }
    if (this.runs[chatId] || this.preparing.has(chatId) || this.startingTurns.has(chatId)) {
      this.sendNext.set(chatId, id);
      return { interrupt: true };
    }
    await this.startQueued(chatId, id);
    return { interrupt: false };
  }

  canSteerQueued(chatId, session, state) {
    return Boolean(
      this.runs[chatId] &&
      !this.preparing.has(chatId) &&
      !this.startingTurns.has(chatId) &&
      !this.wakeTurns.has(chatId) &&
      providerCapabilities(session.provider).steer &&
      state.messages.findLast((item) => item.session_id === session.id && item.role === "user")?.context?.kind !== "compaction",
    );
  }

  async removeQueued(chatId, id) {
    const projectPath = projectOfKey(chatId);
    const sessionId = sessionIdFromKey(chatId);
    let removed = null;
    const { state, changed } = await this.states.update(
      projectPath,
      (latest) => {
        const session = latest.sessions[sessionId];
        removed = session?.queued?.find((item) => item.id === id) ?? null;
        if (!removed) return latest;
        return { ...latest, sessions: { ...latest.sessions, [sessionId]: withoutQueued(session, id) } };
      },
      { chats: [] },
    );
    if (!changed) return false;
    await this.states.flush(projectPath);
    this.broadcast(projectPath, state);
    if (this.sendNext.get(chatId) === id) this.sendNext.delete(chatId);
    const waiter = this.queueWaiters.get(id);
    this.queueWaiters.delete(id);
    if (waiter) waiter({ turnId: null, steered: false, cancelled: true, removed: true });
    else this.onQueuedRemoved(chatId, removed);
    return true;
  }

  async updatePlan(chatId, change) {
    const folded = await this.fold(chatId, undefined, (session) => {
      if (!session) throw new Error("This Chat no longer exists.");
      return { type: "plan-updated", plan: change(session.plan) };
    });
    await this.settle(chatId, folded);
    return folded.event.plan;
  }

  fold(chatId, event, resolve) {
    const projectPath = projectOfKey(chatId);
    const sessionId = sessionIdFromKey(chatId);
    let seq;
    let added = [];
    return this.states
      .update(
        projectPath,
        (state) => {
          if (resolve) event = resolve(state.sessions[sessionId]);
          if (event.type === "step-started") {
            const startedAt = this.runs[chatId]?.steps.find((step) => step.id === event.step.id)?.startedAt ?? this.now();
            const command =
              ["shell", "setup"].includes(event.step.kind) && event.step.detail?.startsWith("$ ") && event.step.detail.endsWith("\n")
                ? event.step.detail.slice(2, -1)
                : undefined;
            const input = command && command.length <= 4000 ? command : event.step.input;
            event = { ...event, step: { ...event.step, ...(input ? { input } : {}), startedAt } };
          }
          if (event.type === "step-completed") {
            const step = this.runs[chatId]?.steps.find((item) => item.id === event.id);
            if (step) {
              const endedAt = this.now();
              const durationMs = event.durationMs ?? (step.startedAt == null ? undefined : Math.max(0, endedAt - step.startedAt));
              const facts = summarizeStep({ ...step, ...event });
              event = { ...event, ...facts, endedAt, ...(durationMs === undefined ? {} : { durationMs }) };
            }
          }
          const last = state.messages.findLast((item) => item.session_id === sessionId && item.role === "user");
          if (isTurnEnd(event) && last?.context?.kind === "compaction" && last.context.quiet) event = { ...event, quiet: true };
          const result = applyAgentEvent(state, this.runs, projectPath, chatId, event);
          this.runs = result.runs;
          seq = ++this.seq;
          if (!result.changed) return state;
          const visible = this.isChatFocused ? this.isChatFocused(chatId) : chatId === this.openChat && this.isFocused();
          const unread = isTurnEnd(event) && !event.quiet && !visible && !result.state.sessions[sessionId]?.archived;
          if (unread && result.state.sessions[sessionId]?.unread !== true) Object.defineProperty(event, "markedUnread", { value: true, configurable: true });
          const next = unread ? patchSession(result.state, sessionId, { unread: true }) : result.state;
          let recorded = isTurnEnd(event) ? this.withNotes(archiveFinishedSubagents(next, sessionId, { keepAdvisors: true }), chatId) : next;
          const turn = this.turns.get(chatId);
          if (result.changed && event.type === "turn-failed" && event.limit?.accountId && turn) {
            const session = recorded.sessions[sessionId];
            const source = next.messages.findLast((message) => message.session_id === sessionId);
            const { prompt, ...options } = turn;
            if (source?.context?.kind === "limit")
              recorded = withLimitFields(recorded, sessionId, {
                limitTurn: {
                  provider: event.limit.provider,
                  accountId: event.limit.accountId,
                  at: event.limit.resetsAt,
                  sourceMessageId: source.id,
                  inputMessageId: next.messages.findLast((message) => message.session_id === sessionId && message.role === "user")?.id,
                  stoppedAt: this.now(),
                  automatic: true,
                  turn: { ...options, ...(session.native_session_id ? {} : { prompt }) },
                },
              });
          }
          const previousIds = new Set(state.messages.map((message) => message.id));
          added = recorded.messages.filter((message) => !previousIds.has(message.id) && message.role === "assistant");
          return recorded;
        },
        { persist: event?.type !== "subagent-update", chats: [sessionId] },
      )
      .then(({ state, changed }) => ({ state, changed, event, seq, added }));
  }

  async settle(chatId, { state, changed, event, seq, added }) {
    const sessionId = sessionIdFromKey(chatId);
    if (isTurnEnd(event)) this.wakeTurns.delete(chatId);
    this.publish(
      chatId,
      event.type === "subagent-update" && changed
        ? { ...event, agent: state.sessions[sessionId].subagents.find((agent) => agent.id === event.agent.id) }
        : event,
      changed && event.type !== "subagent-update" ? state : undefined,
      seq,
    );
    if (isTurnEnd(event)) void this.afterTurn(chatId, event).catch((error) => console.warn(`Milagre couldn't start the queue of ${chatId}:`, error.message));
    await this.captureImages(projectOfKey(chatId), state, added);
  }

  async captureImages(projectPath, state, messages) {
    if (!messages.length) return;
    const kept = new Map(state.messages.map((message) => [message.id, message]));
    for (const message of messages.map((made) => kept.get(made.id) ?? made)) {
      const captured = await this.images.capture(projectPath, state, message);
      if (captured === message) continue;
      const saved = await this.states
        .update(
          projectPath,
          (latest) => {
            const current = latest.messages.find((item) => item.id === message.id);
            if (current !== message) return latest;
            return { ...latest, messages: latest.messages.map((item) => (item === message ? captured : item)) };
          },
          { chats: [message.session_id] },
        )
        .catch(() => null);
      if (saved?.changed) this.broadcast(projectPath, saved.state);
    }
  }

  async recordAnswers(chatId, body, { requestId, answers, images } = {}) {
    const projectPath = projectOfKey(chatId);
    let messageId = null;
    let seq;
    let added = [];
    const { state, changed } = await this.states.update(
      projectPath,
      (latest) => {
        const request = this.runs[chatId]?.questions.find((item) => item.requestId === requestId);
        const result = recordAnswers(latest, this.runs, projectPath, chatId, body, answeredQuestions(request, answers), images);
        if (result.messageId === null) return latest;
        added = result.state.messages.slice(latest.messages.length).filter((message) => message.role === "assistant");
        this.runs = result.runs;
        messageId = result.messageId;
        seq = ++this.seq;
        return result.state;
      },
      { chats: [sessionIdFromKey(chatId)] },
    );
    if (!changed || messageId === null) return null;
    this.publish(chatId, { type: "answers-sent" }, state, seq);
    void this.states.flush(projectPath).catch((error) => console.warn("Milagre couldn't save the answers:", error.message));
    await this.captureImages(projectPath, state, added);
    return messageId;
  }

  async storeAnswerImages(chatId, images) {
    const projectPath = projectOfKey(chatId);
    const directory = this.states.storageDirectory?.(projectPath) ?? projectPath;
    const stored = {};
    for (const [id, list] of Object.entries(images)) stored[id] = await storeImages(directory, list);
    return stored;
  }

  async takeBack(chatId, messageId) {
    const projectPath = projectOfKey(chatId);
    const { state, changed } = await this.states.update(
      projectPath,
      (latest) =>
        latest.messages.some((message) => message.id === messageId)
          ? { ...latest, messages: latest.messages.filter((message) => message.id !== messageId) }
          : latest,
      { chats: [sessionIdFromKey(chatId)] },
    );
    if (changed) this.broadcast(projectPath, state);
  }

  async plan(chatId) {
    const state = await this.states.get(projectOfKey(chatId));
    return state.sessions[sessionIdFromKey(chatId)]?.plan;
  }

  async addNote(chatId, { body, context }) {
    this.notes.set(chatId, [...(this.notes.get(chatId) ?? []), { body, context }]);
    if (this.runs[chatId]) return;
    const { state, changed } = await this.states.update(
      projectOfKey(chatId),
      (latest) => {
        if (!latest.sessions[sessionIdFromKey(chatId)]) {
          this.notes.delete(chatId);
          throw new Error("That Chat no longer exists, so the note was not saved.");
        }
        return this.runs[chatId] ? latest : this.withNotes(latest, chatId);
      },
      { chats: [sessionIdFromKey(chatId)] },
    );
    if (changed) this.broadcast(projectOfKey(chatId), state);
  }

  async postNow(chatId, { body, context }, change = (session) => session) {
    const projectPath = projectOfKey(chatId);
    const sessionId = sessionIdFromKey(chatId);
    let seq;
    let live = false;
    const { state, changed } = await this.states.update(
      projectPath,
      (latest) => {
        if (!latest.sessions[sessionId]) return latest;
        const split = splitRunForSteer(latest, this.runs, projectPath, chatId);
        const run = split.runs[chatId];
        const message = { id: split.state.next_id, session_id: sessionId, body, context, role: "assistant", ...(run ? { model: run.model } : {}) };
        live = Boolean(run);
        if (run) {
          this.runs = { ...split.runs, [chatId]: { ...run, split: true } };
          seq = ++this.seq;
        }
        return {
          ...split.state,
          next_id: message.id + 1,
          sessions: { ...split.state.sessions, [sessionId]: change(split.state.sessions[sessionId]) },
          messages: [...split.state.messages, message],
        };
      },
      { chats: [sessionId] },
    );
    if (!changed) return false;
    if (live) this.publish(chatId, { type: "answers-sent" }, state, seq);
    else this.broadcast(projectPath, state);
    return true;
  }

  withNotes(state, chatId) {
    const notes = this.notes.get(chatId);
    const sessionId = sessionIdFromKey(chatId);
    this.notes.delete(chatId);
    if (!notes || !state.sessions[sessionId]) return state;
    const messages = notes.map((note, index) => ({
      id: state.next_id + index,
      session_id: sessionId,
      body: note.body,
      context: note.context,
      role: "assistant",
    }));
    return { ...state, next_id: state.next_id + messages.length, messages: [...state.messages, ...messages] };
  }

  async sendStatus(projectPath, clientMessageId) {
    const key = JSON.stringify([projectPath, clientMessageId]);
    for (;;) {
      while (this.pendingSends.has(key)) await Promise.allSettled(this.pendingSends.get(key));
      const message = await this.states.findMessage(projectPath, "clientMessageId", clientMessageId);
      const state = message ? null : await this.states.get(projectPath);
      if (this.pendingSends.has(key)) continue;
      if (message) return { sessionId: message.session_id };
      const queued = Object.values(state.sessions).find((session) => session.queued?.some((entry) => entry.clientMessageId === clientMessageId));
      return queued ? { sessionId: queued.id } : null;
    }
  }

  async send(request) {
    const key = JSON.stringify([request.projectPath, request.clientMessageId]);
    const pending = this.pendingSends.get(key) ?? new Set();
    const turn = this.sendMessage(request);
    pending.add(turn);
    this.pendingSends.set(key, pending);
    try {
      return await turn;
    } finally {
      pending.delete(turn);
      if (!pending.size) this.pendingSends.delete(key);
    }
  }

  async sendMessage(request) {
    if (request.delivery !== undefined && !["queue", "now"].includes(request.delivery)) throw new Error("Invalid message delivery.");
    await this.beforeSend(request);
    if (request.canStart && !request.canStart()) throw new Error("Advisor delivery is deferred.");
    const { projectPath, body, images = [], files = [], model } = request;
    const clientMessageId = typeof request.clientMessageId === "string" && request.clientMessageId ? request.clientMessageId : null;
    if (clientMessageId) {
      const earlier = await this.states.findMessage(projectPath, "clientMessageId", clientMessageId);
      if (earlier) return duplicateSend(earlier);
    }
    const compaction = request.context?.kind === "compaction";
    let provider = request.provider;
    const execution = this.states.executionContext && request.sessionId != null ? await this.states.executionContext(projectPath, request.sessionId) : null;
    const storedImages = await storeImages(this.states.storageDirectory?.(projectPath) ?? projectPath, images);
    let target = null;
    let brief;
    let handoff = null;
    let dividerId = null;
    let catchUp = null;
    let handoffFrom;
    let runProvider = provider;
    let runModel = model;
    let preparation = null;
    let waitFor = null;
    let newTask = false;
    let pendingId;
    let originalSession;
    let stagedSession;
    let queuedEntry = null;
    let duplicate = null;
    let recoveryToken;
    const saving = this.states.update(
      projectPath,
      (latest) => {
        if (request.canStart && !request.canStart()) throw new Error("Advisor delivery is deferred.");
        const twin = clientMessageId && latest.messages.find((item) => item.clientMessageId === clientMessageId);
        if (twin) {
          duplicate = twin;
          return latest;
        }
        const queuedTwin =
          clientMessageId && request.fromQueue === undefined
            ? Object.values(latest.sessions).find((item) => item.queued?.some((entry) => entry.clientMessageId === clientMessageId))
            : undefined;
        if (queuedTwin) {
          duplicate = { session_id: queuedTwin.id };
          return latest;
        }
        let session = request.sessionId == null ? undefined : latest.sessions[request.sessionId];
        if (request.sessionId != null && !session) throw new Error("That chat is no longer in the project.");
        if (request.limitResumeId) {
          const pending = session?.limitResume;
          if (
            !pending ||
            pending.sendId !== request.limitResumeId ||
            !this.limitTurnIdle(projectPath, session.id) ||
            !eligibleLimitTurn(latest, session, pending) ||
            this.now() > pending.expiresAt ||
            (request.canStart && !request.canStart())
          )
            throw Object.assign(new Error("This continuation was cancelled or superseded."), { limitResumeStale: true });
        }
        if (session?.formerWorktree) throw new Error(FORMER_WORKTREE);
        const worktree = session?.workspacePath ? { path: session.workspacePath } : latest.worktrees[session?.worktree_id ?? request.worktreeId];
        if (!worktree) throw new Error("That worktree is no longer in the project.");
        if (session?.readOnlyReason) throw new Error(session.readOnlyReason);
        this.assertWritable(projectPath, latest, session, worktree);
        if (worktree.sharedChat) throw new Error("This Worktree belongs to a shared Link Chat. Open its Link instead.");
        const started = session ? { state: latest, session } : starterChat(latest, worktree);
        session = started.session;
        const firstMessage = !latest.messages.some((message) => message.session_id === session.id);
        brief = firstMessage ? session.handoverDraft : undefined;
        const chatId = chatKey(projectPath, session.id);
        if (
          request.idleOnly &&
          (this.runs[chatId] || this.preparing.has(chatId) || this.startingTurns.has(chatId) || session.queued?.length || owesTurn(session))
        )
          throw Object.assign(new Error("The chat is busy."), { chatBusy: true });
        if (!request.limitResumeId && !request.limitSwitchToken && !request.queueReleaseToken) this.invalidateLimitResume(projectPath, session.id, "send");
        recoveryToken = this.limitResumeToken(projectPath, session.id);
        const withSession = started.state;
        if (compaction) {
          if (
            request.context.automatic &&
            (this.quitting ||
              this.isBusy(chatId) ||
              this.startingTurns.has(chatId) ||
              session.archived ||
              session.queueHeld ||
              session.provider !== "claude" ||
              !session.native_session_id ||
              latest.messages.findLast((item) => item.session_id === session.id && item.role === "user")?.context?.kind === "compaction" ||
              !shouldAutoCompact(this.contextSettings(), session.contextUsage))
          ) {
            throw Object.assign(new Error("Automatic compaction is no longer needed."), { autoCompactDeferred: true });
          }
          if (session.archived) throw new Error("Unarchive this Chat before compacting.");
          provider = compactionProvider(session);
          const existing = request.fromQueue === undefined && session.queued?.find((item) => item.context?.kind === "compaction");
          const activeCompact =
            request.fromQueue === undefined &&
            (this.runs[chatId] || this.startingTurns.has(chatId)) &&
            latest.messages.findLast((item) => item.session_id === session.id && item.role === "user")?.context?.kind === "compaction";
          if (existing || activeCompact) {
            duplicate = { session_id: session.id };
            return latest;
          }
          runProvider = provider;
          runModel = lastUserModel(withSession, session.id) || model;
        }
        waitFor = this.preparing.get(chatId) ?? null;
        const beforeQueue = session;
        if (request.fromQueue !== undefined) {
          if (!session.queued?.some((item) => item.id === request.fromQueue)) throw new Error("That queued message was already sent or removed.");
          if (
            (this.runs[chatId] || waitFor || this.startingTurns.has(chatId)) &&
            !(request.steerQueued && !compaction && this.canSteerQueued(chatId, session, latest))
          )
            throw Object.assign(new Error("The chat is busy."), { queueBusy: true });
          const { queueHeld: _held, ...rest } = withoutQueued(session, request.fromQueue);
          session = rest;
        }
        const runningProvider = this.runs[chatId] ? (session.provider ?? provider) : waitFor ? waitFor.to : this.startingTurns.get(chatId);
        const compacting =
          (this.runs[chatId] || this.startingTurns.has(chatId)) &&
          latest.messages.findLast((item) => item.session_id === session.id && item.role === "user")?.context?.kind === "compaction";
        if (
          runningProvider &&
          request.fromQueue === undefined &&
          (request.delivery === "queue" || compaction || compacting || this.wakeTurns.has(chatId) || !providerCapabilities(runningProvider).steer)
        ) {
          queuedEntry = {
            id: randomUUID(),
            body,
            ...(storedImages.length ? { images: storedImages } : {}),
            ...(files.length ? { files } : {}),
            ...(request.context ? { context: request.context } : {}),
            model,
            provider: runProvider,
            queuedAt: this.now(),
            ...(typeof request.clientMessageId === "string" ? { clientMessageId: request.clientMessageId } : {}),
            ...(request.operationId ? { operationId: request.operationId } : {}),
            ...(request.prompt !== undefined && request.prompt !== body ? { prompt: request.prompt } : {}),
            turn: {
              permissionMode: request.permissionMode,
              effort: request.effort,
              ultracode: request.ultracode,
              fastMode: request.fastMode,
              replies: request.replies,
              tldrEnabled: request.tldrEnabled,
            },
          };
          target = { chatId, sessionId: session.id };
          return { ...withSession, sessions: { ...withSession.sessions, [session.id]: { ...session, queued: [...(session.queued ?? []), queuedEntry] } } };
        }
        const steering = Boolean(this.runs[chatId]) || Boolean(waitFor);
        newTask = !steering;
        handoff = steering ? null : handoffKind(withSession, session.id, provider);
        const background = handoff === "switch" ? processWork(session).length : 0;
        if (background) throw new Error(backgroundBusyMessage("switch", background, providerName(provider)));
        if (steering) {
          runProvider = session.provider ?? provider;
          runModel = this.runs[chatId]?.model || lastUserModel(withSession, session.id) || model;
        }
        const next = withSession;
        originalSession = beforeQueue;
        if (handoff) dividerId = next.next_id;
        const message = {
          id: handoff ? next.next_id + 1 : next.next_id,
          session_id: session.id,
          body,
          images: storedImages,
          ...(files.length ? { files } : {}),
          ...(brief !== undefined ? { handoverBrief: brief } : {}),
          context: request.context ?? null,
          ...(request.operationId ? { operationId: request.operationId } : {}),
          role: "user",
          model: runModel,
        };
        pendingId = message.id;
        if (typeof request.clientMessageId === "string") message.clientMessageId = request.clientMessageId;
        if (compaction) {
          const usage = this.runs[chatId]?.contextUsage ?? session.contextUsage;
          message.context = { ...message.context, ...(usage && usage.size > 0 ? { before: usage.used, size: usage.size } : {}) };
        }
        stagedSession = {
          ...(compaction ? session : withoutDraft(session)),
          provider: runProvider,
          ...(PERMISSION_MODES.has(request.permissionMode) && !routineRunOf(request) ? { permissionMode: request.permissionMode } : {}),
          ...(firstMessage && body?.trim() && !session.title && !session.generatedTitle ? { titlePending: true } : {}),
        };
        if (handoff === "switch") {
          handoffFrom = lastTurnProvider(withSession, session.id);
          catchUp = catchUpStart(withSession, session.id, provider);
          stagedSession = applySwitch(stagedSession, handoffFrom, provider);
        } else if (handoff) {
          handoffFrom = provider;
        }
        target = { chatId, sessionId: session.id, cwd: worktree.path, resumeId: stagedSession.native_session_id };
        const fromModel = lastUserModel(withSession, session.id);
        const divider = handoff && {
          id: dividerId,
          session_id: session.id,
          body: "",
          role: "assistant",
          context: {
            kind: "handoff",
            from: { provider: handoffFrom, ...(fromModel ? { model: fromModel } : {}) },
            to: { provider, model },
            status: "preparing",
          },
        };
        if (handoff) {
          let settle;
          const done = new Promise((resolve) => (settle = resolve));
          preparation = { controller: new AbortController(), done, settle, dividerId, catchUp, from: handoffFrom, to: provider, sessionId: session.id };
          this.preparing.set(chatId, preparation);
        }
        if (!steering) this.startingTurns.set(chatId, runProvider);
        if (request.guard?.level === ESCALATION_LEVEL) this.wakeTurns.add(chatId);
        return {
          ...next,
          next_id: message.id + 1,
          sessions: { ...next.sessions, [session.id]: stagedSession },
          messages: [...next.messages, ...(divider ? [divider] : []), message],
        };
      },
      { chats: request.sessionId == null ? [] : [request.sessionId] },
    );
    await saving.catch((error) => {
      if (target) {
        this.doneStarting(target.chatId);
        if (request.guard?.level === ESCALATION_LEVEL) this.wakeTurns.delete(target.chatId);
      }
      throw error;
    });
    if (duplicate) return duplicateSend(duplicate);
    if (queuedEntry) {
      const saved = await this.queueSaved(projectPath, target, queuedEntry);
      if (request.delivery === "now" && !compaction) {
        const { interrupt } = await this.sendQueuedNow(target.chatId, queuedEntry.id, { ifPresent: true });
        if (interrupt) await this.interrupt(target.chatId);
      }
      return saved;
    }
    try {
      await this.states.flush(projectPath);
      if (newTask && !compaction) await this.beforeTask({ ...request, ...target, messageId: pendingId });
    } catch (error) {
      this.doneStarting(target.chatId);
      if (request.guard?.level === ESCALATION_LEVEL) this.wakeTurns.delete(target.chatId);
      if (preparation) {
        this.release(target.chatId, preparation);
        preparation.settle(null);
      }
      const { state } = await this.states.update(
        projectPath,
        (latest) => {
          const session = { ...latest.sessions[target.sessionId] };
          for (const field of [
            "provider",
            "titlePending",
            "handoverDraft",
            "resumeTurn",
            "limitResume",
            "limitTurn",
            "native_session_id",
            "native_sessions",
            "queued",
            "queueHeld",
          ]) {
            if (["limitResume", "limitTurn"].includes(field) && recoveryToken && !recoveryToken.valid()) continue;
            if (session[field] !== stagedSession[field]) continue;
            if (Object.hasOwn(originalSession, field)) session[field] = originalSession[field];
            else delete session[field];
          }
          return {
            ...latest,
            sessions: { ...latest.sessions, [target.sessionId]: session },
            messages: latest.messages.filter((message) => message.id !== pendingId && message.id !== dividerId),
          };
        },
        { chats: [target.sessionId] },
      );
      this.broadcast(projectPath, state);
      throw error;
    }
    let seq;
    let added = [];
    const { state } = await this.states
      .update(
        projectPath,
        (latest) => {
          const message = latest.messages.find((item) => item.id === pendingId);
          const divider = latest.messages.find((item) => item.id === dividerId);
          const withoutPending = { ...latest, messages: latest.messages.filter((item) => item.id !== pendingId && item.id !== dividerId) };
          const sent = applyAgentEvent(withoutPending, this.runs, projectPath, target.chatId, {
            type: "message-sent",
            model: runModel,
            permissionMode: request.permissionMode,
          });
          added = sent.state.messages.slice(withoutPending.messages.length).filter((message) => message.role === "assistant");
          this.runs = sent.runs;
          this.doneStarting(target.chatId);
          seq = ++this.seq;
          return { ...sent.state, messages: [...sent.state.messages, ...(divider ? [divider] : []), message] };
        },
        { chats: [target.sessionId] },
      )
      .catch((error) => {
        this.doneStarting(target.chatId);
        if (preparation) {
          this.release(target.chatId, preparation);
          preparation.settle(null);
        }
        throw error;
      });
    const routineRunId = routineRunOf(request)?.runId;
    this.publish(
      target.chatId,
      { type: "message-sent", model: runModel, permissionMode: request.permissionMode, ...(routineRunId ? { routineRunId } : {}) },
      state,
      seq,
    );
    if (state.sessions[target.sessionId].titlePending) void this.nameChat(projectPath, target.sessionId).catch(() => {});
    const babysit = routineRunOf(request)?.babysit;
    const guard = babysit ? { level: babysit.level, resolveThreads: babysit.resolveThreads === true } : request.guard;
    const turn = {
      provider: runProvider,
      model: runModel,
      permissionMode: request.permissionMode,
      effort: request.effort,
      ultracode: request.ultracode,
      fastMode: request.fastMode,
      replies: request.replies,
      tldrEnabled: request.tldrEnabled,
      ...(guard ? { guard } : {}),
      prompt: brief !== undefined ? withLead(framedBrief(brief), request.prompt || body) : request.prompt || body || "Describe the attached images.",
    };
    this.turns.set(target.chatId, turn);
    if (routineRunOf(request)) this.routineTurns.add(target.chatId);
    else this.routineTurns.delete(target.chatId);
    const ready = handoff
      ? this.prepareHandoff(projectPath, target, state, preparation)
      : waitFor
        ? waitFor.done.then(async (result) => {
            if (result !== null) return "";
            if (this.runs[target.chatId] && !this.preparing.has(target.chatId)) await this.receive(target.chatId, { type: "turn-cancelled" });
            return null;
          })
        : Promise.resolve("");
    const started = ready
      .then(async (handoffBrief) => {
        if (handoffBrief === null) return null;
        if (request.canStart && !request.canStart()) {
          if (request.limitResumeId || request.limitSwitchToken || request.queueReleaseToken)
            await this.cancelLimitStart(target.chatId, turn, pendingId, request.queueReleaseEntry);
          return null;
        }
        const prompt = withLead(framedBrief(handoffBrief), turn.prompt);
        const launchedTurn = { ...turn, prompt };
        this.turns.set(target.chatId, launchedTurn);
        const result = await this.startTurn({
          ...turn,
          prompt,
          ...execution,
          chatId: target.chatId,
          cwd: target.cwd,
          images,
          resumeId: target.resumeId,
          ...(request.limitResumeId || request.limitSwitchToken || request.queueReleaseToken
            ? { canStart: request.canStart, expectedAccountId: request.expectedAccountId }
            : {}),
        });
        if ((request.limitResumeId || request.limitSwitchToken || request.queueReleaseToken) && result?.cancelled)
          await this.cancelLimitStart(target.chatId, launchedTurn, pendingId, request.queueReleaseEntry);
        return result;
      })
      .catch((error) => {
        void this.receive(target.chatId, { type: "turn-failed", message: ipcErrorMessage(error) });
        return null;
      });
    if (preparation) void started.then((result) => preparation.settle(result));
    await this.captureImages(projectPath, state, added);
    return { sessionId: target.sessionId, started };
  }

  doneStarting(chatId) {
    this.startingTurns.delete(chatId);
  }

  async queueSaved(projectPath, target, entry) {
    try {
      await this.states.flush(projectPath);
    } catch (error) {
      const { state } = await this.states.update(
        projectPath,
        (latest) => {
          const session = latest.sessions[target.sessionId];
          return session ? { ...latest, sessions: { ...latest.sessions, [target.sessionId]: withoutQueued(session, entry.id) } } : latest;
        },
        { chats: [] },
      );
      this.broadcast(projectPath, state);
      throw error;
    }
    this.broadcast(projectPath, await this.states.get(projectPath));
    const started = new Promise((resolve) => this.queueWaiters.set(entry.id, resolve));
    if (!this.runs[target.chatId] && !this.startingTurns.has(target.chatId) && !this.preparing.has(target.chatId))
      void this.afterTurn(target.chatId, { type: "turn-completed" }).catch(() => {});
    return { sessionId: target.sessionId, started, queued: true };
  }

  async prepareHandoff(projectPath, target, state, preparation) {
    const { controller, dividerId, catchUp, from } = preparation;
    const aborted = new Promise((resolve) => controller.signal.addEventListener("abort", () => resolve(null), { once: true }));
    try {
      const session = state.sessions[target.sessionId];
      const before = {
        ...state,
        sessions: { ...state.sessions, [target.sessionId]: { ...session, provider: from } },
        messages: state.messages.filter((item) => item.id < dividerId),
      };
      const transcriptPath = await this.handoverTools.writeTranscript({
        projectPath,
        sessionId: target.sessionId,
        markdown: renderTranscript(before, target.sessionId),
      });
      const lastUserMessage = before.messages.findLast((item) => item.session_id === target.sessionId && item.role === "user" && item.body?.trim())?.body ?? "";
      const handoffBrief = await Promise.race([
        aborted,
        this.handoverTools.brief({
          projectPath,
          transcript: renderTranscript(before, target.sessionId, { after: catchUp ?? undefined }),
          transcriptPath,
          provider: from,
          catchUp: catchUp != null,
          signal: controller.signal,
          lastUserMessage,
          worktrees: session.worktrees,
          cwd: target.cwd,
        }),
      ]);
      if (handoffBrief === null || controller.signal.aborted) return null;
      await this.updateDivider(projectPath, dividerId, { status: "done", brief: handoffBrief, transcriptPath }, target.sessionId);
      if (controller.signal.aborted) {
        await this.abandonHandoff(projectPath, preparation, { aborted: true }).catch(() => {});
        return null;
      }
      return handoffBrief;
    } catch (error) {
      if (!controller.signal.aborted) await this.abandonHandoff(projectPath, preparation).catch(() => {});
      throw error;
    } finally {
      this.release(target.chatId, preparation);
    }
  }

  release(chatId, preparation) {
    if (this.preparing.get(chatId) === preparation) {
      this.preparing.delete(chatId);
      this.onUnblocked(chatId);
    }
  }

  async abandonHandoff(projectPath, { dividerId, sessionId, from, to }, { aborted = false } = {}) {
    const { state, changed } = await this.states.update(
      projectPath,
      (latest) => {
        const divider = latest.messages.find((item) => item.id === dividerId);
        if (!isHandoff(divider) || !(divider.context.status === "preparing" || (aborted && divider.context.status === "done"))) return latest;
        return failHandoff(latest, divider, sessionId, from, to);
      },
      { chats: [sessionId] },
    );
    if (changed) this.broadcast(projectPath, state);
    const chatId = chatKey(projectPath, sessionId);
    const turn = this.turns.get(chatId);
    if (turn?.provider === to) {
      const fromModel = state.messages.find((item) => item.id === dividerId)?.context?.from?.model;
      this.turns.set(chatId, { ...turn, provider: from, ...(fromModel ? { model: fromModel } : {}) });
    }
  }

  async updateDivider(projectPath, dividerId, patch, sessionId) {
    const { state, changed } = await this.states.update(
      projectPath,
      (latest) => {
        const divider = latest.messages.find((item) => item.id === dividerId);
        if (!isHandoff(divider) || divider.context.status !== "preparing") return latest;
        return { ...latest, messages: latest.messages.map((item) => (item === divider ? { ...item, context: { ...item.context, ...patch } } : item)) };
      },
      { chats: sessionId == null ? undefined : [sessionId] },
    );
    if (changed) this.broadcast(projectPath, state);
  }

  async patchMessageContext(projectPath, sessionId, match, patch, session) {
    let found = false;
    const { state, changed } = await this.states.update(
      projectPath,
      (latest) => {
        const message = latest.messages.findLast((item) => item.session_id === sessionId && match(item));
        if (!message) return latest;
        found = true;
        const context = typeof patch === "function" ? patch(message.context) : { ...message.context, ...patch };
        const next = { ...latest, messages: latest.messages.map((item) => (item === message ? { ...item, context } : item)) };
        return session ? patchSession(next, sessionId, session) : next;
      },
      { chats: [sessionId] },
    );
    if (changed) this.broadcast(projectPath, state);
    return found;
  }

  async cancelHandoff(chatId) {
    const preparation = this.preparing.get(chatId);
    if (!preparation) return false;
    preparation.controller.abort();
    try {
      await this.abandonHandoff(projectOfKey(chatId), preparation);
      await this.receive(chatId, { type: "turn-cancelled" });
    } finally {
      this.release(chatId, preparation);
      preparation.settle(null);
    }
    void this.afterTurn(chatId, { type: "turn-cancelled" }).catch(() => {});
    return true;
  }

  async suspendRunning() {
    this.quitting = true;
    const stoppedAt = this.now();
    const abandoned = new Set();
    await Promise.all(
      [...this.preparing].map(async ([chatId, preparation]) => {
        abandoned.add(chatId);
        preparation.controller.abort();
        await this.abandonHandoff(projectOfKey(chatId), preparation).catch((error) =>
          console.warn(`Milagre couldn't cancel the handoff of ${chatId}:`, error.message),
        );
      }),
    );
    const byProject = new Map();
    for (const chatId of Object.keys(this.runs)) {
      const turn = this.turns.get(chatId);
      if (!turn || abandoned.has(chatId) || this.routineTurns.has(chatId) || this.wakeTurns.has(chatId)) continue;
      const openQuestions = this.runs[chatId].questions.flatMap((request) => request.questions.map((question) => question.question));
      byProject.set(projectOfKey(chatId), [...(byProject.get(projectOfKey(chatId)) ?? []), [sessionIdFromKey(chatId), { ...turn, openQuestions }]]);
    }
    await Promise.all(
      [...byProject].map(([projectPath, chats]) =>
        this.states
          .update(
            projectPath,
            (latest) => {
              let sessions = latest.sessions;
              for (const [sessionId, { prompt, openQuestions, ...turn }] of chats) {
                const session = sessions[sessionId];
                if (!session) continue;
                if (sessions === latest.sessions) sessions = { ...latest.sessions };
                sessions[sessionId] = {
                  ...session,
                  resumeTurn: { ...turn, stoppedAt, ...(session.native_session_id ? {} : { prompt }), ...(openQuestions.length ? { openQuestions } : {}) },
                };
              }
              return sessions === latest.sessions ? latest : { ...latest, sessions };
            },
            { chats: [] },
          )
          .catch((error) => console.warn(`Milagre couldn't save the running chats of ${projectPath}:`, error.message)),
      ),
    );
  }

  async resumeInterrupted(projectPath, state) {
    for (const session of Object.values(state.sessions)) {
      if (this.startsQueue(session)) {
        await this.startQueued(chatKey(projectPath, session.id), session.queued[0].id).catch((error) =>
          console.warn(`Milagre couldn't start the queue of a chat in ${projectPath}:`, error.message),
        );
        continue;
      }
      if (!this.willResume(session)) continue;
      await this.resumeChat(projectPath, session.id).catch((error) => console.warn(`Milagre couldn't resume a chat in ${projectPath}:`, error.message));
    }
  }

  willResume(session) {
    return Boolean(session?.resumeTurn) && this.now() - (session.resumeTurn.stoppedAt ?? 0) <= RESUME_WINDOW_MS;
  }

  startsQueue(session) {
    return Boolean(session && !session.resumeTurn && session.queued?.length && !session.queueHeld && !session.archived);
  }

  async resumeChat(projectPath, sessionId) {
    if (this.runs[chatKey(projectPath, sessionId)]) return false;
    await this.states.executionContext?.(projectPath, sessionId);
    let turn = null;
    const { state, changed } = await this.states.update(
      projectPath,
      (latest) => {
        const current = latest.sessions[sessionId];
        if (!current?.resumeTurn) return latest;
        const { resumeTurn, ...rest } = current;
        turn = resumeTurn;
        return { ...latest, sessions: { ...latest.sessions, [sessionId]: rest } };
      },
      { chats: [] },
    );
    if (!turn) return false;
    if (changed) this.broadcast(projectPath, state);
    const { prompt, stoppedAt: _stoppedAt, openQuestions, ...options } = turn;
    await this.send({ ...options, projectPath, sessionId, body: RESUME_BODY, prompt: prompt ?? resumePrompt(openQuestions), images: [], files: [] });
    return true;
  }

  invalidateLimitResume(projectPath, sessionId, reason = "cancel") {
    const key = chatKey(projectPath, sessionId);
    this.limitResumeGenerations.set(key, (this.limitResumeGenerations.get(key) ?? 0) + 1);
    this.limitResumeReasons.set(key, reason);
  }

  limitResumeToken(projectPath, sessionId) {
    const key = chatKey(projectPath, sessionId);
    const generation = this.limitResumeGenerations.get(key) ?? 0;
    this.limitResumeGenerations.set(key, generation);
    return { valid: () => !this.quitting && (this.limitResumeGenerations.get(key) ?? 0) === generation };
  }

  limitTurnIdle(projectPath, sessionId) {
    const key = chatKey(projectPath, sessionId);
    return !this.runs[key] && !this.startingTurns.has(key) && !this.preparing.has(key);
  }

  async cancelLimitResume(projectPath, sessionId, expectedSendId, reason = "cancel") {
    if (!expectedSendId) this.invalidateLimitResume(projectPath, sessionId, reason);
    const { state, changed } = await this.states.update(
      projectPath,
      (latest) => {
        const session = latest.sessions[sessionId];
        if (
          expectedSendId &&
          session?.limitResume?.sendId !== expectedSendId &&
          this.limitResumeFlights.get(chatKey(projectPath, sessionId))?.sendId !== expectedSendId
        )
          return latest;
        if (expectedSendId) this.invalidateLimitResume(projectPath, sessionId);
        if (!session || (!session.limitResume && (!session.limitTurn || session.limitTurn.automatic === false))) return latest;
        const { limitResume: _pending, ...rest } = session;
        return withLimitFields(latest, sessionId, {
          ...rest,
          limitResume: undefined,
          ...(session.limitTurn ? { limitTurn: { ...session.limitTurn, automatic: false } } : {}),
        });
      },
      { chats: [] },
    );
    if (changed) {
      await this.states.flush(projectPath);
      this.broadcast(projectPath, state);
    }
    return changed;
  }

  async scheduleLimitResume(projectPath, sessionId, { mode, accountId, token = this.limitResumeToken(projectPath, sessionId) }) {
    const { state, changed } = await this.states.update(
      projectPath,
      (latest) => {
        const session = latest.sessions[sessionId];
        const stopped = session?.limitTurn;
        const at = Date.parse(stopped?.at);
        if (
          !token.valid() ||
          (token.sourceMessageId !== undefined && stopped?.sourceMessageId !== token.sourceMessageId) ||
          !this.limitTurnIdle(projectPath, sessionId) ||
          !eligibleLimitTurn(latest, session, stopped) ||
          !Number.isFinite(at) ||
          at <= this.now() ||
          stopped.accountId !== accountId ||
          (mode === "automatic" && (!stopped.automatic || at - stopped.stoppedAt > DAY_MS))
        )
          return latest;
        if (session.limitResume) return latest;
        return withLimitFields(latest, sessionId, {
          limitResume: {
            ...stopped,
            mode,
            sendId: randomUUID(),
            expiresAt: at + RESET_ALLOWANCE_MS + DAY_MS,
          },
        });
      },
      { chats: [sessionId] },
    );
    if (changed) {
      await this.states.flush(projectPath);
      this.broadcast(projectPath, state);
    }
    return changed;
  }

  async runLimitResume(projectPath, sessionId, { accountId, token = this.limitResumeToken(projectPath, sessionId), sendId }) {
    const state = await this.states.load(projectPath, [sessionId]);
    const session = state.sessions[sessionId];
    const pending = session?.limitResume;
    if (!pending || pending.sendId !== sendId || !token.valid()) return false;
    if (!eligibleLimitTurn(state, session, pending)) {
      await this.cancelLimitResume(projectPath, sessionId, sendId);
      return false;
    }
    if (!this.limitTurnIdle(projectPath, sessionId)) return false;
    if (
      pending.accountId !== accountId ||
      this.now() > pending.expiresAt ||
      !Number.isFinite(Date.parse(pending.at)) ||
      (pending.mode === "automatic" && Date.parse(pending.at) - pending.stoppedAt > DAY_MS)
    ) {
      await this.cancelLimitResume(projectPath, sessionId);
      return false;
    }
    if (this.now() < Date.parse(pending.at) + RESET_ALLOWANCE_MS) return false;
    const canStart = () => token.valid();
    const key = chatKey(projectPath, sessionId);
    if (this.limitResumeFlights.has(key)) return false;
    const flight = { sendId };
    this.limitResumeFlights.set(key, flight);
    try {
      const input = session.native_session_id
        ? null
        : state.messages.findLast(
            (message) =>
              message.session_id === sessionId &&
              message.role === "user" &&
              (pending.inputMessageId == null
                ? message.id < pending.sourceMessageId && message.context?.kind !== "limit-reset"
                : message.id === pending.inputMessageId),
          );
      if (!session.native_session_id && !input) throw new Error("Cannot continue after the usage limit: the original message is unavailable.");
      const images = await queuedImages(input?.images);
      if (images.length !== (input?.images?.length ?? 0))
        throw new Error("Cannot continue after the usage limit: an original image is unavailable. Restore it or send the request again.");
      const sent = await this.send({
        ...pending.turn,
        projectPath,
        sessionId,
        body: limitResetText(),
        context: { kind: "limit-reset" },
        permissionMode: session.permissionMode ?? pending.turn.permissionMode,
        prompt: session.native_session_id ? RESET_PROMPT : (pending.turn.prompt ?? RESET_PROMPT),
        images,
        files: input?.files ?? [],
        clientMessageId: pending.sendId,
        limitResumeId: pending.sendId,
        expectedAccountId: pending.accountId,
        canStart,
      });
      void sent.started.finally(() => {
        if (this.limitResumeFlights.get(key) === flight) this.limitResumeFlights.delete(key);
      });
      return !sent.duplicate;
    } catch (error) {
      if (this.limitResumeFlights.get(key) === flight) this.limitResumeFlights.delete(key);
      if (error.limitResumeStale) await this.cancelLimitResume(projectPath, sessionId, sendId);
      if (error.limitResumeStale || !token.valid()) return false;
      throw error;
    }
  }

  async cancelLimitStart(chatId, turn, messageId, queueEntry) {
    const projectPath = projectOfKey(chatId);
    let event;
    const { state, changed } = await this.states.update(
      projectPath,
      (latest) => {
        if (this.turns.get(chatId) !== turn) return latest;
        const source = latest.messages.find((message) => message.id === messageId);
        if (!source || latest.messages.some((message) => message.session_id === source.session_id && message.id > source.id && message.role === "user"))
          return latest;
        event = { type: "turn-cancelled", limitResumeAborted: true, messageId };
        const { [chatId]: _run, ...runs } = this.runs;
        this.runs = runs;
        const session = latest.sessions[source.session_id];
        const restored =
          queueEntry && !session.queued?.some((entry) => entry.id === queueEntry.id)
            ? {
                ...latest,
                sessions: { ...latest.sessions, [source.session_id]: { ...session, queueHeld: true, queued: [queueEntry, ...(session.queued ?? [])] } },
              }
            : latest;
        return { ...restored, messages: latest.messages.filter((message) => message.id !== source.id) };
      },
      { chats: [sessionIdFromKey(chatId)] },
    );
    if (changed) {
      this.publish(chatId, event, state, ++this.seq);
      const queued = state.sessions[sessionIdFromKey(chatId)]?.queued?.[0];
      const session = state.sessions[sessionIdFromKey(chatId)];
      if (queued && !this.quitting && !session.archived && !session.queueHeld && this.limitResumeReasons.get(chatId) === "send")
        await this.startQueued(chatId, queued.id, this.limitResumeToken(projectPath, sessionIdFromKey(chatId)));
    }
  }

  async continueAfterLimit(projectPath, sessionId, provider, label, token) {
    const chatId = chatKey(projectPath, sessionId);
    const session = (await this.states.get(projectPath)).sessions[sessionId];
    const turn = this.turns.get(chatId) ?? session?.limitTurn?.turn;
    if (!session || !this.limitTurnIdle(projectPath, sessionId) || !turn || (token && !token.valid())) return false;
    const { prompt, ...options } = turn;
    const context = { kind: "account-switch", provider, label };
    await this.send({
      ...options,
      projectPath,
      sessionId,
      body: accountSwitchText(context),
      ...(token ? { canStart: token.valid, limitSwitchToken: true } : {}),
      context,
      prompt: session.native_session_id ? LIMIT_PROMPT : prompt,
      images: [],
      files: [],
    });
    return true;
  }

  async recoverHandoffs(projectPath, known) {
    const sessions = Object.values((known ?? (await this.states.get(projectPath))).sessions ?? {});
    const chats = sessions.filter((session) => !session.summary || session.summary.openHandoff !== undefined).map((session) => session.id);
    const { state, changed } = await this.states.update(
      projectPath,
      (latest) => {
        let sessions = latest.sessions;
        for (const session of Object.values(latest.sessions)) {
          if (!session.handoverPending) continue;
          const { handoverPending: _pending, ...rest } = session;
          if (sessions === latest.sessions) sessions = { ...latest.sessions };
          sessions[session.id] = rest;
        }
        let next = { ...latest, sessions };
        for (const item of latest.messages) {
          if (isHandoff(item) && item.context.status === "preparing" && !this.preparing.has(chatKey(projectPath, item.session_id))) {
            next = failHandoff(
              next,
              next.messages.find((message) => message.id === item.id),
              item.session_id,
              item.context.from.provider,
              item.context.to.provider,
            );
          }
        }
        const touched = next.sessions !== latest.sessions || next.messages.some((item, index) => item !== latest.messages[index]);
        return touched ? next : latest;
      },
      { chats },
    );
    if (changed) this.broadcast(projectPath, state);
  }
}

module.exports = { ChatHost };
