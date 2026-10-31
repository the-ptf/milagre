const fs = require("node:fs/promises");
const path = require("node:path");
const { chatKey, isTurnEnd, lastUserModel, projectOfKey, sessionIdFromKey } = require("@milagre/shared/agent-runs");
const { backgroundWork, holdsAnnouncement } = require("@milagre/shared/chat-activity");
const { isLinkScopeKey } = require("@milagre/shared/chat-scopes");
const { shortTitle } = require("@milagre/shared/chats");
const { routineIssueContext } = require("@milagre/shared/linear-issue");
const { routineRunOf } = require("@milagre/shared/routines");
const { babysitStoppedText } = require("@milagre/shared/babysit");
const { PERMISSION_MODES } = require("../agents/permissions.cjs");
const { createGit } = require("../git/client.cjs");
const { createRoutineStore } = require("./store.cjs");
const { createRoutineScheduler, linearPrompt, schedulePrompt } = require("./scheduler.cjs");
const { createRoutineTools } = require("./tools.cjs");
const { createLinearPoller } = require("./linear-poller.cjs");
const { createPullRequestPoller } = require("./pr-poller.cjs");
const { readPullRequestSnapshot } = require("./pull-request-watch.cjs");
const { DEFAULT_SIGNING_HEADER, hookIdOf, newHookSecret, hookUrl, verifySignature, webhookPrompt } = require("./webhook.cjs");

const WEBHOOK_LATER = "Webhook Routines arrive in a later update.";
const UNLISTED = "Choose a Project Milagre lists.";
const NO_CHAT = "That Chat is no longer in its Project.";
// What the scheduler records when a Chat got busy as a Run's message was about to go (scheduler.cjs BUSY).
const BUSY = "chat was busy";
const busyError = () => Object.assign(new Error(BUSY), { busy: true });
// A mode saved on a Chat, or undefined when it isn't one Milagre knows (a stale or hand-edited value falls back).
const knownMode = (mode) => (PERMISSION_MODES.has(mode) ? mode : undefined);
// How long stopping Routines (Milagre quitting) waits for what the scheduler still has going. A Run cut
// off after that is recovered on the next start as "daemon restarted"; the stopped scheduler sends nothing new meanwhile.
const STOP_WAIT_MS = 5000;
// A hung git (a fetch, a setup step) fails the Run instead of holding its slot until the daemon restarts.
const START_TIMEOUT_MS = 2 * 60 * 1000;
// Reads the branch a Chat's Worktree is on (a babysit Run waits on it), through the shared Git client's limits.
const git = createGit();
// How long a Babysit Heartbeat lasts when its settings don't name a number of days.
const BABYSIT_DEFAULT_DAYS = 30;
const DAY_MS = 864e5;
// The reasons a babysit Heartbeat ends that its Chat hears about. Its Chat gone or archived leaves nowhere to say it;
// a deletion says it from removeRoutine.
const BABYSIT_STOPS = new Set(["merged", "closed", "green", "failures", "expired"]);
// What a Chat a Routine started can't do while it is still its Run's: make, change or delete Routines, or start their Runs,
// so a Run never sets off another. A Run Chat the user kept is a normal Chat and gets them.
const WITHHELD = new Set(["heartbeat_create", "routine_create", "routine_run_now", "routine_update", "routine_delete"]);
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

// A quiet Run's title: the first line of its summary, cut as a Chat's title is (57 characters and an ellipsis past 60).
// Empty when it says nothing.
function summaryTitle(summary) {
  const [line = ""] = String(summary ?? "")
    .trim()
    .split("\n");
  return shortTitle(line.trim());
}
// Whether Run `runId` opened with a Linear issue's card, which its Chat and the Run both take their name from.
const openedWithIssue = (state, sessionId, runId) =>
  (state?.messages ?? []).some(
    (message) => message.session_id === sessionId && message.context?.kind === "linear-issue" && message.context.routine?.runId === runId,
  );

