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

// A chat stopped longer ago than this waits for the user instead of continuing by itself.
const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;
// Host-owned metadata never goes through patchSession's deliberately restricted renderer fields.
function withLimitFields(state, sessionId, fields) {
  const session = state.sessions[sessionId];
  const next = { ...session };
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) delete next[name];
    else next[name] = value;
  }
  return { ...state, sessions: { ...state.sessions, [sessionId]: next } };
}
/** The answer to a send that was already saved: its Chat, and no turn to start. */
function duplicateSend(message) {
  return { sessionId: message.session_id, started: Promise.resolve(null), duplicate: true };
}

const RESUME_BODY = "Milagre restarted. Continue where you left off.";
const RESUME_PROMPT =
  "Milagre, the app running you, closed while you were working and has just opened again, so your last turn was cut off. Continue where you left off. Check what is already done before repeating any of it.";

const LIMIT_PROMPT =
  "Your last turn stopped because the account hit its plan's usage limit, and Milagre switched this chat to another account. Continue where you left off; if the last request has no answer yet, answer it now. Check what is already done before repeating any of it.";

// Saves every chat's turns, in whatever project, whether or not the window shows it. Agent events
// are folded into the chat's project state (see ProjectStates), and each one is published to the
// windows along with the state it changed, so a reply never shows twice or goes missing between
// its stream ending and its message appearing. A message is saved before its turn starts, and a
// message sent while the chat's turn runs splits the reply streamed so far above it, and a note added
// while it runs (what the commit dialog did) waits for the turn to end, so it lands after the reply. Every event
// folded into the runs is numbered, so a window that loads mid-turn takes the runs (see `snapshot`)
// and skips the events they already hold.
// A message the user sends replaces the brief waiting as a draft and any resume a quit left.
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

// A switch parks the native session of the provider left and resumes the one parked for the provider entered.
// `revertSwitch` is its inverse, for a handoff that did not happen.
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

// Only a provider with native /compact takes it, and only between turns: steered into a running turn it would be read as text.
function compactionProvider(session) {
  const provider = session.provider ?? "claude";
  if (!providerCapabilities(provider).compact) throw new Error("Only Claude chats can be compacted from here.");
  return provider;
}

// A handoff that did not happen: its divider fails and the session goes back to the provider it was on.
function failHandoff(latest, divider, sessionId, from, to) {
  const session = latest.sessions[sessionId];
  return {
    ...latest,
    sessions: session && from !== to && session.provider === to ? { ...latest.sessions, [sessionId]: revertSwitch(session, from, to) } : latest.sessions,
    messages: latest.messages.map((item) => (item === divider ? { ...item, context: { ...item.context, status: "failed" } } : item)),
  };
}

// The session without one queued message; the hold goes with the last one.
function withoutQueued(session, id) {
  const { queued = [], queueHeld: _held, ...rest } = session;
  const left = queued.filter((item) => item.id !== id);
  if (!left.length) return rest;
  return { ...rest, queued: left, ...(session.queueHeld ? { queueHeld: true } : {}) };
}

const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

// A queued message's images were stored when it was sent; its turn takes them as the data a send carries.
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

// Whether a Chat has messages, from its summary when it has one: an unloaded Chat's aren't in the state (message-store.cjs).
const hasMessages = (state, session) => (session.summary?.count ?? 0) > 0 || state.messages.some((message) => message.session_id === session.id);

// A new chat in a worktree takes its chat that has no messages yet, if there is one (not a handover still
// waiting for its brief or holding it as a draft, nor one a Routine's Run made); otherwise one is made. Resolves the state with it.
function starterChat(latest, worktree) {
  const existing = Object.values(latest.sessions).find(
    (item) => item.worktree_id === worktree.id && !item.handoverPending && item.handoverDraft === undefined && !item.routine && !hasMessages(latest, item),
  );
  if (existing) return { state: latest, session: existing };
  return newChat(latest, worktree);
}

// A new chat in a worktree, with no messages. Resolves the state with it.
function newChat(latest, worktree) {
  const session = { id: latest.next_id, worktree_id: worktree.id, agent_name: worktree.name, status: "Created" };
  return { state: { ...latest, next_id: latest.next_id + 1, sessions: { ...latest.sessions, [session.id]: session } }, session };
}

