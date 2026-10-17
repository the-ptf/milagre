const fs = require("node:fs/promises");
const path = require("node:path");
const { chatKey, lastUserModel, projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { backgroundWork, holdsAnnouncement } = require("@milagre/shared/chat-activity");
const { isLinkScopeKey } = require("@milagre/shared/chat-scopes");
const { PERMISSION_MODES } = require("../agents/permissions.cjs");
const { createRoutineStore } = require("./store.cjs");
const { createRoutineScheduler, linearPrompt, schedulePrompt } = require("./scheduler.cjs");
const { createRoutineTools } = require("./tools.cjs");
const { createLinearPoller } = require("./linear-poller.cjs");

const OFF = "Routines are off. Turn them on in Settings › Experimental.";
const TOOLS_OFF = "Routines are turned off in Settings › Experimental.";
const WEBHOOK_LATER = "Webhook Routines arrive in a later update.";
const UNLISTED = "Choose a Project Milagre lists.";
const NO_CHAT = "That Chat is no longer in its Project.";
// What the scheduler records when a Chat got busy as a Run's message was about to go (scheduler.cjs BUSY).
const BUSY = "chat was busy";
const busyError = () => Object.assign(new Error(BUSY), { busy: true });
// A mode saved on a Chat, or undefined when it isn't one Milagre knows (a stale or hand-edited value falls back).
const knownMode = (mode) => (PERMISSION_MODES.has(mode) ? mode : undefined);
// A hung git (a fetch, a setup step) fails the Run instead of holding its slot until the daemon restarts.
const START_TIMEOUT_MS = 2 * 60 * 1000;
// What a Chat a Routine started can't do: make Routines or start their Runs, so a Run never sets off another.
const WITHHELD = new Set(["heartbeat_create", "routine_create", "routine_run_now"]);

// `work`, or a rejection after `ms`. `late` gets what `work` resolves with when that comes after the timeout.
function withTimeout(work, ms, message, late) {
  let timer;
  let timedOut = false;
  const limit = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(message));
    }, ms);
    timer.unref?.();
  });
  work.then(
    (value) => {
      if (timedOut) late(value);
    },
    () => {},
  );
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/**
 * How a heartbeat's turn ended: the text after its last tool step in its last reply. A beat that reads "Let me check
 * CI." → a tool call → "(pass) CI green" ended with a pass, though the reply saved is the whole turn's text. The replies
 * are the ones saved after the Chat's latest routine-run divider (Milagre's own notes left out), as `delegationReply`
 * reads a Delegation's: the streamed run is folded away before the turn's end is published, so they are all there is.
 */
function routineReply(state, sessionId) {
  const messages = (state?.messages ?? []).filter((message) => message.session_id === sessionId);
  const start = messages.findLastIndex((message) => message.role === "user" && message.context?.kind === "routine-run");
  if (start === -1) return "";
  const last = messages
    .slice(start + 1)
    .findLast((message) => message.role === "assistant" && message.context == null && (message.body?.trim() || message.steps?.length));
  if (!last) return "";
  const body = last.body ?? "";
  // Step offsets index the saved body (see savedSteps); thinking isn't a tool step.
  const cut = Math.max(0, ...(last.steps ?? []).filter((step) => step.kind !== "thinking").map((step) => step.offset ?? 0));
  return body.slice(cut).trim();
}

/**
 * The scheduler's view of the Chats (see scheduler.cjs). `cachedState(scope)` is a scope's state in memory, undefined
 * when it isn't open; `openState(scope, sessionId)` opens it if needed and resolves with the Chat's messages loaded.
 * `worktrees` makes and removes a Run's Worktree (create, remove, removable, base, projectWorktree) and `archiveChat`
 * archives a Chat as the user would.
 */