/**
 * The scheduler's view of the Chats (see scheduler.cjs). `cachedState(scope)` is a scope's state in memory, undefined
 * when it isn't open; `openState(scope, sessionId)` opens it if needed and resolves with the Chat's messages loaded.
 * `worktrees` makes and removes a Run's Worktree (create, remove, removable, base, projectWorktree) and `archiveChat`
 * archives a Chat as the user would. `projects()` lists the Projects Milagre has and `projectState(path)` reads one (its
 * Worktrees and Chats, without opening it), for finding the Chat a Linear issue's comments go into. `hasRun(runId)` and
 * `setRunTitle(runId, title)` are the store's, and `generateRunTitle({ reply, provider, projectPath })` names a Run from
 * its final reply (resolving with null when it can't), for `nameRun`.
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
  // Checks a Run's stored target again as the Run starts (routineTargets().atStart); throws to fail the Run.
  startCheck = async () => {},
  now = Date.now,
  timeoutMs = START_TIMEOUT_MS,
  hooks = () => null,
  hasRun = () => false,
  setRunTitle = () => false,
  generateRunTitle = async () => null,
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
  // A webhook Run's delivery once its first message went (the payload lives in the Chat now) or it failed for good.
  const dropRunDelivery = (runId) => {
    const deliveryId = webhookRuns.get(runId);
    if (!deliveryId) return;
    webhookRuns.delete(runId);
    dropDelivery(deliveryId);
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
   * Makes a Run's Chat, marked with its Run (and hidden from the Chat lists, see ChatHost.emptyChat) and named for the
   * issue, or after the Routine until the Run has ended and says what it did (see nameRun), and words its first message. It
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
      await startCheck(routine.target);
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
        // The Routine's name is only a placeholder: the first-message naming leaves it alone and the Run's end replaces it.
        ...(issue ? { title: `${issue.key} ${issue.title}` } : { generatedTitle: routine.name }),
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
      dropRunDelivery(run.id);
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

  // The branch checked out in a Chat's Worktree, or null when it has none (a detached HEAD) or it can't be read: a babysit
  // Run goes at its level only while this is the PR's branch.
  function headBranch(chatId) {
    const state = cachedState(projectOfKey(chatId));
    const target = session(chatId);
    const cwd = target?.workspacePath ?? state?.worktrees?.[target?.worktree_id]?.path;
    if (!cwd) return Promise.resolve(null);
    return git.read
      .checked(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])
      .then(({ stdout }) => stdout.trim() || null)
      .catch(() => null);
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
      let waited = false;
      let asks = 0;
      let sending;
      try {
        // Checked before the Project opens: opening it reads its folder and can resume work there, which a Project no
        // longer listed, or a folder a symlink was swapped in for, must never get.
        await startCheck({ kind: "chat", chatId });
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
        // A webhook Run that fails here (its check, its Chat, the send) isn't tried again: its delivery goes, as after a
        // failed start.
        dropRunDelivery(context?.runId);
        if (waited) throw busyError();
        throw error;
      }
      // A webhook Run's payload now lives in its Chat's first message: the copy kept for it goes.
      dropRunDelivery(context?.runId);
      return { started: sending.started };
    },
    // Called on the turn's end, which is published after it was folded into the saved reply (ChatHost.receive).
    replyText: (chatId) => routineReply(cachedState(projectOfKey(chatId)), sessionIdFromKey(chatId)),
    startChat: (request) => startChat(request),
    /**
     * Titles a Run that has just ended from what it did, and its Chat with it when the Chat is the Run's own and still
     * unnamed by the user. `quietSummary` (a quiet Run's `(pass)` line) is the title as it is; otherwise the title comes
     * from the Run's final reply. A Linear issue's Run keeps the issue's key and title. Called as the turn's end is observed
     * and reads the reply before it first waits, while the turn's text is still in memory. Never throws: a Run that can't be
     * named keeps the Routine's name, and the problem is logged (one line when the model gave no title, see generateRunTitle).
     */
    async nameRun(chatId, runId, { quietSummary } = {}) {
      try {
        if (!hasRun(runId)) return;
        const projectPath = projectOfKey(chatId);
        const sessionId = sessionIdFromKey(chatId);
        const state = cachedState(projectPath);
        if (openedWithIssue(state, sessionId, runId)) return;
        let title;
        if (quietSummary === undefined) {
          const reply = routineReply(state, sessionId);
          if (!reply) return;
          title = await generateRunTitle({ reply, provider: state?.sessions?.[sessionId]?.provider, projectPath });
          if (!title) console.warn(`[routines] couldn't name Run ${runId}: the title model gave no usable title, so it keeps the Routine's name`);
        } else {
          title = summaryTitle(quietSummary);
        }
        // The Run may be gone, or Milagre closing, by the time a model has answered.
        if (!title || isClosing() || !setRunTitle(runId, title)) return;
        await chats.nameRunChat(projectPath, sessionId, runId, title);
      } catch (error) {
        console.warn("[routines] couldn't name a Run", error);
      }
    },
    archive: (chatId, options) => archive(chatId, options),
    headBranch: (chatId) => headBranch(chatId),
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
 * Neither is ever a bot's (`botOf(chatId)`, the bot that runs a Chat; `botHome(path)`, a bot's hidden home): a Run there
 * would go out in Bot rules, or steer a Chat only its bot steers. Resolves with the target to store.
 */
