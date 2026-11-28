const { active: activeSubagent } = require("./subagents.cjs");
const { withBrowserOwner } = require("../browser-owner.cjs");
const { isTerminal } = require("./events.cjs");
const { PERMISSION_MODES, USER_DECISIONS, WorkspaceAccess, turnMode } = require("./permissions.cjs");
const { validAnswers } = require("./questions.cjs");
const { capOutput } = require("./steps.cjs");
const { recordAntigravityModels } = require("./models.cjs");
const { backgroundBusyMessage } = require("@milagre/shared/chat-activity");
const { providerCapabilities } = require("@milagre/shared/provider-capabilities");
const { providerName } = require("@milagre/shared/providers");

const IDLE_MS = 10 * 60 * 1000;
const BATCH_MS = 50;

const busyWithoutTurn = (entry) => Boolean(entry.activeChildren?.size || entry.backgroundTasks?.size);
const backgroundCount = (entry) => (entry.backgroundChildren?.size ?? 0) + (entry.backgroundTasks?.size ?? 0);

function streamKey(event) {
  if (event.type === "text-delta") return `text:${event.messageId}`;
  if (event.type === "step-output") return `step:${event.id}`;
  return null;
}

// period, and are replaced when they crash or the chat changes provider or working directory.

const sameAmbientSecrets = (before, after) => (before?.MILAGRE_SECRETS_AMBIENT ?? null) === (after?.MILAGRE_SECRETS_AMBIENT ?? null);
class SessionManager {
  constructor({
    createSession,
    send,
    linkedFor = () => null,
    onSessionClosed = () => {},
    onTurnStarted = () => {},
    hostInstructions = () => "",
    idleMs = IDLE_MS,
    batchMs = BATCH_MS,
  }) {
    Object.assign(this, { createSession, send, linkedFor, onSessionClosed, onTurnStarted, hostInstructions, idleMs, batchMs });
    this.sessions = new Map();
    this.buffers = new Map();
    this.queues = new Map();
  }

  async startTurn(request) {
    const cancelled = () => request.canStart && !request.canStart();
    if (cancelled()) return { turnId: null, steered: false, cancelled: true };
    const start = async (entry) => {
      if (cancelled()) {
        this.scheduleIdleClose(request.chatId);
        return { turnId: null, steered: false, cancelled: true };
      }
      clearTimeout(entry.idleTimer);
      const result = await entry.session.startTurn({
        prompt: request.prompt,
        images: request.images,
        model: request.model,
        // the mode it had (an ACP agent left in Full's would run it without asking).
        permissionMode: turnMode(request.permissionMode),
        effort: request.effort,
        ultracode: request.ultracode,
        fastMode: request.fastMode,
        replies: request.replies,
        ...(request.canStart
          ? { canStart: () => request.canStart() && (request.expectedAccountId === undefined || entry.accountId === request.expectedAccountId) }
          : {}),
        ...(request.guard ? { guard: request.guard } : {}),
        ...(request.rewind?.[entry.provider] ? { rewind: request.rewind[entry.provider] } : {}),
      });
      if (result?.cancelled && !entry.session.turnActive) this.scheduleIdleClose(request.chatId);
      return result;
    };
    const entry = await this.serial(request.chatId, () => this.currentEntry(request));
    try {
      return await this.recordModels(entry, await start(entry));
    } catch (error) {
      if (!error.sessionClosed) throw error;
      const retry = await this.serial(request.chatId, () => this.currentEntry(request));
      return this.recordModels(retry, await start(retry));
    }
  }

  // What an Antigravity session offers is only known once it has started; the model picker lists it for its account.
  recordModels(entry, started) {
    if (entry.provider === "antigravity") recordAntigravityModels(entry.accountId, entry.session.models, entry.session.currentModel);
    return started;
  }