class ChatHost {
  /**
   * `startTurn(request)` starts or steers the agent's turn (see SessionManager.startTurn);
   * `publish(chatId, event, state, seq)` sends an event to the windows, with the project's state when the
   * event changed it, and its number when it was folded into the runs; `broadcast(projectPath, state)` tells
   * them of a change no agent event made. `isFocused()` says whether a Milagre
   * window has focus: a turn that ends in the open chat while it hasn't leaves the chat unread too.
   * `onQueuedStart(chatId, entry, started)` and `onQueuedRemoved(chatId, entry)` tell the runtime about a queued message
   * (AgentSession.queued) whose sender is gone because Milagre restarted since it was queued, such as a Delegation.
   */
  constructor({
    states,
    startTurn,
    publish,
    broadcast,
    isFocused = () => true,
    isChatFocused,
    nameChat = async () => {},
    readSubagents = async () => [],
    handoverTools,
    beforeSend = async () => {},
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
      publish,
      broadcast,
      isFocused,
      isChatFocused,
      nameChat,
      readSubagents,
      handoverTools,
      beforeSend,
      contextSettings,
      beforeTask,
      onUnblocked,
      onQueuedStart,
      onQueuedRemoved,
      now,
    });
    // Chats whose handoff is staged or its brief being written, by chat key: { controller, done, settle, ... }.
    // Stop and quit abort it (see cancelHandoff); a send meanwhile waits on `done` (see send).
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
    // The options of each chat's latest turn, so a turn a quit stops can start again the same way.
    this.turns = new Map();
    // Chats whose latest turn a Routine started (a beat, a Run's first message): the scheduler owns those, so a quit
    // saves no resume for them (see suspendRunning).
    this.routineTurns = new Set();
    this.quitting = false;
    // Chats whose message was saved and whose turn is about to start, by chat key: the provider it starts on. A message
    // sent meanwhile to one that can't steer queues behind it, as it would behind the running turn.
    this.startingTurns = new Map();
    // What took each queued message, by its id, for the caller that sent it (a Delegation follows its turn).
    this.queueWaiters = new Map();
    // A queued message Send now picked while a turn ran, by chat key: it starts once that turn's Stop lands.
    this.sendNext = new Map();
  }

  /** Whether a chat's turn runs, prepares or has work waiting on it: its messages stay in memory (see ProjectStates). */
  isBusy(chatId) {
    return Boolean(this.runs[chatId]) || this.preparing.has(chatId) || this.notes.has(chatId) || this.subagentRecoveries.has(chatId);
  }

  /** Every chat isBusy says is busy, plus those whose send is on its way to a turn: what a restart would cut short. */
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

  /** The turns streaming now, in every project, and the number of the last event they hold. */
  snapshot() {
    return { runs: this.runs, seq: this.seq };
  }

  /** The settings of the chat's latest turn this run (provider, model, permission mode…), or null. */
  turnSettings(chatId) {
    if (!this.turns.has(chatId)) return null;
    // A babysit Run's guard belongs to its own turn: a message sent on these settings is not that Run.
    const { prompt: _prompt, guard: _guard, ...settings } = this.turns.get(chatId);
    return settings;
  }

  /**
   * The composer's mode picker: `mode` is the chat's permission mode from now on, saved with it
   * (AgentSession.permissionMode) so it outlives a restart, for the turn a quit stops and for whatever Milagre sends into
   * the chat next (a heartbeat's beat), as it is for the user's next message. A chat that isn't there changes nothing.
   */
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

  /**
   * Makes `childKey` a subchat of `parentKey`: a Delegation inside one Project went from the parent to it (ADR-0002).
   * Saved as `parent` on the child once, the first time: a Chat that already has a parent keeps it. Never across
   * Projects, never on itself, and never when the parent already descends from the child, so the chain can't loop.
   * Resolves true when it saved.
   */
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

  /**
   * A mode change from the composer: `live(chatId, mode)` hands it to the running agent, and the chat saves it whatever
   * that says. When both fail, the agent's error is the one reported.
   */
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

  /**
   * A Chat a bot no longer runs: it leaves Bot rules for Ask, saved with it like the composer's pick, so the turns it
   * starts again (a resume, a continue after a limit, a heartbeat's beat, the messages queued behind its turn) ask the
   * user. A chat in another mode keeps it.
   */
  async leaveBotRules(chatId) {
    const asked = (settings) => (settings?.permissionMode === "bot" ? { ...settings, permissionMode: "ask" } : settings);
    const turn = this.turns.get(chatId);
    if (turn?.permissionMode === "bot") this.turns.set(chatId, asked(turn));
    const projectPath = projectOfKey(chatId);
    const sessionId = sessionIdFromKey(chatId);
    const { state, changed } = await this.states.update(
      projectPath,
      (latest) => {
        const session = latest.sessions[sessionId];
        const queued = session?.queued?.some((entry) => entry.turn?.permissionMode === "bot");
        if (
          !session ||
          (session.permissionMode !== "bot" &&
            session.resumeTurn?.permissionMode !== "bot" &&
            session.limitTurn?.turn?.permissionMode !== "bot" &&
            session.limitResume?.turn?.permissionMode !== "bot" &&
            !queued)
        )
          return latest;
        const left = {
          ...asked(session),
          ...(session.resumeTurn ? { resumeTurn: asked(session.resumeTurn) } : {}),
          ...(session.limitTurn ? { limitTurn: { ...session.limitTurn, turn: asked(session.limitTurn.turn) } } : {}),
          ...(session.limitResume ? { limitResume: { ...session.limitResume, turn: asked(session.limitResume.turn) } } : {}),
          ...(queued ? { queued: session.queued.map((entry) => (entry.turn ? { ...entry, turn: asked(entry.turn) } : entry)) } : {}),
        };
        return { ...latest, sessions: { ...latest.sessions, [sessionId]: left } };
      },
      { chats: [] },
    );
    if (changed) this.broadcast(projectPath, state);
  }

  /** Forgets what this run knows of a chat that was deleted. */
  forget(chatId) {
    this.invalidateLimitResume(projectOfKey(chatId), sessionIdFromKey(chatId));
    this.routineTurns.delete(chatId);
  }

  /**
   * A worktree's chat with no messages yet, made when it has none: where a message Milagre sends opens a new chat. Resolves
   * with its id. `fresh` always makes a new one. `origin` ({ routineId, runId }) marks it as a Routine's Run's, saved as
   * `routine` and hidden from the Chat lists until the user writes in it (`hidden`). `title` names it, and
   * `generatedTitle` gives it a name the user's own and the first message's naming leave alone, all in the same change.
   */
  async emptyChat(projectPath, worktreeId, { operationId, assertActive, origin, title, generatedTitle, fresh = false } = {}) {
    let sessionId;
    const { state, changed } = await this.states.update(
      projectPath,
      (latest) => {
        assertActive?.();
        const worktree = latest.worktrees[worktreeId];
        if (!worktree) throw new Error("That worktree is no longer in the project.");
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

  /**
   * Names a Run's Chat from what the Run did: saves `generatedTitle` while the Chat is still `runId`'s (its `routine`) and
   * has no title of its own, so a name the user gave it, or a Linear Run's issue title, always wins. Resolves true when
   * it saved.
   */
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
      // The name is on the session; the Chat's messages aren't read, so none are loaded.
      { chats: [] },
    );
    if (changed) this.broadcast(projectPath, state);
    return named;
  }

  /** The chat on screen, by chat key, or null. A turn that ends in any other chat leaves it unread. */
  setOpenChat(chatId) {
    this.openChat = typeof chatId === "string" ? chatId : null;
  }

  /** Recover saved unknown outcomes from provider history without starting a conversation turn. */
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
            // A new live event or an archive while history loads takes precedence over this snapshot.
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

  /** Folds one agent event into its chat's project, then publishes it. Events are published in the order they arrive. */
  receive(chatId, event) {
    // A turn the quit stops says so in its reply.
    if (this.quitting && event.type === "turn-cancelled") event = { ...event, quit: true };
    return this.fold(chatId, event).then(
      (folded) => this.settle(chatId, folded),
      (error) => {
        console.warn(`Milagre couldn't record an agent event for ${chatId}:`, error.message);
        this.publish(chatId, event);
      },
    );
  }

  /**
   * Once a turn ends, the chat's queue moves on: the message Send now picked starts first; otherwise a completed turn
   * starts the oldest queued message, one turn per message. Stop and failures hold the queue instead, since the user
   * may not want what they queued any more: it waits, each message with Send now and Remove. A quit leaves it as it is.
   */
  async afterTurn(chatId, event) {
    if (this.quitting || event.quit) return void this.sendNext.delete(chatId);
    const projectPath = projectOfKey(chatId);
    const state = await this.states.get(projectPath);
    const session = state.sessions[sessionIdFromKey(chatId)];
    // Another turn took the chat meanwhile: the queue moves on when that one ends, Send now's pick still first.
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
      // A failed/no-op compact cannot loop on unchanged usage. Only a later user turn may trigger another attempt.
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
    // A message that can't start (its save failed) stays queued, and the queue waits for Send now.
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

  /** Marks the chat's queue held, so it waits for Send now. */
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

  /**
   * Starts one queued message as the chat's next turn, through `send`, which takes it out of the queue in the same
   * save that adds it to the chat, so it runs once. Resolves false when it is gone or another turn took the chat first:
   * then it stays queued, and the end of that turn moves the queue on.
   */
  async startQueued(chatId, id, token) {
    const projectPath = projectOfKey(chatId);
    const sessionId = sessionIdFromKey(chatId);
    if (this.runs[chatId] || this.preparing.has(chatId) || this.startingTurns.has(chatId)) return false;
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
    // Queued before Milagre restarted, nobody waits on it here: the runtime tells its sender (a Delegation) it started.
    else this.onQueuedStart(chatId, entry, sent.started);
    return true;
  }

  /**
   * Send now on a queued message. With no turn running it starts at once, and the rest of the queue follows it. While a
   * turn runs, it is marked to start next and `{ interrupt: true }` asks the caller to stop that turn (see afterTurn).
   */
  async sendQueuedNow(chatId, id) {
    const session = (await this.states.get(projectOfKey(chatId))).sessions[sessionIdFromKey(chatId)];
    if (!session?.queued?.some((item) => item.id === id)) throw new Error("That queued message was already sent or removed.");
    if (this.runs[chatId] || this.preparing.has(chatId) || this.startingTurns.has(chatId)) {
      this.sendNext.set(chatId, id);
      return { interrupt: true };
    }
    await this.startQueued(chatId, id);
    return { interrupt: false };
  }

  /** Takes a message out of the chat's queue without sending it. Resolves false when it was already gone. */
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

  /**
   * Replaces the Chat's plan with what `change(currentPlan)` returns, which runs in the same queue as every other change
   * to its project, so nothing lands between the read and the write. Resolves with the saved plan. Rejects, and writes
   * nothing, when the Chat is gone, `change` throws (its message is the caller's to show) or the state can't be updated.
   */
  async updatePlan(chatId, change) {
    const folded = await this.fold(chatId, undefined, (session) => {
      if (!session) throw new Error("This Chat no longer exists.");
      return { type: "plan-updated", plan: change(session.plan) };
    });
    await this.settle(chatId, folded);
    return folded.event.plan;
  }

  /** Folds an event into the project's state. `resolve(session)` makes the event inside the queue, from the session as it is then. */
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
          // One host timestamp goes to live clients and reload snapshots alike. A title update for the same
          // running step keeps its original start, so its duration doesn't reset, including while it waits for approval.
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
          // A turn end that marks the chat unread says so to whoever hears it next (a quiet heartbeat takes back only
          // that mark). Not enumerable, so it never goes out with the event.
          if (unread && result.state.sessions[sessionId]?.unread !== true) Object.defineProperty(event, "markedUnread", { value: true, configurable: true });
          const next = unread ? patchSession(result.state, sessionId, { unread: true }) : result.state;
          // Subagents that ended during the turn are archived with it, so the track only lists what is still running.
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

  /** Publishes a folded event, then captures the images of the replies it saved. */
  async settle(chatId, { state, changed, event, seq, added }) {
    const sessionId = sessionIdFromKey(chatId);
    this.publish(
      chatId,
      event.type === "subagent-update" && changed
        ? { ...event, agent: state.sessions[sessionId].subagents.find((agent) => agent.id === event.agent.id) }
        : event,
      changed && event.type !== "subagent-update" ? state : undefined,
      seq,
    );
    // The end of a turn moves the chat's queue on, without holding up the event's caller.
    if (isTurnEnd(event)) void this.afterTurn(chatId, event).catch((error) => console.warn(`Milagre couldn't start the queue of ${chatId}:`, error.message));
    await this.captureImages(projectOfKey(chatId), state, added);
  }

  /** Capture newly saved replies after publication, outside the state mutation queue. */
  async captureImages(projectPath, state, messages) {
    if (!messages.length) return;
    // The state kept can hold slimmer copies of the messages a change made (see ProjectStates.compact): use those.
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

  /**
   * Shows the user's answers to a question as their message, after the reply streamed so far, and tells the windows
   * with an "answers-sent" event, before anything is written: the answers go to the agent at once, and the save follows
   * (a failed one stays dirty and is tried again). `answered` comes from the run's request, for the answer card.
   * Resolves with the message's id, or null when there's nothing to show. The change is queued when this is called, so
   * the answers can go to the agent at once: whatever it streams next is folded after them.
   */
  async recordAnswers(chatId, body, { requestId, answers } = {}) {
    const projectPath = projectOfKey(chatId);
    let messageId = null;
    let seq;
    let added = [];
    const { state, changed } = await this.states.update(
      projectPath,
      (latest) => {
        const request = this.runs[chatId]?.questions.find((item) => item.requestId === requestId);
        const result = recordAnswers(latest, this.runs, projectPath, chatId, body, answeredQuestions(request, answers));
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
    // No disk await between the current mutation and publication.
    this.publish(chatId, { type: "answers-sent" }, state, seq);
    void this.states.flush(projectPath).catch((error) => console.warn("Milagre couldn't save the answers:", error.message));
    await this.captureImages(projectPath, state, added);
    return messageId;
  }

  /** Removes a message again, such as answers that never reached the agent. */
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

  /** The Chat's task list and phase history, for Milagre's task tools. */
  async plan(chatId) {
    const state = await this.states.get(projectOfKey(chatId));
    return state.sessions[sessionIdFromKey(chatId)]?.plan;
  }

  /** Adds an assistant line that isn't a reply to a chat (`context` says what it is), after its running turn if it has one. */
  async addNote(chatId, { body, context }) {
    this.notes.set(chatId, [...(this.notes.get(chatId) ?? []), { body, context }]);
    if (this.runs[chatId]) return;
    const { state, changed } = await this.states.update(projectOfKey(chatId), (latest) => (this.runs[chatId] ? latest : this.withNotes(latest, chatId)), {
      chats: [sessionIdFromKey(chatId)],
    });
    if (changed) this.broadcast(projectOfKey(chatId), state);
  }

  /** The state with the chat's waiting notes added. */
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

  /**
   * Saves a message in its chat, a new one in the worktree when `sessionId` is null, then starts the
   * chat's turn, or steers the one running. Resolves with the chat's session id once the message is
   * saved, and with `started`: the turn starts in the background, and `started` resolves with what started it
   * ({ turnId, steered }), or null when it couldn't start (that fails in the chat).
   */
  async sendStatus(projectPath, clientMessageId) {
    const key = JSON.stringify([projectPath, clientMessageId]);
    // A staged message can still roll back if its flush fails. Only settled sends are receipts.
    for (;;) {
      while (this.pendingSends.has(key)) await Promise.allSettled(this.pendingSends.get(key));
      const message = await this.states.findMessage(projectPath, "clientMessageId", clientMessageId);
      const state = message ? null : await this.states.get(projectPath);
      // A send can start while the asynchronous reads above are in flight.
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
    await this.beforeSend(request);
    if (request.canStart && !request.canStart()) throw new Error("Advisor delivery is deferred.");
    const { projectPath, body, images = [], files = [], model } = request;
    // A resend whose first answer was lost carries the same clientMessageId: the message is already saved, so nothing runs twice.
    const clientMessageId = typeof request.clientMessageId === "string" && request.clientMessageId ? request.clientMessageId : null;
    if (clientMessageId) {
      const earlier = await this.states.findMessage(projectPath, "clientMessageId", clientMessageId);
      if (earlier) return duplicateSend(earlier);
    }
    // A /compact runs on the chat's own provider, whatever the picker says: it never hands off.
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
    // The provider and model this turn runs on: a message that steers a running turn keeps the chat's, whatever was asked for.
    let runProvider = provider;
    let runModel = model;
    let preparation = null;
    // A handoff still preparing when this message was sent: it steers into that turn once it starts.
    let waitFor = null;
    let newTask = false;
    let pendingId;
    let originalSession;
    let stagedSession;
    // A message for a running turn its provider can't steer waits in the chat's queue instead (see afterTurn).
    let queuedEntry = null;
    let duplicate = null;
    let recoveryToken;
    const saving = this.states.update(
      projectPath,
      (latest) => {
        if (request.canStart && !request.canStart()) throw new Error("Advisor delivery is deferred.");
        // A concurrent send with the same id may have saved it since the lookup above.
        const twin = clientMessageId && latest.messages.find((item) => item.clientMessageId === clientMessageId);
        if (twin) {
          duplicate = twin;
          return latest;
        }
        // A resend of a message still waiting in a queue: it runs once, when its turn comes.
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
        // A chat runs in its own worktree; a new one goes to the worktree asked for.
        const worktree = session?.workspacePath ? { path: session.workspacePath } : latest.worktrees[session?.worktree_id ?? request.worktreeId];
        if (!worktree) throw new Error("That worktree is no longer in the project.");
        if (worktree.sharedChat) throw new Error("This Worktree belongs to a shared Link Chat. Open its Link instead.");
        const started = session ? { state: latest, session } : starterChat(latest, worktree);
        session = started.session;
        const firstMessage = !latest.messages.some((message) => message.session_id === session.id);
        // A handed-over chat's first message carries its brief; the body is only what the user typed.
        brief = firstMessage ? session.handoverDraft : undefined;
        const chatId = chatKey(projectPath, session.id);
        if (!request.limitResumeId && !request.limitSwitchToken && !request.queueReleaseToken) this.invalidateLimitResume(projectPath, session.id, "send");
        recoveryToken = this.limitResumeToken(projectPath, session.id);
        const withSession = started.state;
        if (compaction) {
          // Check again inside the serialized state update: a user send or a settings change may have won the race.
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
        // A message that steers a running turn, or one whose handoff is still preparing, never hands off.
        waitFor = this.preparing.get(chatId) ?? null;
        const beforeQueue = session;
        if (request.fromQueue !== undefined) {
          // A queued message starts only once, and only into an idle chat; otherwise it stays queued. Sending one
          // releases a held queue: the rest follow it.
          if (!session.queued?.some((item) => item.id === request.fromQueue)) throw new Error("That queued message was already sent or removed.");
          if (this.runs[chatId] || waitFor || this.startingTurns.has(chatId)) throw Object.assign(new Error("The chat is busy."), { queueBusy: true });
          const { queueHeld: _held, ...rest } = withoutQueued(session, request.fromQueue);
          session = rest;
        }
        // The provider of the turn running or about to start: a handoff still preparing starts on its target.
        const runningProvider = this.runs[chatId] ? (session.provider ?? provider) : waitFor ? waitFor.to : this.startingTurns.get(chatId);
        // canStart gates acceptance above. Once accepted, programmatic messages have the same durable queue as user sends.
        const compacting =
          (this.runs[chatId] || this.startingTurns.has(chatId)) &&
          latest.messages.findLast((item) => item.session_id === session.id && item.role === "user")?.context?.kind === "compaction";
        if (runningProvider && request.fromQueue === undefined && (compaction || compacting || !providerCapabilities(runningProvider).steer)) {
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
        // A switch ends the agent process the Chat's background work runs in, so it waits for that work (T3 #16000).
        const background = handoff === "switch" ? processWork(session).length : 0;
        if (background) throw new Error(backgroundBusyMessage("switch", background, providerName(provider)));
        if (steering) {
          runProvider = session.provider ?? provider;
          runModel = this.runs[chatId]?.model || lastUserModel(withSession, session.id) || model;
        }
        // Persist the input before splitting or starting its run. Tokens keep flowing
        // while this save is pending; rejected input never changes a live run.
        const next = withSession;
        originalSession = beforeQueue;
        // `context` marks a message no person typed, such as a Delegation from another Chat.
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
        // The divider records the gauge as it stood: the composer's running numbers, else the ones saved with the chat.
        if (compaction) {
          const usage = this.runs[chatId]?.contextUsage ?? session.contextUsage;
          message.context = { ...message.context, ...(usage && usage.size > 0 ? { before: usage.used, size: usage.size } : {}) };
        }
        // Switching providers parks the old native session and resumes the one parked for the new provider, if any.
        stagedSession = {
          ...(compaction ? session : withoutDraft(session)),
          provider: runProvider,
          // The mode a person's message carries is the one its composer shows; a Routine's message isn't theirs.
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
        return {
          ...next,
          next_id: message.id + 1,
          sessions: { ...next.sessions, [session.id]: stagedSession },
          messages: [...next.messages, ...(divider ? [divider] : []), message],
        };
        // A new Chat goes to the Worktree's empty one, which has no messages to load.
      },
      { chats: request.sessionId == null ? [] : [request.sessionId] },
    );
    await saving.catch((error) => {
      // A message saved nowhere starts no turn: nothing may queue behind it.
      if (target) this.doneStarting(target.chatId);
      throw error;
    });
    if (duplicate) return duplicateSend(duplicate);
    if (queuedEntry) return this.queueSaved(projectPath, target, queuedEntry);
    try {
      await this.states.flush(projectPath);
      // A /compact changes no files, so it takes no checkpoint.
      if (newTask && !compaction) await this.beforeTask({ ...request, ...target, messageId: pendingId });
    } catch (error) {
      this.doneStarting(target.chatId);
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
          // The run holds the chat now: a message for it queues behind the run itself.
          this.doneStarting(target.chatId);
          seq = ++this.seq;
          return { ...sent.state, messages: [...sent.state.messages, ...(divider ? [divider] : []), message] };
        },
        { chats: [target.sessionId] },
      )
      .catch((error) => {
        this.doneStarting(target.chatId);
        // The handoff never prepares: nothing may wait on it.
        if (preparation) {
          this.release(target.chatId, preparation);
          preparation.settle(null);
        }
        throw error;
      });
    // A Routine's message names its Run, so the scheduler tells it from a user's message sent around the same time.
    const routineRunId = routineRunOf(request)?.runId;
    this.publish(
      target.chatId,
      { type: "message-sent", model: runModel, permissionMode: request.permissionMode, ...(routineRunId ? { routineRunId } : {}) },
      state,
      seq,
    );
    if (state.sessions[target.sessionId].titlePending) void this.nameChat(projectPath, target.sessionId).catch(() => {});
    // A babysit Run's level, enforced by the agent's session on each command (babysit-guard.cjs). A turn continued after
    // a usage limit (continueAfterLimit) brings the guard of the turn it continues.
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
    // A person's message steered into a Routine's turn makes it theirs too.
    // A Routine's message: a beat or a comment's divider, or a Linear Run's issue card carrying its Run.
    if (routineRunOf(request)) this.routineTurns.add(target.chatId);
    else this.routineTurns.delete(target.chatId);
    // A message sent while a handoff prepares waits for its turn to start, then steers it with its own prompt.
    const ready = handoff
      ? this.prepareHandoff(projectPath, target, state, preparation)
      : waitFor
        ? waitFor.done.then(async (result) => {
            if (result !== null) return "";
            // The handoff this message waited for never started its turn, and this message opened a run that nothing will end.
            if (this.runs[target.chatId] && !this.preparing.has(target.chatId)) await this.receive(target.chatId, { type: "turn-cancelled" });
            return null;
          })
        : Promise.resolve("");
    const started = ready
      .then(async (handoffBrief) => {
        // null: the handoff was cancelled or failed (see abandonHandoff), so no agent starts.
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

  /**
   * A message saved to the chat's queue: it is written to disk before the windows see it, and `started` resolves
   * with what took it once its turn starts (or cancelled, when it is removed; null when Milagre restarts first).
   */
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
    // The turn it waited on may have ended while it was saved.
    if (!this.runs[target.chatId] && !this.startingTurns.has(target.chatId) && !this.preparing.has(target.chatId))
      void this.afterTurn(target.chatId, { type: "turn-completed" }).catch(() => {});
    return { sessionId: target.sessionId, started, queued: true };
  }

  /**
   * Writes the transcript and the brief for a handoff, then marks its divider done. Resolves with the brief, or
   * null when Stop or a quit cancelled it (see abandonHandoff). A failure abandons the handoff too, then throws.
   */
  async prepareHandoff(projectPath, target, state, preparation) {
    const { controller, dividerId, catchUp, from } = preparation;
    const aborted = new Promise((resolve) => controller.signal.addEventListener("abort", () => resolve(null), { once: true }));
    try {
      // The transcript is the chat up to the divider, on the provider it came from: the message sent with it travels as the prompt.
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
      // An abort that landed while the divider was being marked done still cancels the handoff.
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

  /** Forgets a chat's preparation once it ended, unless a newer one took its place. */
  release(chatId, preparation) {
    if (this.preparing.get(chatId) === preparation) {
      this.preparing.delete(chatId);
      this.onUnblocked(chatId);
    }
  }

  /**
   * A handoff that did not happen (cancelled, failed or cut off by a quit): its divider fails and the chat goes back to
   * the provider and native sessions it had, so the next send redoes the handoff. `aborted` also accepts a divider
   * already marked done, for an abort that landed while that update was in flight.
   */
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
    // The turn stored for the chat still names the target provider: put it back, so a Delegation delivered next doesn't redo the switch.
    const chatId = chatKey(projectPath, sessionId);
    const turn = this.turns.get(chatId);
    if (turn?.provider === to) {
      const fromModel = state.messages.find((item) => item.id === dividerId)?.context?.from?.model;
      this.turns.set(chatId, { ...turn, provider: from, ...(fromModel ? { model: fromModel } : {}) });
    }
  }

  /** Merges `patch` into a handoff divider's context (in Chat `sessionId`, when known) and tells the windows. */
  async updateDivider(projectPath, dividerId, patch, sessionId) {
    const { state, changed } = await this.states.update(
      projectPath,
      (latest) => {
        const divider = latest.messages.find((item) => item.id === dividerId);
        // Only a divider still preparing changes: a cancelled one stays failed.
        if (!isHandoff(divider) || divider.context.status !== "preparing") return latest;
        return { ...latest, messages: latest.messages.map((item) => (item === divider ? { ...item, context: { ...item.context, ...patch } } : item)) };
      },
      { chats: sessionId == null ? undefined : [sessionId] },
    );
    if (changed) this.broadcast(projectPath, state);
  }

  /**
   * Merges `patch` into the context of the latest message in Chat `sessionId` that `match(message)` picks (a routine run's
   * divider once its reply is known) and tells the windows. `patch` is an object merged into the context, or a function
   * from the context to the new one (a Linear Run's card keeps its divider in `context.routine`). `session`, when given,
   * patches the Chat in the same change (a quiet beat takes back the unread mark its turn's end set). Resolves true when a
   * message matched.
   */
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

  /** Stop while a handoff brief is written: no agent session runs yet, so the turn is cancelled here. Resolves true when there was one. */
  async cancelHandoff(chatId) {
    const preparation = this.preparing.get(chatId);
    if (!preparation) return false;
    preparation.controller.abort();
    try {
      await this.abandonHandoff(projectOfKey(chatId), preparation);
      await this.receive(chatId, { type: "turn-cancelled" });
    } finally {
      // Nothing may wait on a preparation that was cancelled, whatever threw above.
      this.release(chatId, preparation);
      preparation.settle(null);
    }
    // The queue moves on now that nothing prepares: Send now's pick starts, anything else is held.
    void this.afterTurn(chatId, { type: "turn-cancelled" }).catch(() => {});
    return true;
  }

  /**
   * Before a quit stops the agents: every chat whose turn runs is saved with what it needs to start again
   * (`resumeTurn`), except a Routine's turn, and the cancelled turns that follow say the quit stopped them. A chat whose agent never
   * started keeps its prompt, since no session holds it yet. A handoff still preparing is abandoned instead: its
   * agent never started, so the chat goes back to its old provider and the user's resend redoes the handoff.
   */
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
      // A Routine's turn isn't resumed: the scheduler recovers its Run on the next start and runs the next slot itself.
      if (!turn || abandoned.has(chatId) || this.routineTurns.has(chatId)) continue;
      byProject.set(projectOfKey(chatId), [...(byProject.get(projectOfKey(chatId)) ?? []), [sessionIdFromKey(chatId), turn]]);
    }
    await Promise.all(
      [...byProject].map(([projectPath, chats]) =>
        this.states
          .update(
            projectPath,
            (latest) => {
              let sessions = latest.sessions;
              for (const [sessionId, { prompt, ...turn }] of chats) {
                const session = sessions[sessionId];
                if (!session) continue;
                if (sessions === latest.sessions) sessions = { ...latest.sessions };
                sessions[sessionId] = { ...session, resumeTurn: { ...turn, stoppedAt, ...(session.native_session_id ? {} : { prompt }) } };
              }
              return sessions === latest.sessions ? latest : { ...latest, sessions };
            },
            { chats: [] },
          )
          .catch((error) => console.warn(`Milagre couldn't save the running chats of ${projectPath}:`, error.message)),
      ),
    );
  }

  /**
   * Chats a quit stopped mid-turn (see `suspendRunning`) continue when their project opens. One stopped longer
   * than RESUME_WINDOW_MS ago keeps its mark instead, and waits for the user to continue it (see `resumeChat`).
   */
  async resumeInterrupted(projectPath, state) {
    for (const session of Object.values(state.sessions)) {
      // A queue whose turn had ended moves on; one behind a stopped turn waits for that turn to resume and finish.
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

  /** Whether the saved chat `session` has a turn a quit stopped that continues when its project opens. */
  willResume(session) {
    return Boolean(session?.resumeTurn) && this.now() - (session.resumeTurn.stoppedAt ?? 0) <= RESUME_WINDOW_MS;
  }

  /** Whether the saved chat `session` has queued messages that start when its project opens: its turn had ended. */
  startsQueue(session) {
    return Boolean(session && !session.resumeTurn && session.queued?.length && !session.queueHeld && !session.archived);
  }

  /** Continues one chat a quit stopped, on the turn's saved options. Resolves false when it has nothing to continue. */
  async resumeChat(projectPath, sessionId) {
    if (this.runs[chatKey(projectPath, sessionId)]) return false;
    await this.states.executionContext?.(projectPath, sessionId);
    let turn = null;
    // Taken from the latest state, so a chat resumes once.
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
    const { prompt, stoppedAt: _stoppedAt, ...options } = turn;
    await this.send({ ...options, projectPath, sessionId, body: RESUME_BODY, prompt: prompt ?? RESUME_PROMPT, images: [], files: [] });
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
      // Native conversations already own their inputs. A first turn instead needs its durable
      // user message, including attachments, even after the daemon and upload buffers are gone.
      // Older retries omitted attachments from reset dividers, so find the original user message.
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
      // Provider setup can wait for approval; other schedules and shutdown must keep progressing.
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

  /**
   * Continues a chat whose last turn the plan's usage limit stopped, after its Project moved to `provider`'s account
   * named `label`, on that turn's options. Its message shows as a line, not as something the user typed. Resolves false when nothing is known of the turn (Milagre restarted since) or
   * the chat runs again: the user sends their message again then.
   */
  async continueAfterLimit(projectPath, sessionId, provider, label, token) {
    const chatId = chatKey(projectPath, sessionId);
    const session = (await this.states.get(projectPath)).sessions[sessionId];
    const turn = this.turns.get(chatId) ?? session?.limitTurn?.turn;
    if (!session || !this.limitTurnIdle(projectPath, sessionId) || !turn || (token && !token.valid())) return false;
    const { prompt, ...options } = turn;
    // A session holds the message the limit stopped; one that never started gets the message again.
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

  /** On open: a divider still preparing was cut off by a quit and is failed; a legacy handover still pending is settled. */
  async recoverHandoffs(projectPath, known) {
    // Only Chats whose summary has a divider preparing (or that have no summary) need their messages.
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