function routineChats({ chats, cachedState, openState, isClosing, worktrees, archiveChat, now = Date.now, timeoutMs = START_TIMEOUT_MS }) {
  const session = (chatId) => cachedState(projectOfKey(chatId))?.sessions?.[sessionIdFromKey(chatId)];
  // What makes a Run's message wait, other than a turn starting: a turn running or preparing, an approval or a question,
  // a message waiting in the Chat's queue for the next turn, or background work whose result comes back to the Chat (a
  // turn's end isn't the end of its work then, see chat-activity.mjs). A command left running in the background, such
  // as a dev server, may never end, so it holds nothing back, as it holds back no announcement.
  function occupied(chatId) {
    const run = chats.runs[chatId];
    const target = session(chatId);
    return (
      chats.isBusy(chatId) ||
      Boolean(run?.approvals?.length || run?.questions?.length) ||
      Boolean(target?.queued?.length) ||
      backgroundWork(target).some(holdsAnnouncement)
    );
  }
  const busy = (chatId) => occupied(chatId) || Boolean(chats.startingTurns?.has(chatId));
  // The Worktree a Run's Chat goes in: a new one (a Linear issue's carries its branch name), or the Project folder.
  async function workspaceFor(routine, issue) {
    const { projectPath, workspace } = routine.target;
    if (workspace === "project") {
      const worktreeId = await worktrees.projectWorktree(projectPath);
      if (worktreeId === undefined) throw new Error("The Project folder is no longer in the Project.");
      return { worktreeId, createdWorktree: false };
    }
    const making = (async () => {
      const baseBranch = await worktrees.base(projectPath);
      const request = { projectPath, baseBranch, prompt: "", ...(issue ? { issueKey: issue.key, issueWorkspace: issue.workspace } : {}) };
      return worktrees.create(request);
    })();
    // A Worktree made after the Run gave up on it has no Chat to go with: it goes too.
    const { worktreeId } = await withTimeout(making, timeoutMs, "Making the Worktree took too long.", ({ worktreeId: late }) => {
      void dropWorktree(projectPath, late);
    });
    return { worktreeId, createdWorktree: true };
  }

  // Removes a Worktree a Run made, only when it holds nothing worth keeping. Never forced.
  async function dropWorktree(projectPath, worktreeId, chatId) {
    try {
      if (!(await worktrees.removable(projectPath, worktreeId))) return;
      await (chatId === undefined ? worktrees.remove(projectPath, worktreeId) : worktrees.remove(projectPath, worktreeId, chatId));
    } catch (error) {
      console.warn("[routines] couldn't remove a Run's Worktree", error);
    }
  }

  // The first message of a Run in a Chat of its own: the Routine's prompt with the trigger's values filled in.
  function firstMessage(routine, run, at) {
    const event = run.event;
    if (event?.kind === "webhook" || routine.trigger.kind === "webhook") throw new Error(WEBHOOK_LATER);
    if (event?.kind === "linear") return linearPrompt(routine.prompt, event.issue);
    return schedulePrompt(routine.prompt, at, routine.trigger.timezone);
  }

  /**
   * Makes a Run's Chat, marked with its Run and named after the Routine (or the issue), and words its first message. It
   * sends nothing. A Chat that can't be made takes the Worktree made for it back with it.
   */
  async function startChat({ routine, run }) {
    if (isClosing()) throw new Error("Milagre is closing.");
    const at = now();
    const issue = run.event?.kind === "linear" ? run.event.issue : null;
    const body = firstMessage(routine, run, at);
    const { projectPath } = routine.target;
    const { worktreeId, createdWorktree } = await workspaceFor(routine, issue);
    try {
      const sessionId = await chats.emptyChat(projectPath, worktreeId, {
        origin: { routineId: routine.id, runId: run.id },
        title: issue ? `${issue.key} ${issue.title}` : routine.name,
        // The Project folder's empty Chat may be one the user is about to type in.
        ...(createdWorktree ? {} : { fresh: true }),
      });
      const chatId = chatKey(projectPath, sessionId);
      const context = { kind: "routine-run", routineId: routine.id, runId: run.id, name: routine.name, at, label: `Routine · ${routine.name}` };
      // A Run records its Worktree's id as text (RoutineRun.worktreeId).
      return { chatId, worktreeId: String(worktreeId), createdWorktree, body, prompt: body, context };
    } catch (error) {
      // Nothing can fail once the Chat is made, so only the Worktree is left to take back.
      if (createdWorktree) await dropWorktree(projectPath, worktreeId);
      throw error;
    }
  }

  // Archives a Chat a Run started; with `removeWorktree`, its Worktree goes too when nothing in it is worth keeping.
  async function archive(chatId, { removeWorktree = false } = {}) {
    const projectPath = projectOfKey(chatId);
    const worktreeId = session(chatId)?.worktree_id;
    await archiveChat(chatId);
    if (removeWorktree && worktreeId !== undefined) await dropWorktree(projectPath, worktreeId, chatId);
  }

  return {
    // A Project not open yet is unknown, not gone: send opens it, and a Chat missing then fails its Run.
    exists: (chatId) => cachedState(projectOfKey(chatId)) === undefined || Boolean(session(chatId)),
    archived: (chatId) => session(chatId)?.archived === true,
    busy: (chatId) => busy(chatId),
    // A message goes in on the Chat's current settings, as the user's next message would: its latest turn's provider,
    // model and effort, and the permission mode its composer last set, saved on the Chat (AgentSession.permissionMode,
    // see ChatHost.notePermissionMode) so a restart keeps it. A Chat with no turn this run (a Run's new Chat, or after a
    // restart) takes its own provider and last model; what's still missing comes from `settings`, what the Routine said
    // when its Run was claimed (never what it says now, which an edit since may have changed).
    async send(chatId, { body, prompt, context, settings: claimed }) {
      if (isClosing()) throw new Error("Milagre is closing.");
      const projectPath = projectOfKey(chatId);
      const sessionId = sessionIdFromKey(chatId);
      const state = await openState(projectPath, sessionId);
      const target = state?.sessions?.[sessionId];
      if (!target) throw new Error("That Chat is no longer in its Project.");
      // Opening the Project can resume a turn a quit stopped, and the user may have sent meanwhile.
      if (busy(chatId)) throw busyError();
      const latest = chats.turnSettings(chatId);
      const settings = latest ?? {
        provider: target.provider ?? claimed?.provider ?? "claude",
        model: lastUserModel(state, sessionId) || claimed?.model,
      };
      let waited = false;
      let asks = 0;
      let sending;
      try {
        sending = await chats.send({
          ...settings,
          permissionMode: knownMode(target.permissionMode) ?? latest?.permissionMode ?? claimed?.permissionMode ?? "auto",
          body,
          prompt,
          context,
          images: [],
          files: [],
          projectPath,
          sessionId,
          worktreeId: target.worktree_id,
          // A send that carries canStart never waits in the Chat's queue (ChatHost.send). ChatHost asks before it saves
          // the message and again as it saves it, before the beat's own turn counts as starting: a turn that started or
          // began starting meanwhile (the user pressed Send while the beat was on its way) makes the beat wait instead
          // of steering into it or starting beside it. It asks once more just before the turn starts, when the beat's
          // own run already holds the Chat: from that third ask on, the beat goes ahead.
          canStart: () => {
            asks += 1;
            if (asks > 2 || !busy(chatId)) return true;
            waited = true;
            return false;
          },
        });
      } catch (error) {
        if (waited) throw busyError();
        throw error;
      }
      return { started: sending.started };
    },
    // Called on the turn's end, which is published after it was folded into the saved reply (ChatHost.receive).
    replyText: (chatId) => routineReply(cachedState(projectOfKey(chatId)), sessionIdFromKey(chatId)),
    startChat: (request) => startChat(request),
    archive: (chatId, options) => archive(chatId, options),
    // Linear comments reach their issue's Chat once polling does (Task B2).
    linkedChat: async () => null,
    // `session` patches the Chat in the same change (see ChatHost.patchMessageContext).
    async patchRunContext(chatId, runId, patch, session) {
      await chats.patchMessageContext(
        projectOfKey(chatId),
        sessionIdFromKey(chatId),
        (message) => message.role === "user" && message.context?.kind === "routine-run" && message.context.runId === runId,
        patch,
        session,
      );
    },
  };
}