  async currentEntry(request) {
    const { chatId, provider, cwd } = request;
    // An edited message runs in a fresh process that resumes the rewound session, never in the one that saw the removed turns.
    if (request.rewind && this.sessions.has(chatId)) await this.closeEntry(chatId, this.sessions.get(chatId));
    const existing = this.sessions.get(chatId);
    const tldrEnabled = request.tldrEnabled !== false;
    const accountId = request.accountId ?? "default";
    const workspaceRoots = [...new Set(request.workspaceRoots ?? [])].sort();
    const sameChat =
      existing &&
      existing.provider === provider &&
      existing.cwd === cwd &&
      JSON.stringify(existing.workspaceRoots) === JSON.stringify(workspaceRoots) &&
      existing.workspaceInstructions === request.workspaceInstructions;
    const busy = existing && !existing.session.closed && (existing.session.turnActive || busyWithoutTurn(existing));
    const background = existing && !existing.session.closed ? backgroundCount(existing) : 0;
    if ((busy || background) && !sameAmbientSecrets(existing.env, request.env) && request.env?.MILAGRE_SECRETS_UNATTENDED)
      throw new Error("This Chat's agent is still running work that holds secrets this run may not use. It runs once that work ends.");
    if (
      sameChat &&
      !existing.session.closed &&
      ((existing.tldrEnabled === tldrEnabled && existing.accountId === accountId && sameAmbientSecrets(existing.env, request.env)) ||
        existing.session.turnActive ||
        busyWithoutTurn(existing))
    )
      return existing;
    if (background && existing.provider === provider && existing.cwd === cwd) return existing;
    if (background) throw new Error(backgroundBusyMessage(existing.provider === provider ? "move" : "switch", background, providerName(provider)));
    const resumeId = sameChat && !existing.session.closed ? (existing.session.nativeId ?? request.resumeId) : request.resumeId;
    if (existing) await this.closeEntry(chatId, existing);
    const entry = {
      provider,
      cwd,
      tldrEnabled,
      accountId,
      command: request.command,
      env: request.env,
      harness: request.harness,
      args: request.args,
      workspaceRoots,
      workspaceInstructions: request.workspaceInstructions,
      session: null,
      idleTimer: null,
    };
    entry.access = new WorkspaceAccess({ cwd, workspaceRoots: request.workspaceRoots, readOnlyRoots: request.readOnlyRoots });
    entry.session = this.createSession(provider, {
      cwd,
      workspaceRoots: request.workspaceRoots,
      access: entry.access,
      workspaceInstructions: [request.workspaceInstructions, this.hostInstructions()].filter(Boolean).join("\n\n") || undefined,
      ...(request.sharedLink ? { sharedLink: true } : {}),
      resumeId,
      tldrEnabled,
      accountId,
      command: request.command,
      env: withBrowserOwner(chatId, request.env),
      // An ACP agent's companion binary and launch arguments, from its resolved install (Antigravity only).
      ...(request.harness ? { harness: request.harness } : {}),
      ...(request.args ? { args: request.args } : {}),
      linked: this.linkedFor(chatId, { provider, accountId }),
      emit: (event) => this.forward(chatId, entry, event),
    });
    this.sessions.set(chatId, entry);
    return entry;
  }