function routineTargets({ projects, openState, botOf = () => null, botHome = () => false }) {
  function notBots(target) {
    const folder = target.kind === "new-chat" ? target.projectPath : projectOfKey(String(target.chatId));
    if (botHome(folder)) throw new Error(UNLISTED);
    const bot = target.kind === "chat" ? botOf(target.chatId) : null;
    if (bot) throw new Error(`${bot} runs that Chat, so no Routine runs there.`);
  }
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
  /**
   * The same check as a Run starts, for the target as stored: the Project is still listed, its folder is still the folder
   * it was (its realpath is the stored path, so no symlink was swapped in), and a Heartbeat's Chat is still there. Throws
   * what went wrong; the Run fails with it.
   */
  async function atStart(target) {
    const folder = target?.kind === "new-chat" ? target.projectPath : target?.kind === "chat" ? projectOfKey(String(target.chatId ?? "")) : null;
    if (typeof folder !== "string" || !path.isAbsolute(folder)) throw new Error(UNLISTED);
    if ((await fs.realpath(folder).catch(() => null)) !== folder) throw new Error(`The Project folder ${folder} moved or is no longer a folder.`);
    if (!(await projects()).some((project) => project.path === folder)) throw new Error(UNLISTED);
    notBots(target);
    if (target.kind === "chat") {
      const sessionId = sessionIdFromKey(target.chatId);
      const session = (await openState(folder, sessionId))?.sessions?.[sessionId];
      if (!session || session.archived) throw new Error(NO_CHAT);
    }
  }
  async function checkTarget(target) {
    if (target?.kind === "new-chat") {
      const checked = { ...target, projectPath: await listedProject(target.projectPath) };
      notBots(checked);
      return checked;
    }
    if (target?.kind !== "chat") return target;
    if (typeof target.chatId !== "string" || !target.chatId.includes("#")) throw new Error("Choose a Chat.");
    const scope = projectOfKey(target.chatId);
    // Heartbeats in a Named Link's Chats are out of scope (the spec's non-goals).
    if (isLinkScopeKey(scope)) throw new Error(UNLISTED);
    const projectPath = await listedProject(scope);
    const sessionId = sessionIdFromKey(target.chatId);
    const session = (await openState(projectPath, sessionId))?.sessions?.[sessionId];
    if (!session || session.archived) throw new Error(NO_CHAT);
    const checked = { kind: "chat", chatId: chatKey(projectPath, sessionId) };
    notBots(checked);
    return checked;
  }
  return Object.assign(checkTarget, { atStart });
}