/**
 * Where a Routine may run, checked the same way for the Routines form and the agent tools, on create and on change.
 * `projects()` lists the Projects Milagre has. A new Chat's folder must be one of them once its symlinks and `..` are
 * resolved, and is stored as Milagre lists it; a Heartbeat's Chat must be in one of them (not a Link's) and still there.
 * Resolves with the target to store.
 */
function routineTargets({ projects, openState }) {
  async function listedProject(input) {
    if (typeof input !== "string" || !path.isAbsolute(input) || input.includes("\0")) throw new Error(UNLISTED);
    const resolved = path.resolve(input);
    const real = await fs.realpath(resolved).catch(() => resolved);
    for (const project of await projects()) {
      if (project.path === real) return project.path;
      if ((await fs.realpath(project.path).catch(() => project.path)) === real) return project.path;
    }
    throw new Error(UNLISTED);
  }
  return async function checkTarget(target) {
    if (target?.kind === "new-chat") return { ...target, projectPath: await listedProject(target.projectPath) };
    if (target?.kind !== "chat") return target;
    if (typeof target.chatId !== "string" || !target.chatId.includes("#")) throw new Error("Choose a Chat.");
    const scope = projectOfKey(target.chatId);
    // Heartbeats in a Named Link's Chats are out of scope (the spec's non-goals).
    if (isLinkScopeKey(scope)) throw new Error(UNLISTED);
    const projectPath = await listedProject(scope);
    const sessionId = sessionIdFromKey(target.chatId);
    const session = (await openState(projectPath, sessionId))?.sessions?.[sessionId];
    if (!session || session.archived) throw new Error(NO_CHAT);
    return { kind: "chat", chatId: chatKey(projectPath, sessionId) };
  };
}

