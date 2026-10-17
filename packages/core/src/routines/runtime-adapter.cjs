const fs = require("node:fs/promises");
const path = require("node:path");
const { chatKey, lastUserModel, projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { backgroundWork, holdsAnnouncement } = require("@milagre/shared/chat-activity");
const { isLinkScopeKey } = require("@milagre/shared/chat-scopes");
const { routineIssueContext } = require("@milagre/shared/linear-issue");
const { routineRunOf } = require("@milagre/shared/routines");
const { PERMISSION_MODES } = require("../agents/permissions.cjs");
const { createRoutineStore } = require("./store.cjs");
const { createRoutineScheduler, linearPrompt, schedulePrompt } = require("./scheduler.cjs");
const { createRoutineTools } = require("./tools.cjs");
const { createLinearPoller } = require("./linear-poller.cjs");
const { DEFAULT_SIGNING_HEADER, hookIdOf, newHookSecret, hookUrl, verifySignature, webhookPrompt } = require("./webhook.cjs");

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
// What a webhook Routine shows while the relay keeps its URL with another room (this Mac's own before a Reset).
const HOOK_REFUSED = "The relay won't take this webhook's URL yet. Rotate the URL if this stays.";
const SIGNED_NEEDS_SECRET = "A signed webhook needs a signing secret.";

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
 * are the ones saved after the Chat's latest divider (a routine-run message, or a Linear Run's issue card carrying its
 * Run; Milagre's own notes left out), as `delegationReply`
 * reads a Delegation's: the streamed run is folded away before the turn's end is published, so they are all there is.
 */
function routineReply(state, sessionId) {
  const messages = (state?.messages ?? []).filter((message) => message.session_id === sessionId);
  const start = messages.findLastIndex((message) => message.role === "user" && routineRunOf(message));
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
 * archives a Chat as the user would. `projects()` lists the Projects Milagre has and `projectState(path)` reads one (its
 * Worktrees and Chats, without opening it), for finding the Chat a Linear issue's comments go into.
 */
function routineChats({
  chats,
  cachedState,
  openState,
  isClosing,
  worktrees,
  archiveChat,
  projects = async () => [],
  projectState = async () => null,
  // The connected Linear workspaces' keys: with more than one, a link that names no workspace is ambiguous.
  linearWorkspaces = () => [],
  now = Date.now,
  timeoutMs = START_TIMEOUT_MS,
  hooks = () => null,
}) {
  // runId -> the webhook delivery its first message was worded from, deleted once that message is sent.
  const webhookRuns = new Map();
  const dropDelivery = (deliveryId) => {
    try {
      hooks()?.store.takeDelivery(deliveryId);
    } catch (error) {
      console.warn("[routines] couldn't delete a webhook delivery", error?.message ?? error);
    }
  };
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
    if (event?.kind === "webhook") {
      const delivery = hooks()?.store.getDelivery(event.deliveryId);
      if (!delivery) throw new Error("The webhook delivery is no longer on this Mac.");
      return webhookPrompt(routine.prompt, delivery);
    }
    if (routine.trigger.kind === "webhook") throw new Error(WEBHOOK_LATER);
    if (event?.kind === "linear") return linearPrompt(routine.prompt, event.issue, undefined, routine.trigger.workspace);
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
    const deliveryId = run.event?.kind === "webhook" ? run.event.deliveryId : null;
    let made;
    try {
      made = await workspaceFor(routine, issue);
    } catch (error) {
      // The Run fails; nothing will word a message from its delivery again.
      if (deliveryId) dropDelivery(deliveryId);
      throw error;
    }
    const { worktreeId, createdWorktree } = made;
    if (deliveryId) webhookRuns.set(run.id, deliveryId);
    try {
      const sessionId = await chats.emptyChat(projectPath, worktreeId, {
        origin: { routineId: routine.id, runId: run.id },
        title: issue ? `${issue.key} ${issue.title}` : routine.name,
        // The Project folder's empty Chat may be one the user is about to type in.
        ...(createdWorktree ? {} : { fresh: true }),
      });
      const chatId = chatKey(projectPath, sessionId);
      const runOf = { routineId: routine.id, runId: run.id, name: routine.name, at };
      // A Linear Run opens with the issue card carrying its Run, which links the Chat to the issue (in the Project folder
      // too, through its summary); any other Run with its divider.
      const context = issue ? routineIssueContext(issue, runOf) : { kind: "routine-run", ...runOf, label: `Routine · ${routine.name}` };
      // A Run records its Worktree's id as text (RoutineRun.worktreeId).
      return { chatId, worktreeId: String(worktreeId), createdWorktree, body, prompt: body, context };
    } catch (error) {
      // Nothing can fail once the Chat is made, so only the Worktree is left to take back.
      if (createdWorktree) await dropWorktree(projectPath, worktreeId);
      if (deliveryId) {
        webhookRuns.delete(run.id);
        dropDelivery(deliveryId);
      }
      throw error;
    }
  }

  /**
   * The Chat working on a Linear issue (`key`, `workspace`), where its comments go: one in the Worktree linked to the issue,
   * or one whose first message is the issue's card (a Chat started from the issue in the Project folder). Archived Chats
   * and Chats with no message yet (a Run's Chat whose first message hasn't gone) are left out; of the rest, the one
   * active most recently. Null when there is none. Workspaces compare without regard to case; a link that names none
   * matches only while one Linear workspace is connected. The Projects are read side by side, and one that can't be read
   * (a moved or deleted folder) is skipped; only a Project list that can't be read rejects, and the comment waits.
   */
  async function linkedChat({ key, workspace }) {
    const wanted = String(key ?? "").toUpperCase();
    if (!wanted) return null;
    const lower = (value) => String(value).toLowerCase();
    const lenient = linearWorkspaces().length <= 1;
    const sameWorkspace = (issueWorkspace) => !workspace || (issueWorkspace ? lower(issueWorkspace) === lower(workspace) : lenient);
    const same = (issueKey, issueWorkspace) => typeof issueKey === "string" && issueKey.toUpperCase() === wanted && sameWorkspace(issueWorkspace);
    const listed = await projects();
    const states = await Promise.all(listed.map((project) => Promise.resolve(projectState(project.path)).catch(() => null)));
    let best = null;
    for (const [index, project] of listed.entries()) {
      const state = states[index];
      for (const chat of Object.values(state?.sessions ?? {})) {
        if (chat.archived || !(chat.summary?.count > 0)) continue;
        const worktree = state.worktrees?.[chat.worktree_id];
        const linked =
          (worktree && worktree.path !== project.path && same(worktree.linearIssue, worktree.linearWorkspace)) ||
          same(chat.summary.linearIssue, chat.summary.linearWorkspace);
        if (!linked) continue;
        const at = chat.summary.lastAt ?? 0;
        if (!best || at > best.at || (at === best.at && chat.id > best.id)) best = { chatId: chatKey(project.path, chat.id), at, id: chat.id };
      }
    }
    return best?.chatId ?? null;
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
        // A webhook Run that fails here isn't tried again: its delivery goes, as after a failed start.
        const failedDelivery = webhookRuns.get(context?.runId);
        if (failedDelivery) {
          webhookRuns.delete(context.runId);
          dropDelivery(failedDelivery);
        }
        if (waited) throw busyError();
        throw error;
      }
      // A webhook Run's payload now lives in its Chat's first message: the copy kept for it goes.
      const deliveryId = webhookRuns.get(context?.runId);
      if (deliveryId) {
        webhookRuns.delete(context.runId);
        dropDelivery(deliveryId);
      }
      return { started: sending.started };
    },
    // Called on the turn's end, which is published after it was folded into the saved reply (ChatHost.receive).
    replyText: (chatId) => routineReply(cachedState(projectOfKey(chatId)), sessionIdFromKey(chatId)),
    startChat: (request) => startChat(request),
    archive: (chatId, options) => archive(chatId, options),
    linkedChat: (issue) => linkedChat(issue),
    // `session` patches the Chat in the same change (see ChatHost.patchMessageContext). A Linear Run's card keeps its
    // divider in `context.routine`, so the patch goes there.
    async patchRunContext(chatId, runId, patch, session) {
      await chats.patchMessageContext(
        projectOfKey(chatId),
        sessionIdFromKey(chatId),
        (message) => message.role === "user" && routineRunOf(message)?.runId === runId,
        (context) => (context?.kind === "linear-issue" ? { ...context, routine: { ...context.routine, ...patch } } : { ...context, ...patch }),
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
  // The Mac's Linear connections and webhooks ({ store: hook-store.cjs, relayUrl }), read lazily: the runtime makes them after this.
  linear: getLinear = () => null,
  hooks: getHooks = () => null,
  // The Projects Milagre lists ([{ path }]): a Routine runs only in one of them. `projectState(path)` reads one.
  projects = async () => [],
  projectState = async () => null,
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
  const hooksNow = () => {
    try {
      return getHooks() ?? null;
    } catch {
      return null;
    }
  };
  const checkTarget = routineTargets({ projects, openState });
  const routineChatsView = routineChats({
    chats,
    projects,
    projectState,
    linearWorkspaces: () => linearWorkspaces(),
    cachedState,
    openState,
    isClosing,
    worktrees,
    archiveChat,
    now,
    hooks: hooksNow,
  });
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

  const webhooks = createWebhooks({ store, scheduler, hooks: hooksNow, changed });

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
      const target = await checkTarget(input.target);
      if (input.trigger?.kind === "webhook") return webhooks.create({ ...input, target });
      const routine = store.create({ ...input, target, createdBy: { kind: "user" } });
      changed();
      return routine;
    },
    async update(id, patch) {
      if (typeof id !== "string" || !id) throw new Error("Choose a routine.");
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("A routine change must be an object.");
      const checked = patch.target === undefined ? patch : { ...patch, target: await checkTarget(patch.target) };
      if (store.get(id)?.trigger.kind === "webhook") return webhooks.update(id, checked);
      const routine = store.update(id, checked);
      changed();
      return routine;
    },
    remove(id) {
      if (typeof id !== "string" || !id) throw new Error("Choose a routine.");
      const removed = store.remove(id);
      if (removed) {
        webhooks.forget(id);
        changed();
      }
      return { removed };
    },
    hook: (id) => webhooks.hook(id),
    rotateHook: (id) => webhooks.rotate(id),
    hookIds: () => webhooks.hookIds(),
    receiveHook: (delivery) => webhooks.receive([delivery]),
    receiveHooks: (deliveries) => webhooks.receive(deliveries),
    hooksRefused: (ids) => webhooks.refused(ids),
    hookOwners: (ids) => webhooks.owners(ids),
    async runNow(id) {
      if (!store.enabled()) throw new Error(OFF);
      if (typeof id !== "string" || !id) throw new Error("Choose a routine.");
      return scheduler.runNow(id);
    },
  };
}