  serial(chatId, fn) {
    const run = (this.queues.get(chatId) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.queues.set(chatId, run);
    return run;
  }

  forward(chatId, entry, event) {
    if (this.sessions.get(chatId) !== entry) return;
    const key = streamKey(event);
    if (key) {
      const buffer = this.buffers.get(chatId);
      if (buffer && (buffer.key !== key || event.startsMessage)) this.flush(chatId);
      let next = this.buffers.get(chatId);
      if (!next) {
        next = { key, event, text: "", timer: setTimeout(() => this.flush(chatId), this.batchMs) };
        next.timer.unref?.();
        this.buffers.set(chatId, next);
      }
      next.text = event.type === "step-output" ? capOutput(next.text + event.text) : next.text + event.text;
      return;
    }
    this.flush(chatId);
    if (event.type === "subagent-update") {
      entry.activeChildren ??= new Set();
      if (activeSubagent(event.agent)) {
        entry.activeChildren.add(event.agent.id);
        clearTimeout(entry.idleTimer);
      } else {
        entry.activeChildren.delete(event.agent.id);
        if (!entry.session.turnActive) this.scheduleIdleClose(chatId);
      }
      if (event.agent.background && providerCapabilities(entry.provider).backgroundSubagents) {
        entry.backgroundChildren ??= new Set();
        if (activeSubagent(event.agent)) entry.backgroundChildren.add(event.agent.id);
        else entry.backgroundChildren.delete(event.agent.id);
      }
    }
    if (event.type === "background-tasks" && providerCapabilities(entry.provider).backgroundSubagents) {
      entry.backgroundTasks = new Set((event.tasks ?? []).map((task) => task.id));
      if (entry.backgroundTasks.size) clearTimeout(entry.idleTimer);
      else if (!entry.session.turnActive) this.scheduleIdleClose(chatId);
    }
    if (event.type === "turn-started") entry.usageLimited = false;
    if (event.type === "turn-failed" && event.limit) entry.usageLimited = true;
    this.send(chatId, event.type === "turn-failed" && event.limit ? { ...event, limit: { ...event.limit, accountId: entry.accountId } } : event);
    if (event.type === "turn-started") {
      clearTimeout(entry.idleTimer);
      this.onTurnStarted(chatId);
    }
    if (isTerminal(event)) this.scheduleIdleClose(chatId);
  }

  flush(chatId) {
    const buffer = this.buffers.get(chatId);
    if (!buffer) return;
    clearTimeout(buffer.timer);
    this.buffers.delete(chatId);
    if (buffer.text) this.send(chatId, { ...buffer.event, text: buffer.text });
  }

  scheduleIdleClose(chatId) {
    const entry = this.sessions.get(chatId);
    if (!entry) return;
    clearTimeout(entry.idleTimer);
    if (busyWithoutTurn(entry)) return;
    entry.idleTimer = setTimeout(() => {
      void this.serial(chatId, () => (this.sessions.get(chatId) === entry ? this.closeEntry(chatId, entry) : undefined)).catch(() => {});
    }, this.idleMs);
    entry.idleTimer.unref?.();
  }

  updateWorkspace(chatId, { workspaceRoots = [], readOnlyRoots = [], workspaceInstructions }) {
    const entry = this.sessions.get(chatId);
    if (!entry) return;
    entry.workspaceRoots = [...new Set(workspaceRoots)].sort();
    entry.workspaceInstructions = workspaceInstructions;
    entry.access.own(workspaceRoots, readOnlyRoots);
  }

  async interrupt(chatId) {
    await this.sessions.get(chatId)?.session.interrupt();
  }

  respondToPermission(chatId, requestId, decision) {
    if (!USER_DECISIONS.has(decision)) throw new Error(`Unknown permission decision: ${decision}`);
    return this.sessions.get(chatId)?.session.respondToPermission(requestId, decision) ?? false;
  }

  answerQuestion(chatId, requestId, answers) {
    if (!validAnswers(answers)) throw new Error("Invalid answers to an agent question.");
    return this.sessions.get(chatId)?.session.answerQuestion(requestId, answers) ?? false;
  }

  askApproval(chatId, request) {
    const permissions = this.sessions.get(chatId)?.session.permissions;
    return permissions ? new Promise((resolve) => permissions.add(request, resolve)) : Promise.resolve("cancelled");
  }

  escalationDenial(chatId, call) {
    return this.sessions.get(chatId)?.session.escalation?.denial(call) ?? null;
  }

  permissionMode(chatId, fallback = "ask") {
    return this.sessions.get(chatId)?.session.permissions?.mode ?? fallback;
  }

  activeAccount(chatId, provider) {
    const entry = this.sessions.get(chatId);
    if (!entry || (provider && entry.provider !== provider) || entry.session.closed || (!entry.session.turnActive && !busyWithoutTurn(entry))) return null;
    return { accountId: entry.accountId, command: entry.command, env: entry.env, harness: entry.harness, args: entry.args };
  }

  backgroundWork(chatId) {
    const entry = this.sessions.get(chatId);
    return entry && !entry.session.closed ? backgroundCount(entry) : 0;
  }

  stopsSubagents(chatId) {
    return this.sessions.get(chatId)?.session.stopsSubagents?.() === true;
  }

  canStopSubagent(chatId, id) {
    return this.sessions.get(chatId)?.session.canStopSubagent?.(id) === true;
  }

  async stopSubagent(chatId, id) {
    const session = this.sessions.get(chatId)?.session;
    if (!session || session.closed || typeof session.stopSubagent !== "function") throw new Error("Stopping this subagent is not available.");
    await session.stopSubagent(id);
  }

  async taskOutput(chatId, taskId) {
    const session = this.sessions.get(chatId)?.session;
    if (!session || session.closed || typeof session.taskOutput !== "function") throw new Error("That background task has ended.");
    return session.taskOutput(taskId);
  }

  isTurnActive(chatId) {
    return Boolean(this.sessions.get(chatId)?.session.turnActive);
  }

  async setPermissionMode(chatId, mode) {
    if (!PERMISSION_MODES.has(mode)) throw new Error(`Unknown permission mode: ${mode}`);
    await this.sessions.get(chatId)?.session.setPermissionMode(mode);
  }

  processes() {
    const result = new Map();
    for (const [chatId, entry] of this.sessions) if (entry.session.pid) result.set(chatId, { pid: entry.session.pid, cwd: entry.cwd });
    return result;
  }

  closeChat(chatId) {
    return this.serial(chatId, () => this.closeEntry(chatId, this.sessions.get(chatId)));
  }

  releaseLimited(chatId, provider, accountId, onReleased = () => {}) {
    return this.serial(chatId, async () => {
      const entry = this.sessions.get(chatId);
      if (!entry?.usageLimited || entry.session.turnActive || (entry.provider === provider && entry.accountId === accountId)) return false;
      await this.closeEntry(chatId, entry);
      await onReleased();
      return true;
    });
  }

  async closeEntry(chatId, entry) {
    if (!entry) return;
    clearTimeout(entry.idleTimer);
    await entry.session.close();
    clearTimeout(entry.idleTimer);
    if (this.sessions.get(chatId) !== entry) return;
    this.flush(chatId);
    this.sessions.delete(chatId);
    this.onSessionClosed(chatId);
  }

  async closeAll() {
    await Promise.all([...this.sessions.keys()].map((chatId) => this.closeChat(chatId)));
  }
}

module.exports = { SessionManager };
