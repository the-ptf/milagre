const { active: activeSubagent } = require("./subagents.cjs");
const { isTerminal } = require("./events.cjs");
const { PERMISSION_MODES, USER_DECISIONS, WorkspaceAccess } = require("./permissions.cjs");
const { validAnswers } = require("./questions.cjs");
const { capOutput } = require("./steps.cjs");
const { recordAntigravityModels } = require("./models.cjs");
const { backgroundBusyMessage } = require("@milagre/shared/chat-activity");
const { providerCapabilities } = require("@milagre/shared/provider-capabilities");
const { providerName } = require("@milagre/shared/providers");

const IDLE_MS = 10 * 60 * 1000;
const BATCH_MS = 50;

// What still runs in a chat's agent process with no turn: children (subagents) and background tasks. It keeps the
// process open, and the background part of it (chat-activity.mjs) is what closing the process would stop.
const busyWithoutTurn = (entry) => Boolean(entry.activeChildren?.size || entry.backgroundTasks?.size);
const backgroundCount = (entry) => (entry.backgroundChildren?.size ?? 0) + (entry.backgroundTasks?.size ?? 0);

// Streamed events that are batched: reply text per turn, and command output per step.
function streamKey(event) {
  if (event.type === "text-delta") return `text:${event.messageId}`;
  if (event.type === "step-output") return `step:${event.id}`;
  return null;
}