/**
 * Routines in the runtime: the store at `file`, the scheduler over the Chats, the agent tools and the `routines:*`
 * commands. Every write says `routines:changed`. `timers` ({ now, setInterval, clearInterval, setTimeout, clearTimeout }) is for tests.
 */
function createRoutines({
  file,
  chats,
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
  // The bot that runs a Chat, and whether a folder is a bot's home: no Routine targets either (routineTargets).
  botOf = () => null,
  botHome = () => false,
  // Names a Run from its final reply ({ reply, provider, projectPath }): a title, or null. Read lazily, like `linear`.
  generateRunTitle = async () => null,
  // Run Chats (see sweepRunChats). `keepChat(chatId)` shows a hidden Run Chat in the lists from now on, as the user's own
  // send, pin or rename does. `chatMessages(projectPath, sessionIds)` reads Chats' messages without loading them.
  // `markRunChats(projectPath, { [sessionId]: hidden })` saves `hidden` on Run Chats that have none yet, and
  // `archiveRunChat(chatId, runId)` archives one only while it is still hidden, unarchived and Run `runId`'s.
  keepChat = async () => {},
  chatMessages = async () => [],
  markRunChats = async () => {},
  archiveRunChat = async () => {},
  timers = {},
}) {
  const now = timers.now ?? Date.now;
  // The scheduler's work off the tick and the Run Chat sweeps under way, waited for at most STOP_WAIT_MS (a Run whose
  // Worktree hangs would hold a quit for the whole start timeout).
  function settleWithin() {
    let timer;
    const bound = new Promise((resolve) => {
      timer = setTimeout(resolve, timers.stopWaitMs ?? STOP_WAIT_MS);
      timer.unref?.();
    });
    return Promise.race([Promise.all([scheduler.idle(), sweepsIdle()]), bound]).finally(() => clearTimeout(timer));
  }
  // Run Chat sweeps under way, and the Run Chats a sweep left because their turn was running (swept again once it ends).
  const sweeps = new Set();
  const busyRunChats = new Set();
  async function sweepsIdle() {
    while (sweeps.size) await Promise.allSettled(sweeps);
  }
  // Routines purged before the webhooks below exist (on load) have their secrets forgotten once they do.
  let webhooksReady = false;
  const purgedEarly = [];
  const forgetPurged = (ids) => {
    if (!webhooksReady) return void purgedEarly.push(...ids);
    for (const routineId of ids) webhooks.forget(routineId);
  };
  const store = createRoutineStore({
    file,
    now,
    onPurged: forgetPurged,
    onRunsDropped: runsDropped,
    onEnded: (ended) => {
      for (const { routine, reason } of ended) if (BABYSIT_STOPS.has(reason)) noteBabysitStopped(routine, reason);
    },
  });
  let poller = null;
  let prPoller = null;
  // Every change may add, remove or switch a Linear or pull-request Routine, so the pollers look again (a cheap scan).
  const changed = () => {
    emit("routines:changed", {});
    poller?.sync();
    prPoller?.sync();
  };
  const hooksNow = () => {
    try {
      return getHooks() ?? null;
    } catch {
      return null;
    }
  };
  const checkTarget = routineTargets({ projects, openState, botOf, botHome });
  const routineChatsView = routineChats({
    chats,
    projects,
    projectState,
    startCheck: (target) => checkTarget.atStart(target),
    linearWorkspaces: () => linearWorkspaces(),
    cachedState,
    openState,
    isClosing,
    worktrees,
    archiveChat,
    now,
    hooks: hooksNow,
    hasRun: (runId) => store.hasRun(runId),
    // A title is a change to the Routines the UI lists, so it says so like any other.
    setRunTitle(runId, title) {
      const saved = store.setRunTitle(runId, title);
      if (saved) changed();
      return saved;
    },
    generateRunTitle: (request) => generateRunTitle(request),
  });
  const scheduler = createRoutineScheduler({
    store,
    chats: routineChatsView,
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
  prPoller = createPullRequestPoller({
    store,
    scheduler,
    // The Routine's own settings decide what is read (the commits behind are only counted when behind wakes the agent).
    read: (pr) => readPullRequestSnapshot(pr, { settings: pr.settings }),
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
  // Read from the state in memory, as chatSettings is: the Chat's session is there when its agent asks for tools. A Run
  // Chat that is hidden, or saved before Run Chats could be hidden and not decided yet, is still its Run's.
  const startedByRoutine = (chatId) => {
    const routine = cachedState(projectOfKey(chatId))?.sessions?.[sessionIdFromKey(chatId)]?.routine;
    return Boolean(routine) && routine.hidden !== false;
  };
  const tools = createRoutineTools({
    store,
    scheduler,
    checkTarget,
    remove: (routineId, by) => removeRoutine(routineId, by),
    keepChat: (chatId) => keepRunChat(chatId),
    chatSettings,
    defaultTimezone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    linearWorkspaces,
    now,
  });

  const webhooks = createWebhooks({ store, scheduler, hooks: hooksNow, changed });
  webhooksReady = true;
  forgetPurged(purgedEarly.splice(0));
  // A Routine deleted from anywhere (the form, an agent's routine_delete) takes its webhook secret with it. A live babysit
  // Heartbeat says in its Chat that it stopped: its own Chat deleting it with the own stop rule on is that rule holding
  // (the prompt asks for nothing else), anything else a deletion.
  function removeRoutine(routineId, { byChat } = {}) {
    const before = store.get(routineId);
    const removed = store.remove(routineId);
    if (removed) webhooks.forget(routineId);
    if (removed && before && !before.completedAt) {
      const ownRule = byChat !== undefined && before.target?.kind === "chat" && byChat === before.target.chatId && before.trigger.settings?.ownRule === true;
      noteBabysitStopped(before, ownRule ? "own-rule" : "deleted");
    }
    return removed;
  }

  /**
   * The line a babysit Heartbeat leaves in its Chat when it ends (babysitStoppedText): a note, so no turn starts and no
   * push goes out. Any other Routine, or one whose Chat is gone, leaves none. Written in the background, waited for at stop.
   */
  function noteBabysitStopped(routine, reason) {
    if (routine?.trigger?.kind !== "pull-request" || routine.target?.kind !== "chat" || typeof chats.addNote !== "function") return;
    const context = { kind: "babysit-stopped", routineId: routine.id, pr: routine.trigger.number, reason };
    const times = routine.trigger.settings?.stopAfterFailures?.times;
    if (reason === "failures" && Number.isInteger(times)) context.times = times;
    if (reason === "expired" && Number.isFinite(routine.expiresAt)) context.days = Math.max(1, Math.round((routine.expiresAt - routine.createdAt) / DAY_MS));
    const task = Promise.resolve()
      .then(() => chats.addNote(routine.target.chatId, { body: babysitStoppedText(context), context }))
      .catch((error) => console.warn("[routines] couldn't say in its Chat that babysitting stopped", error));
    sweeps.add(task);
    void task.finally(() => sweeps.delete(task));
  }

  // A Heartbeat set on a Chat keeps it: a Heartbeat's Chat is ongoing work, whoever set it. A Chat that isn't a hidden Run
  // Chat is left as it is, and a keep that fails leaves the Heartbeat saved.
  async function keepRunChat(chatId) {
    try {
      await keepChat(chatId);
    } catch (error) {
      console.warn("[routines] couldn't keep a Run Chat", error);
    }
  }
  const keepTarget = (routine) => (routine?.target?.kind === "chat" ? keepRunChat(routine.target.chatId) : undefined);

  function trackSweep(work) {
    const task = Promise.resolve(work).catch((error) => console.warn("[routines] couldn't sweep Run Chats", error));
    sweeps.add(task);
    void task.finally(() => sweeps.delete(task));
    return task;
  }

  /**
   * Run Chats in the Project at `projectPath`, as `state` holds them (never a Link's: Routines don't run there). A Chat
   * saved before Run Chats could be hidden (no `hidden`) is decided once, by a store that knows its Routine (see
   * knowsRoutine); one that doesn't leaves it undecided, and listed. A hidden Run Chat whose Run left the store (see
   * runLeft) is archived, so none outlives its place in the Runs list; one whose turn is running waits for the turn to
   * end. A store that opened read-only holds no Runs, so it sweeps nothing.
   */
  function sweepRunChats(projectPath, state) {
    return trackSweep(sweep(projectPath, state));
  }
  async function sweep(projectPath, state) {
    if (isClosing() || isLinkScopeKey(projectPath) || store.readOnlyReason() !== null) return;
    const runChats = Object.values(state?.sessions ?? {}).filter((session) => !session.archived && isRunChat(session));
    if (runChats.length === 0) return;
    const hidden = new Map(runChats.map((session) => [session.id, session.routine.hidden]));
    const undecided = runChats.filter((session) => session.routine.hidden === undefined && knowsRoutine(session.routine));
    if (undecided.length) {
      const decided = await decideRunChats(projectPath, undecided);
      await markRunChats(projectPath, decided);
      for (const session of undecided) hidden.set(session.id, decided[session.id]);
    }
    for (const session of runChats) {
      if (hidden.get(session.id) !== true || !runLeft(session.routine)) continue;
      const chatId = chatKey(projectPath, session.id);
      if (chats.runs?.[chatId]) {
        busyRunChats.add(chatId);
        continue;
      }
      busyRunChats.delete(chatId);
      await archiveRunChat(chatId, session.routine.runId);
    }
  }

  /**
   * Whether this store knows a Run Chat's Routine: it is here, or it was deleted or purged here. A store that never knew it
   * (a fresh profile or a dev copy opening a real Project, a damaged file set aside) can't tell what its Chats are, so it
   * neither decides nor archives them.
   */
  const knowsRoutine = ({ routineId }) => store.get(routineId) !== null || store.wasRemoved(routineId);
  /**
   * Whether a Run Chat's Run left this store: its Routine is here without it (trimmed), or the Routine was deleted or
   * purged here. A store that never knew the Routine can't tell, and says no.
   */
  const runLeft = ({ routineId, runId }) => (store.get(routineId) !== null && !store.hasRun(runId)) || store.wasRemoved(routineId);

  /**
   * Whether a Run Chat saved before `hidden` existed has a name the user gave it. Its Run named it after the Routine, or a
   * Linear issue Run after its issue ("MIL-12 Issue title"); any other title is the user's, and so is any title at all when
   * the Routine was removed here, its name gone with it (one this store never knew isn't decided; see knowsRoutine).
   */
  function renamed(session) {
    if (typeof session.title !== "string" || session.title.trim() === "") return false;
    const routine = store.get(session.routine.routineId);
    if (!routine) return true;
    if (session.title === routine.name) return false;
    const issue = store.runs(routine.id).find((run) => run.id === session.routine.runId)?.event?.issue;
    return !(issue && session.title === `${issue.key} ${issue.title}`);
  }

  /**
   * Whether each Run Chat saved before `hidden` existed stays hidden: not when it is pinned, renamed, a Heartbeat's Chat,
   * or has a user message after its Run's first one that isn't a Run's own (a beat, a Linear comment). Old messages can't
   * tell the user from an agent, so this errs toward keeping.
   */
  async function decideRunChats(projectPath, sessions) {
    const heartbeats = new Set(
      store
        .list()
        .filter((routine) => routine.target?.kind === "chat")
        .map((routine) => routine.target.chatId),
    );
    const decided = {};
    const toRead = [];
    for (const session of sessions) {
      if (session.pinned || renamed(session) || heartbeats.has(chatKey(projectPath, session.id))) decided[session.id] = false;
      else toRead.push(session.id);
    }
    if (toRead.length === 0) return decided;
    const userMessages = new Map(toRead.map((id) => [id, []]));
    for (const message of await chatMessages(projectPath, toRead)) {
      if (message.role === "user") userMessages.get(Number(message.session_id))?.push(message);
    }
    for (const id of toRead)
      decided[id] = !userMessages
        .get(id)
        .slice(1)
        .some((message) => !routineRunOf(message));
    return decided;
  }

  // Runs the store no longer holds that had a Chat: the open Projects those Chats are in are swept (one that isn't open is
  // swept when it opens). Heard once per write, and on load while the store is still being made: `store` isn't set yet
  // then, so the sweep waits a microtask, and it never writes to the store from inside one of its writes.
  function runsDropped(dropped) {
    const projectPaths = new Set(dropped.map((run) => projectOfKey(run.chatId)).filter(Boolean));
    trackSweep(
      Promise.resolve().then(() =>
        Promise.all(
          [...projectPaths].map((projectPath) => {
            const state = cachedState(projectPath);
            return state ? sweepRunChats(projectPath, state) : undefined;
          }),
        ),
      ),
    );
  }

  // A Run Chat a sweep left because its turn was running, swept again once that turn's end is folded in.
  function sweepAfterTurn(chatId) {
    busyRunChats.delete(chatId);
    trackSweep(
      new Promise((resolve) => setImmediate(resolve)).then(() => {
        const projectPath = projectOfKey(chatId);
        const state = cachedState(projectPath);
        return state ? sweepRunChats(projectPath, state) : undefined;
      }),
    );
  }

  return {
    // An agent's write through a tool says routines changed, like a command's. The definitions are new on each call. A Chat on a Named Link gets
    // none: heartbeats there are out of scope (see the spec's non-goals).
    definitions: (chatId) =>
      (isLinkScopeKey(projectOfKey(chatId)) ? [] : tools.definitions(chatId))
        .filter((tool) => !startedByRoutine(chatId) || !WITHHELD.has(tool.name))
        .map((tool) => {
          const { run } = tool;
          tool.run = async (input) => {
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
      if (busyRunChats.has(chatId) && isTurnEnd(event)) sweepAfterTurn(chatId);
    },
    sweepRunChats,
    chatArchived: (chatId) => scheduler.chatArchived(chatId),
    chatDone: (chatId) => scheduler.chatDone(chatId),
    // Recovery first, then the timer and polling.
    start() {
      scheduler.recover();
      scheduler.start();
      poller.start();
      prPoller.start();
    },
    // One tick now, and what the scheduler still has going off the tick (for tests that wait for a positive signal).
    tick: () => scheduler.tick(),
    idle: async () => {
      await scheduler.idle();
      await sweepsIdle();
    },
    // Resolves once a comment already on its way has gone back to its queue, or after the stop bound at most.
    stop() {
      scheduler.stop();
      poller.stop();
      prPoller.stop();
      return settleWithin();
    },
    // Runs under way, which an app update waits for (app-auto-update.cjs).
    runningCount: () => store.runningCount(),
    // store.list gives copies, so each takes its Runs in place.
    list: () => ({ routines: store.list().map((routine) => Object.assign(routine, { runs: store.runs(routine.id) })) }),
    // The live Routine babysitting a pull request (host/owner/repo, number), if any: babysit-watch.cjs asks before it adds one.
    findPullRequest: (repo, number) => store.findPullRequest(repo, number),
    /**
     * The `Babysit PR #<n>` Heartbeat for a pull request the Chat opened, made as its agent's: a heartbeat_create does the
     * same. It ends after `stopAfterDays` when that rule is on, else after 30 days, and follows the Chat's own provider,
     * model and permission mode.
     */
    async createBabysit({ chatId, url, repo, number, settings }) {
      const target = await checkTarget({ kind: "chat", chatId });
      const days = settings.stopAfterDays?.on ? settings.stopAfterDays.days : BABYSIT_DEFAULT_DAYS;
      const name = `Babysit PR #${number}`;
      const routine = store.create({
        name,
        prompt: name,
        trigger: { kind: "pull-request", url, repo, number, settings: { ...settings } },
        target,
        createdBy: { kind: "agent", chatId: target.chatId },
        expiresAt: now() + days * 864e5,
      });
      changed();
      // A hidden Run Chat that opened the PR is kept, or its sweep would end the Heartbeat before it babysat.
      await keepTarget(routine);
      return routine;
    },
    // A Routine from the Routines form: always the user's, whatever the input says.
    async create(input) {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("A Routine needs its settings.");
      const target = await checkTarget(input.target);
      const routine =
        input.trigger?.kind === "webhook" ? webhooks.create({ ...input, target }) : store.create({ ...input, target, createdBy: { kind: "user" } });
      if (input.trigger?.kind !== "webhook") changed();
      await keepTarget(routine);
      return routine;
    },
    async update(id, patch) {
      if (typeof id !== "string" || !id) throw new Error("Choose a Routine.");
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("A Routine change must be an object.");
      const checked = patch.target === undefined ? patch : { ...patch, target: await checkTarget(patch.target) };
      const webhook = store.get(id)?.trigger.kind === "webhook";
      const routine = webhook ? webhooks.update(id, checked) : store.update(id, checked);
      if (!webhook) changed();
      await keepTarget(routine);
      return routine;
    },
    remove(id) {
      if (typeof id !== "string" || !id) throw new Error("Choose a Routine.");
      const removed = removeRoutine(id);
      if (removed) changed();
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
      if (typeof id !== "string" || !id) throw new Error("Choose a Routine.");
      return scheduler.runNow(id);
    },
  };
}

// A Chat a Routine's Run opened (`session.routine`), hidden or not.
const isRunChat = (session) => typeof session?.routine?.runId === "string";

/**
 * `state` with Run Chats' `routine.hidden` set as `decided` ({ [sessionId]: boolean }) says, for those whose routine
 * `applies(routine)` still holds for: the same state when nothing changes. A Chat that isn't a Run Chat is left alone.
 */
function withRunChatsHidden(state, decided, applies) {
  let sessions = null;
  for (const [id, hidden] of Object.entries(decided)) {
    const session = state.sessions[id];
    if (!isRunChat(session) || session.routine.hidden === hidden || !applies(session.routine)) continue;
    sessions ??= { ...state.sessions };
    sessions[id] = { ...session, routine: { ...session.routine, hidden } };
  }
  return sessions ? { ...state, sessions } : state;
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
    if (typeof id !== "string" || !id) throw new Error("Choose a Routine.");
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
      try {
        secrets.setSecret(id, { secret: current.secret, ownerKey: current.ownerKey, signingSecret: kept });
      } catch (error) {
        // The secret write left its old entry intact. Restore the matching signing settings too, so a failed edit
        // doesn't strand a signed Routine without a secret (or make an existing secret use the wrong header).
        store.update(id, { trigger: routine.trigger, signingHeader: routine.signingHeader ?? null });
        throw error;
      } finally {
        changed();
      }
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
    /** The hooks the relay should hold deliveries for. */
    hookIds: () => store.hookIds(),
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
      const routines = store.list().filter(live);
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

module.exports = { createRoutines, createWebhooks, isRunChat, routineChats, routineReply, routineTargets, withRunChatsHidden };