/**
 * Routines in the runtime: the store at `file`, the scheduler over the Chats, the agent tools and the `routines:*`
 * commands. Every write says `routines:changed`. `timers` ({ now, setInterval, clearInterval, setTimeout, clearTimeout }) is for tests.
 */
function createRoutines({
  file,
  chats,
  keepAwake,
  emit,
  cachedState,
  openState,
  isClosing = () => false,
  worktrees,
  archiveChat = async () => {},
  // The Mac's Linear connections and (Task C2) webhooks, read lazily: the runtime makes them after this.
  linear: getLinear = () => null,
  hooks: _hooks = () => null,
  // The Projects Milagre lists ([{ path }]): a Routine runs only in one of them.
  projects = async () => [],
  timers = {},
}) {
  const now = timers.now ?? Date.now;
  const store = createRoutineStore({ file, now });
  let poller = null;
  // Every change may add, remove or switch a Linear Routine, so the poller looks again (a cheap scan).
  const changed = () => {
    emit("routines:changed", { enabled: store.enabled() });
    poller?.sync();
  };
  const checkTarget = routineTargets({ projects, openState });
  const routineChatsView = routineChats({ chats, cachedState, openState, isClosing, worktrees, archiveChat, now });
  const scheduler = createRoutineScheduler({
    store,
    chats: routineChatsView,
    keepAwake,
    now,
    ...(timers.setInterval ? { setInterval: timers.setInterval } : {}),
    ...(timers.clearInterval ? { clearInterval: timers.clearInterval } : {}),
    onChange: changed,
  });
  // The Linear connections, or null when they aren't made yet (a getter read before the runtime declared them throws).
  const linearNow = () => {
    try {
      return getLinear() ?? null;
    } catch {
      return null;
    }
  };
  poller = createLinearPoller({
    linear: linearNow,
    store,
    scheduler,
    // Only an issue a Chat is linked to takes comments; the rest are dropped before they make a Run.
    linkedIssue: async (issue) => Boolean(await routineChatsView.linkedChat(issue)),
    onChange: changed,
    now,
    ...(timers.setTimeout ? { setTimeout: timers.setTimeout } : {}),
    ...(timers.clearTimeout ? { clearTimeout: timers.clearTimeout } : {}),
  });
  function linearWorkspaces() {
    const linear = linearNow();
    return linear?.enabled() ? linear.workspaces().map((item) => item.id) : [];
  }
  function chatSettings(chatId) {
    const latest = chats.turnSettings(chatId);
    const state = cachedState(projectOfKey(chatId));
    const session = state?.sessions?.[sessionIdFromKey(chatId)];
    if (!latest && !session) return null;
    return {
      provider: latest?.provider ?? session?.provider,
      model: latest?.model || (state ? lastUserModel(state, sessionIdFromKey(chatId)) : undefined) || undefined,
      permissionMode: knownMode(session?.permissionMode) ?? latest?.permissionMode,
    };
  }
  // Read from the state in memory, as chatSettings is: the Chat's session is there when its agent asks for tools.
  const startedByRoutine = (chatId) => Boolean(cachedState(projectOfKey(chatId))?.sessions?.[sessionIdFromKey(chatId)]?.routine);
  const tools = createRoutineTools({
    store,
    scheduler,
    checkTarget,
    chatSettings,
    defaultTimezone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    linearWorkspaces,
    now,
  });

  return {
    enabled: () => store.enabled(),
    // A session keeps the tools it was given, so each one checks the switch when it runs. An agent's write through a
    // tool says routines changed, like a command's. The definitions are new on each call. A Chat on a Named Link gets
    // none: heartbeats there are out of scope (see the spec's non-goals).
    definitions: (chatId) =>
      (isLinkScopeKey(projectOfKey(chatId)) ? [] : tools.definitions(chatId))
        .filter((tool) => !startedByRoutine(chatId) || !WITHHELD.has(tool.name))
        .map((tool) => {
          const { run } = tool;
          tool.run = async (input) => {
            if (!store.enabled()) throw new Error(TOOLS_OFF);
            try {
              return await run(input);
            } finally {
              if (!tool.readOnly) changed();
            }
          };
          return tool;
        }),
    /** Runs synchronously, before the event is broadcast, so a quiet turn's end carries `quiet` to every listener. */
    observe(chatId, event) {
      try {
        scheduler.observe(chatId, event);
      } catch (error) {
        console.warn("[routines] observe failed", error);
      }
    },
    chatArchived: (chatId) => scheduler.chatArchived(chatId),
    // Recovery runs once at start whatever the switch says; the timer and polling run only while it is on.
    start() {
      scheduler.recover();
      if (!store.enabled()) return;
      scheduler.start();
      poller.start();
    },
    stop() {
      scheduler.stop();
      poller.stop();
    },
    read: () => ({ enabled: store.enabled() }),
    async save(value) {
      const enabled = store.setEnabled(value === true);
      if (enabled) {
        scheduler.start();
        poller.start();
      } else {
        poller.stop();
        // Off: one tick turns the routines' keep-awake off now, and the timer stops until the switch is on again.
        await scheduler.tick();
        scheduler.stop();
      }
      changed();
      return { enabled };
    },
    // store.list gives copies, so each takes its Runs in place.
    list: () => ({ routines: store.list().map((routine) => Object.assign(routine, { runs: store.runs(routine.id) })) }),
    // A Routine from the Routines form: always the user's, whatever the input says.
    async create(input) {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("A Routine needs its settings.");
      if (input.trigger?.kind === "webhook") throw new Error(WEBHOOK_LATER);
      const target = await checkTarget(input.target);
      const routine = store.create({ ...input, target, createdBy: { kind: "user" } });
      changed();
      return routine;
    },
    async update(id, patch) {
      if (typeof id !== "string" || !id) throw new Error("Choose a routine.");
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("A routine change must be an object.");
      const routine = store.update(id, patch.target === undefined ? patch : { ...patch, target: await checkTarget(patch.target) });
      changed();
      return routine;
    },
    remove(id) {
      if (typeof id !== "string" || !id) throw new Error("Choose a routine.");
      const removed = store.remove(id);
      if (removed) changed();
      return { removed };
    },
    async runNow(id) {
      if (!store.enabled()) throw new Error(OFF);
      if (typeof id !== "string" || !id) throw new Error("Choose a routine.");
      return scheduler.runNow(id);
    },
  };
}

module.exports = { createRoutines, routineChats, routineReply, routineTargets };