// One agent session per chat. A chat id is the renderer's chat key, `${projectPath}#${sessionId}`.
// Sessions start on a chat's first turn, resume from the id the chat saved, close after a quiet
// period, and are replaced when they crash or the chat changes provider or working directory.
// Text deltas and command output are batched so fast streams don't flood IPC; a batch of output
// keeps only the end the renderer would keep. Replacing and closing a chat's
// session run one at a time per chat, and onSessionClosed(chatId) runs once a chat's session is gone. Events from a session that is no longer the chat's
// current one are dropped. A turn's session steers it when the chat sends again while it runs.
class SessionManager {
  constructor({
    createSession,
    send,
    linkedFor = () => null,
    permissionPolicy = () => undefined,
    onSessionClosed = () => {},
    onTurnStarted = () => {},
    // What a new session is told about this machine's network (events.cjs hostNetworkInstructions). Read as each session
    // starts and never compared: an address that changes later waits for the next session, it doesn't restart one.
    hostInstructions = () => "",
    idleMs = IDLE_MS,
    batchMs = BATCH_MS,
  }) {
    Object.assign(this, { createSession, send, linkedFor, permissionPolicy, onSessionClosed, onTurnStarted, hostInstructions, idleMs, batchMs });
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
        permissionMode: request.permissionMode,
        effort: request.effort,
        ultracode: request.ultracode,
        fastMode: request.fastMode,
        replies: request.replies,
        ...(request.canStart
          ? { canStart: () => request.canStart() && (request.expectedAccountId === undefined || entry.accountId === request.expectedAccountId) }
          : {}),
        ...(request.guard ? { guard: request.guard } : {}),
      });
      if (result?.cancelled && !entry.session.turnActive) this.scheduleIdleClose(request.chatId);
      return result;
    };
    const entry = await this.serial(request.chatId, () => this.currentEntry(request));
    try {
      return await this.recordModels(entry, await start(entry));
    } catch (error) {
      if (!error.sessionClosed) throw error;
      // The session closed under this message (Stop had to close it); retry once on a fresh one.
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
    // System instructions are fixed for a provider session. Resume it between turns when
    // the preference changes, preserving its native history and any running reply.
    if (
      sameChat &&
      !existing.session.closed &&
      ((existing.tldrEnabled === tldrEnabled && existing.accountId === accountId) || existing.session.turnActive || busyWithoutTurn(existing))
    )
      return existing;
    // Background work lives in the agent process: replacing it would stop that work (T3 #16000). The same provider in
    // the same folder keeps it, and new Links or instructions wait for the next process; another provider or folder can't.
    const background = existing && !existing.session.closed ? backgroundCount(existing) : 0;
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
      // A shared Link Chat's agent can't link or delegate, so its system prompt leaves those out (chat-scopes.cjs).
      ...(request.sharedLink ? { sharedLink: true } : {}),
      resumeId,
      tldrEnabled,
      accountId,
      command: request.command,
      ...(request.env ? { env: request.env } : {}),
      // An ACP agent's companion binary and launch arguments, from its resolved install (Antigravity only).
      ...(request.harness ? { harness: request.harness } : {}),
      ...(request.args ? { args: request.args } : {}),
      linked: this.linkedFor(chatId),
      // A bot's thread or a Chat a bot opened gets the bot's answers for Bot rules mode.
      permissionPolicy: this.permissionPolicy(chatId),
      emit: (event) => this.forward(chatId, entry, event),
    });
    this.sessions.set(chatId, entry);
    return entry;
  }

  // Runs fn once any earlier replace or close for the same chat has finished.
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
      // Reply boundaries must retain their metadata even when several messages arrive in one batch.
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
      // The ones that outlive their turn (chat-activity.mjs), for a provider that has them.
      if (event.agent.background && providerCapabilities(entry.provider).backgroundSubagents) {
        entry.backgroundChildren ??= new Set();
        if (activeSubagent(event.agent)) entry.backgroundChildren.add(event.agent.id);
        else entry.backgroundChildren.delete(event.agent.id);
      }
    }
    // The process's other background work (a command run in the background…) keeps it open too, as children do.
    if (event.type === "background-tasks" && providerCapabilities(entry.provider).backgroundSubagents) {
      entry.backgroundTasks = new Set((event.tasks ?? []).map((task) => task.id));
      if (entry.backgroundTasks.size) clearTimeout(entry.idleTimer);
      else if (!entry.session.turnActive) this.scheduleIdleClose(chatId);
    }
    if (event.type === "turn-started") entry.usageLimited = false;
    if (event.type === "turn-failed" && event.limit) entry.usageLimited = true;
    // A usage limit belongs to the account the session runs on, which only this manager knows.
    this.send(chatId, event.type === "turn-failed" && event.limit ? { ...event, limit: { ...event.limit, accountId: entry.accountId } } : event);
    // A turn the provider started itself (a steer that missed the end of the last one) isn't covered by
    // startTurn's clear; the timer armed by the previous turn's end must not close it mid-run.
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

  /**
   * A shared Link Chat's agent made a Worktree (link_worktree_create): its running session owns it at once and keeps its
   * system prompt, since the tool's reply told the agent the path. The entry takes the new roots and instructions, so the
   * next turn continues the same session instead of starting another.
   */
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

  // The renderer is untrusted input: only the user's three answers reach a session.
  respondToPermission(chatId, requestId, decision) {
    if (!USER_DECISIONS.has(decision)) throw new Error(`Unknown permission decision: ${decision}`);
    return this.sessions.get(chatId)?.session.respondToPermission(requestId, decision) ?? false;
  }

  // Answers come from the renderer too: only null or a few short strings per question id reach a session.
  answerQuestion(chatId, requestId, answers) {
    if (!validAnswers(answers)) throw new Error("Invalid answers to an agent question.");
    return this.sessions.get(chatId)?.session.answerQuestion(requestId, answers) ?? false;
  }

  // Milagre's own tools (a Delegation) ask through the chat's approval cards, which follow its permission
  // mode (Full answers at once). In Bot rules the user answers them: they are Milagre's, not the bot's to allow. A chat
  // without a session has nobody to ask.
  askApproval(chatId, request) {
    const permissions = this.sessions.get(chatId)?.session.permissions;
    return permissions ? new Promise((resolve) => permissions.add(request, resolve, { fromMilagre: true })) : Promise.resolve("cancelled");
  }

  /** The live session's mode, else `fallback`: a Chat with no agent process has none of its own yet. */
  permissionMode(chatId, fallback = "ask") {
    return this.sessions.get(chatId)?.session.permissions?.mode ?? fallback;
  }

  activeAccount(chatId, provider) {
    const entry = this.sessions.get(chatId);
    if (!entry || (provider && entry.provider !== provider) || entry.session.closed || (!entry.session.turnActive && !busyWithoutTurn(entry))) return null;
    return { accountId: entry.accountId, command: entry.command, env: entry.env, harness: entry.harness, args: entry.args };
  }

  hasSession(chatId) {
    return this.sessions.has(chatId);
  }

  /** How much background work (subagents and tasks) still runs in the chat's agent process; closing it would stop it. */
  backgroundWork(chatId) {
    const entry = this.sessions.get(chatId);
    return entry && !entry.session.closed ? backgroundCount(entry) : 0;
  }

  /** The end of a background task's output, read from the chat's live agent process: the task dies with it. */
  async taskOutput(chatId, taskId) {
    const session = this.sessions.get(chatId)?.session;
    if (!session || session.closed || typeof session.taskOutput !== "function") throw new Error("That background task has ended.");
    return session.taskOutput(taskId);
  }

  isTurnActive(chatId) {
    return Boolean(this.sessions.get(chatId)?.session.turnActive);
  }

  // A mode switch reaches the chat's session at once, so a running turn stops asking for what it allows.
  async setPermissionMode(chatId, mode) {
    if (!PERMISSION_MODES.has(mode)) throw new Error(`Unknown permission mode: ${mode}`);
    await this.sessions.get(chatId)?.session.setPermissionMode(mode);
  }

  /** Each open chat's agent process and working directory, { pid, cwd } by chat id, for chats whose agent has started. */
  processes() {
    const result = new Map();
    for (const [chatId, entry] of this.sessions) if (entry.session.pid) result.set(chatId, { pid: entry.session.pid, cwd: entry.cwd });
    return result;
  }

  closeChat(chatId) {
    return this.serial(chatId, () => this.closeEntry(chatId, this.sessions.get(chatId)));
  }

  /** A limited account cannot finish its background work. A switch may stop it and resume the saved Chat elsewhere. */
  releaseLimited(chatId, provider, accountId, onReleased = () => {}) {
    return this.serial(chatId, async () => {
      const entry = this.sessions.get(chatId);
      if (!entry?.usageLimited || entry.session.turnActive || (entry.provider === provider && entry.accountId === accountId)) return false;
      await this.closeEntry(chatId, entry);
      // Publish the stopped work before a concurrent send can start another process for this Chat.
      await onReleased();
      return true;
    });
  }

  // The session stays current while it closes, so its own final event (a cancelled turn)
  // still reaches the renderer; then any batched text is sent and the chat forgets it.
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