const nonEmpty = (value) => (typeof value === "string" && value.trim() !== "" ? value : undefined);
const isDelivery = (value) =>
  value !== null &&
  typeof value === "object" &&
  typeof value.id === "string" &&
  value.id !== "" &&
  typeof value.hookId === "string" &&
  Number.isFinite(value.receivedAt) &&
  value.body instanceof Uint8Array;

/**
 * Webhook Routines: their URL secrets and waiting deliveries in the hook store (`hooks()` → { store, relayUrl }), and the
 * Routines themselves in the routine store, which only ever holds the hook id. Secrets, URLs and signing secrets are never
 * logged and never returned, except the URL by `hook` and `rotate`, for the Routines form.
 */
function createWebhooks({ store, scheduler, hooks, changed }) {
  const ready = () => {
    const current = hooks();
    if (!current) throw new Error("Webhooks aren't ready on this Mac yet.");
    return current;
  };
  const webhookRoutine = (id) => {
    if (typeof id !== "string" || !id) throw new Error("Choose a routine.");
    const routine = store.get(id);
    if (!routine) throw new Error(`Routine not found: ${id}`);
    if (routine.trigger.kind !== "webhook") throw new Error("Only a webhook Routine has a URL.");
    return routine;
  };
  const live = (routine) => routine.enabled && !routine.completedAt && routine.trigger.kind === "webhook";
  /**
   * The saved secret that goes with the Routine's hook id. A rotation saves the new secret first and keeps the old one as
   * `previous` until the Routine has the new id, so after a crash between the two writes the old URL still works.
   */
  const secretOf = (secrets, routine) => {
    const saved = secrets.secretFor(routine.id);
    if (!saved) return null;
    const { previous, ...current } = saved;
    if (previous && hookIdOf(current.secret) !== routine.trigger.hookId && hookIdOf(previous.secret) === routine.trigger.hookId) return previous;
    return current;
  };
  return {
    /** From the Routines form: the Mac makes the URL. Signed exactly when a signing secret comes with it. */
    create(input) {
      const { store: secrets } = ready();
      const { signingSecret, signingHeader, ...rest } = input;
      const signing = nonEmpty(signingSecret);
      if (input.trigger.signed === true && !signing) throw new Error(SIGNED_NEEDS_SECRET);
      const { secret, hookId, ownerKey } = newHookSecret();
      const routine = store.create({
        ...rest,
        // Blank means the default header (DEFAULT_SIGNING_HEADER); the store checks and lowercases a named one.
        ...(nonEmpty(signingHeader) ? { signingHeader } : {}),
        trigger: { kind: "webhook", hookId, signed: Boolean(signing) },
        createdBy: { kind: "user" },
      });
      try {
        secrets.setSecret(routine.id, { secret, ownerKey, signingSecret: signing });
      } catch (error) {
        store.remove(routine.id);
        throw error;
      }
      changed();
      return routine;
    },
    /**
     * A change to a webhook Routine. Its URL never changes here (rotate does that). `trigger.signed: false` drops the
     * signing secret; a new `signingSecret` signs it; `signed: true` keeps the secret it has.
     */
    update(id, patch) {
      const { store: secrets } = ready();
      const routine = webhookRoutine(id);
      const { signingSecret, ...rest } = patch;
      // A blank header goes back to the default.
      if (typeof rest.signingHeader === "string" && rest.signingHeader.trim() === "") rest.signingHeader = null;
      const touchesSigning = rest.trigger !== undefined || signingSecret !== undefined;
      if (!touchesSigning) {
        const updated = store.update(id, rest);
        changed();
        return updated;
      }
      if (rest.trigger !== undefined && (rest.trigger === null || typeof rest.trigger !== "object" || rest.trigger.kind !== "webhook")) {
        throw new Error("Can't change a Routine's trigger kind");
      }
      if (rest.trigger?.hookId !== undefined && rest.trigger.hookId !== routine.trigger.hookId) {
        throw new Error("Rotate the webhook URL to change it.");
      }
      const current = secretOf(secrets, routine);
      if (!current) throw new Error("This webhook has no URL. Rotate it to make one.");
      const fresh = nonEmpty(signingSecret);
      const signed = rest.trigger?.signed !== undefined ? rest.trigger.signed === true : fresh ? true : routine.trigger.signed;
      const kept = signed ? (fresh ?? current.signingSecret) : undefined;
      if (signed && !kept) throw new Error(SIGNED_NEEDS_SECRET);
      const updated = store.update(id, { ...rest, trigger: { kind: "webhook", hookId: routine.trigger.hookId, signed } });
      secrets.setSecret(id, { secret: current.secret, ownerKey: current.ownerKey, signingSecret: kept });
      changed();
      return updated;
    },
    forget(id) {
      try {
        hooks()?.store.removeSecret(id);
      } catch (error) {
        console.warn("[routines] couldn't forget a webhook secret", error?.message ?? error);
      }
    },
    hook(id) {
      const { store: secrets, relayUrl } = ready();
      const routine = webhookRoutine(id);
      const current = secretOf(secrets, routine);
      if (!current) throw new Error("This webhook has no URL. Rotate it to make one.");
      return { url: hookUrl(relayUrl, current.secret), signed: routine.trigger.signed, signingHeader: routine.signingHeader ?? DEFAULT_SIGNING_HEADER };
    },
    /** A new URL; the old one stops at the relay as soon as it hears the new set. Signing stays as it was. */
    rotate(id) {
      const { store: secrets, relayUrl } = ready();
      const routine = webhookRoutine(id);
      const current = secretOf(secrets, routine);
      // A new owner key too: whoever held the old one can't move the new hook.
      const { secret, hookId, ownerKey } = newHookSecret();
      const next = { secret, ownerKey, signingSecret: current?.signingSecret };
      // The new secret is on disk before the Routine points at it, with the old one kept until it does.
      secrets.setSecret(id, { ...next, ...(current ? { previous: current } : {}) });
      try {
        store.update(id, { trigger: { kind: "webhook", hookId, signed: routine.trigger.signed } });
      } catch (error) {
        if (current) secrets.setSecret(id, current);
        else secrets.removeSecret(id);
        throw error;
      }
      // The Routine has the new hook id now, so the relay hears of it even if dropping `previous` fails (reads pick the
      // entry that matches the hook id either way).
      try {
        secrets.setSecret(id, next);
      } finally {
        changed();
      }
      return { url: hookUrl(relayUrl, secret) };
    },
    /** The hooks the relay should hold deliveries for: none while the Routines switch is off. */
    hookIds: () => (store.enabled() ? store.hookIds() : []),
    /**
     * Deliveries from the relay. Each is on disk before this returns (the relay deletes its copy on the ack that follows),
     * then dropped when no live webhook Routine has its hook, failed when its signature doesn't match, or queued. A throw
     * means nothing may be acked.
     */
    receive(deliveries) {
      const list = (Array.isArray(deliveries) ? deliveries : []).filter(isDelivery);
      if (list.length === 0) return { ack: true };
      const { store: secrets } = ready();
      // A copy already here belongs to an earlier arrival whose Run hasn't used it yet (it goes once the Run's first message
      // is out, or the Run fails).
      const waiting = new Set(list.filter((delivery) => secrets.getDelivery(delivery.id)).map((delivery) => delivery.id));
      secrets.putDeliveries(list);
      const drop = (id) => {
        try {
          secrets.takeDelivery(id);
        } catch (error) {
          console.warn("[routines] couldn't delete a webhook delivery", error?.message ?? error);
        }
      };
      const routines = store.enabled() ? store.list().filter(live) : [];
      const items = [];
      let rejected = false;
      for (const delivery of list) {
        const routine = routines.find((item) => item.trigger.hookId === delivery.hookId);
        if (!routine) {
          drop(delivery.id);
          continue;
        }
        const event = { kind: "webhook", key: `webhook:${delivery.id}`, deliveryId: delivery.id };
        if (routine.trigger.signed) {
          const current = secretOf(secrets, routine);
          const header = routine.signingHeader ?? DEFAULT_SIGNING_HEADER;
          if (!verifySignature({ body: delivery.body, headers: delivery.headers, header, signingSecret: current?.signingSecret })) {
            if (store.rejectEvent(routine.id, event, "signature mismatch")) rejected = true;
            drop(delivery.id);
            continue;
          }
        }
        items.push({ routineId: routine.id, event });
      }
      const results = items.length ? scheduler.enqueueEvents(items) : [];
      // A redelivery ("seen") keeps its copy only while the first arrival's Run still needs it.
      results.forEach((result, index) => {
        if (result.queued) return;
        const { deliveryId } = items[index].event;
        if (result.reason === "seen" && waiting.has(deliveryId)) return;
        drop(deliveryId);
      });
      if (rejected) changed();
      return { ack: true };
    },
    /** The relay's answer to the last hook set: the ids another room still holds show on their Routines until taken. */
    refused(ids) {
      const held = new Set(Array.isArray(ids) ? ids : []);
      let any = false;
      for (const routine of store.list()) {
        if (routine.trigger.kind !== "webhook") continue;
        if (held.has(routine.trigger.hookId)) {
          if (routine.lastError !== HOOK_REFUSED) {
            store.setLastError(routine.id, HOOK_REFUSED);
            any = true;
          }
        } else if (routine.lastError === HOOK_REFUSED) {
          store.setLastError(routine.id, null);
          any = true;
        }
      }
      if (any) changed();
    },
    /** The owner keys of `ids`, for the relay host's hook sets (sent only on this Mac's own connection; the relay keeps a hash). */
    owners(ids) {
      const wanted = new Set(Array.isArray(ids) ? ids : []);
      const current = hooks();
      const out = {};
      if (!current) return out;
      for (const routine of store.list()) {
        if (routine.trigger.kind !== "webhook" || !wanted.has(routine.trigger.hookId)) continue;
        const ownerKey = secretOf(current.store, routine)?.ownerKey;
        if (ownerKey) out[routine.trigger.hookId] = ownerKey;
      }
      return out;
    },
  };
}

module.exports = { createRoutines, createWebhooks, routineChats, routineReply, routineTargets };
