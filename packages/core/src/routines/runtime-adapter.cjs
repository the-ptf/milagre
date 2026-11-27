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
const { z } = require("zod");
const { createGit } = require("../git/client.cjs");
const { createRoutineStore } = require("./store.cjs");
const { createGitActions } = require("../git-actions.cjs");
const { readPullRequestState } = require("../pull-request.cjs");
const { createRoutineScheduler, linearPrompt, schedulePrompt } = require("./scheduler.cjs");
const { babysitReviewFindings } = require("./review-findings.cjs");
const { createRoutineTools } = require("./tools.cjs");
const { createLinearPoller } = require("./linear-poller.cjs");
const { createPullRequestPoller } = require("./pr-poller.cjs");
const { readPullRequestSnapshot } = require("./pull-request-watch.cjs");
const { DEFAULT_SIGNING_HEADER, hookIdOf, newHookSecret, hookUrl, verifySignature, webhookPrompt } = require("./webhook.cjs");

const WEBHOOK_LATER = "Webhook Routines arrive in a later update.";
const UNLISTED = "Choose a Project Milagre lists.";
const NO_CHAT = "That Chat is no longer in its Project.";
const BUSY = "chat was busy";
const busyError = () => Object.assign(new Error(BUSY), { busy: true });
const knownMode = (mode) => (PERMISSION_MODES.has(mode) ? mode : undefined);
const STOP_WAIT_MS = 5000;
const START_TIMEOUT_MS = 2 * 60 * 1000;
const git = createGit();
const BABYSIT_DEFAULT_DAYS = 30;
const DAY_MS = 864e5;
const BABYSIT_STOPS = new Set(["merged", "closed", "green", "failures", "expired"]);
const WITHHELD = new Set(["heartbeat_create", "routine_create", "routine_run_now", "routine_update", "routine_delete"]);
const HOOK_REFUSED = "The relay won't take this webhook's URL yet. Rotate the URL if this stays.";
const SIGNED_NEEDS_SECRET = "A signed webhook needs a signing secret.";

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

function routineReply(state, sessionId) {
  const messages = (state?.messages ?? []).filter((message) => message.session_id === sessionId);
  const start = messages.findLastIndex((message) => message.role === "user" && routineRunOf(message));
  if (start === -1) return "";
  const last = messages
    .slice(start + 1)
    .findLast((message) => message.role === "assistant" && message.context == null && (message.body?.trim() || message.steps?.length));
  if (!last) return "";
  const body = last.body ?? "";
  const cut = Math.max(0, ...(last.steps ?? []).filter((step) => step.kind !== "thinking").map((step) => step.offset ?? 0));
  return body.slice(cut).trim();
}

function summaryTitle(summary) {
  const [line = ""] = String(summary ?? "")
    .trim()
    .split("\n");
  return shortTitle(line.trim());
}
const openedWithIssue = (state, sessionId, runId) =>
  (state?.messages ?? []).some(
    (message) => message.session_id === sessionId && message.context?.kind === "linear-issue" && message.context.routine?.runId === runId,
  );

function routineChats({
  chats,
  cachedState,
  openState,
  isClosing,
  worktrees,
  archiveChat,
  projects = async () => [],
  projectState = async () => null,
  linearWorkspaces = () => [],
  startCheck = async () => {},
  now = Date.now,
  timeoutMs = START_TIMEOUT_MS,
  hooks = () => null,
  hasRun = () => false,
  setRunTitle = () => false,
  generateRunTitle = async () => null,
  fallbackFor = async () => null,
  stopChat = async () => {},
}) {
  const webhookRuns = new Map();
  const dropDelivery = (deliveryId) => {
    try {
      hooks()?.store.takeDelivery(deliveryId);
    } catch (error) {
      console.warn("[routines] couldn't delete a webhook delivery", error?.message ?? error);
    }
  };
  const dropRunDelivery = (runId) => {
    const deliveryId = webhookRuns.get(runId);
    if (!deliveryId) return;
    webhookRuns.delete(runId);
    dropDelivery(deliveryId);
  };
  const session = (chatId) => cachedState(projectOfKey(chatId))?.sessions?.[sessionIdFromKey(chatId)];
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
    const { worktreeId } = await withTimeout(making, timeoutMs, "Making the Worktree took too long.", ({ worktreeId: late }) => {
      void dropWorktree(projectPath, late);
    });
    return { worktreeId, createdWorktree: true };
  }

  async function dropWorktree(projectPath, worktreeId, chatId) {
    try {
      if (!(await worktrees.removable(projectPath, worktreeId))) return;
      await (chatId === undefined ? worktrees.remove(projectPath, worktreeId) : worktrees.remove(projectPath, worktreeId, chatId));
    } catch (error) {
      console.warn("[routines] couldn't remove a Run's Worktree", error);
    }
  }

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
      if (deliveryId) dropDelivery(deliveryId);
      throw error;
    }
    const { worktreeId, createdWorktree } = made;
    if (deliveryId) webhookRuns.set(run.id, deliveryId);
    try {
      const sessionId = await chats.emptyChat(projectPath, worktreeId, {
        origin: { routineId: routine.id, runId: run.id },
        ...(issue ? { title: `${issue.key} ${issue.title}` } : { generatedTitle: routine.name }),
        ...(createdWorktree ? {} : { fresh: true }),
      });
      const chatId = chatKey(projectPath, sessionId);
      const runOf = { routineId: routine.id, runId: run.id, name: routine.name, at };
      const context = issue ? routineIssueContext(issue, runOf) : { kind: "routine-run", ...runOf, label: `Routine · ${routine.name}` };
      return { chatId, worktreeId: String(worktreeId), createdWorktree, body, prompt: body, context };
    } catch (error) {
      if (createdWorktree) await dropWorktree(projectPath, worktreeId);
      dropRunDelivery(run.id);
      throw error;
    }
  }

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

  async function retryChat({ routine, run, chatId }) {
    if (isClosing()) throw new Error("Milagre is closing.");
    const { projectPath } = routine.target;
    const issue = run.event?.kind === "linear" ? run.event.issue : null;
    await startCheck(routine.target);
    const state = await openState(projectPath, sessionIdFromKey(chatId));
    const previous = state?.sessions?.[sessionIdFromKey(chatId)]?.worktree_id;
    let worktreeId = previous;
    let createdWorktree = false;
    if (worktreeId === undefined || !state?.worktrees?.[worktreeId]) ({ worktreeId, createdWorktree } = await workspaceFor(routine, issue));
    try {
      const sessionId = await chats.emptyChat(projectPath, worktreeId, {
        origin: { routineId: routine.id, runId: run.id },
        ...(issue ? { title: `${issue.key} ${issue.title}` } : { generatedTitle: routine.name }),
        fresh: true,
      });
      return { chatId: chatKey(projectPath, sessionId), worktreeId: String(worktreeId), createdWorktree };
    } catch (error) {
      if (createdWorktree) await dropWorktree(projectPath, worktreeId);
      throw error;
    }
  }

  async function archive(chatId, { removeWorktree = false } = {}) {
    const projectPath = projectOfKey(chatId);
    const worktreeId = session(chatId)?.worktree_id;
    await archiveChat(chatId);
    if (removeWorktree && worktreeId !== undefined) await dropWorktree(projectPath, worktreeId, chatId);
  }

  return {
    exists: (chatId) => cachedState(projectOfKey(chatId)) === undefined || Boolean(session(chatId)),
    archived: (chatId) => session(chatId)?.archived === true,
    busy: (chatId) => busy(chatId),
    async send(chatId, { body, prompt, context, settings: claimed }) {
      if (isClosing()) throw new Error("Milagre is closing.");
      const projectPath = projectOfKey(chatId);
      const sessionId = sessionIdFromKey(chatId);
      let waited = false;
      let asks = 0;
      let sending;
      try {
        await startCheck({ kind: "chat", chatId });
        const state = await openState(projectPath, sessionId);
        const target = state?.sessions?.[sessionId];
        if (!target) throw new Error("That Chat is no longer in its Project.");
        if (busy(chatId)) throw busyError();
        const latest = chats.turnSettings(chatId);
        const settings = latest ?? {
          provider: target.provider ?? claimed?.provider ?? "claude",
          model: lastUserModel(state, sessionId) || claimed?.model,
          ...(claimed?.effort ? { effort: claimed.effort } : {}),
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
          canStart: () => {
            asks += 1;
            if (asks > 2 || !busy(chatId)) return true;
            waited = true;
            return false;
          },
        });
      } catch (error) {
        dropRunDelivery(context?.runId);
        if (waited) throw busyError();
        throw error;
      }
      dropRunDelivery(context?.runId);
      return { started: sending.started };
    },
    replyText: (chatId) => routineReply(cachedState(projectOfKey(chatId)), sessionIdFromKey(chatId)),
    startChat: (request) => startChat(request),
    retryChat: (request) => retryChat(request),
    ranOn(chatId) {
      const latest = chats.turnSettings?.(chatId);
      return latest ? { provider: latest.provider, model: latest.model, ...(latest.effort ? { effort: latest.effort } : {}) } : null;
    },
    fallbackFor: (request) => fallbackFor(request),
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
        if (!title || isClosing() || !setRunTitle(runId, title)) return;
        await chats.nameRunChat(projectPath, sessionId, runId, title);
      } catch (error) {
        console.warn("[routines] couldn't name a Run", error);
      }
    },
    archive: (chatId, options) => archive(chatId, options),
    async retireWorktree(chatIds) {
      if (typeof worktrees.retire !== "function") return { removed: false, reason: "no Worktree" };
      const groups = new Map();
      for (const chatId of chatIds) {
        const worktreeId = session(chatId)?.worktree_id;
        if (worktreeId === undefined) continue;
        groups.set(`${projectOfKey(chatId)}#${worktreeId}`, { projectPath: projectOfKey(chatId), worktreeId });
      }
      let result = { removed: false, reason: "no Worktree" };
      for (const { projectPath, worktreeId } of groups.values()) {
        result = await worktrees.retire(projectPath, worktreeId, chatIds);
        if (!result.removed) console.info(`[routines] kept a Run's Worktree: ${result.reason}`);
      }
      return result;
    },
    headBranch: (chatId) => headBranch(chatId),
    cwd(chatId) {
      const state = cachedState(projectOfKey(chatId));
      const target = session(chatId);
      return target?.workspacePath ?? state?.worktrees?.[target?.worktree_id]?.path ?? null;
    },
    async startStepChat({ routine, run, worktreeId, title }) {
      if (isClosing()) throw new Error("Milagre is closing.");
      const { projectPath } = routine.target;
      const sessionId = await chats.emptyChat(projectPath, worktreeId, {
        origin: { routineId: routine.id, runId: run.id },
        generatedTitle: title,
        fresh: true,
      });
      return { chatId: chatKey(projectPath, sessionId) };
    },
    stop: (chatId) => stopChat(chatId),
    linkedChat: (issue) => linkedChat(issue),
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
  async function atStart(target) {
    const folder = target?.kind === "new-chat" ? target.projectPath : target?.kind === "chat" ? projectOfKey(String(target.chatId ?? "")) : null;
    if (typeof folder !== "string" || !path.isAbsolute(folder)) throw new Error(UNLISTED);
    if ((await fs.realpath(folder).catch(() => null)) !== folder) throw new Error(`The Project folder ${folder} moved or is no longer a folder.`);
    if (!(await projects()).some((project) => project.path === folder)) throw new Error(UNLISTED);
    if (target.kind === "chat") {
      const sessionId = sessionIdFromKey(target.chatId);
      const session = (await openState(folder, sessionId))?.sessions?.[sessionId];
      if (!session || session.archived) throw new Error(NO_CHAT);
      if (session.readOnlyReason) throw new Error(session.readOnlyReason);
    }
  }
  async function checkTarget(target) {
    if (target?.kind === "new-chat") return { ...target, projectPath: await listedProject(target.projectPath) };
    if (target?.kind !== "chat") return target;
    if (typeof target.chatId !== "string" || !target.chatId.includes("#")) throw new Error("Choose a Chat.");
    const scope = projectOfKey(target.chatId);
    if (isLinkScopeKey(scope)) throw new Error(UNLISTED);
    const projectPath = await listedProject(scope);
    const sessionId = sessionIdFromKey(target.chatId);
    const session = (await openState(projectPath, sessionId))?.sessions?.[sessionId];
    if (!session || session.archived) throw new Error(NO_CHAT);
    if (session.readOnlyReason) throw new Error(session.readOnlyReason);
    return { kind: "chat", chatId: chatKey(projectPath, sessionId) };
  }
  return Object.assign(checkTarget, { atStart });
}

function createRoutines({
  file,
  chats,
  emit,
  cachedState,
  openState,
  isClosing = () => false,
  worktrees,
  archiveChat = async () => {},
  linear: getLinear = () => null,
  hooks: getHooks = () => null,
  projects = async () => [],
  projectState = async () => null,
  generateRunTitle = async () => null,
  keepChat = async () => {},
  chatMessages = async () => [],
  markRunChats = async () => {},
  archiveRunChat = async () => {},
  fallbackFor = async () => null,
  // by hand, the "waits for you" notification, and the git and gh a pull request step runs.
  linearIssues: getLinearIssues = () => null,
  linearTools: getLinearTools = () => null,
  stopChat = async () => {},
  notifyWaiting = () => {},
  gitActions = createGitActions(),
  readPullRequest = readPullRequestState,
  timers = {},
}) {
  const now = timers.now ?? Date.now;
  function settleWithin() {
    let timer;
    const bound = new Promise((resolve) => {
      timer = setTimeout(resolve, timers.stopWaitMs ?? STOP_WAIT_MS);
      timer.unref?.();
    });
    return Promise.race([Promise.all([scheduler.idle(), sweepsIdle()]), bound]).finally(() => clearTimeout(timer));
  }
  const sweeps = new Set();
  const busyRunChats = new Set();
  async function sweepsIdle() {
    while (sweeps.size) await Promise.allSettled(sweeps);
  }
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
  const checkTarget = routineTargets({ projects, openState });
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
    setRunTitle(runId, title) {
      const saved = store.setRunTitle(runId, title);
      if (saved) changed();
      return saved;
    },
    generateRunTitle: (request) => generateRunTitle(request),
    fallbackFor: (request) => fallbackFor(request),
    stopChat: (chatId) => stopChat(chatId),
  });
  const flowActions = createFlowActions({
    cwd: (chatId) => routineChatsView.cwd(chatId),
    headBranch: (chatId) => routineChatsView.headBranch(chatId),
    git,
    gitActions,
    readPullRequest,
    linearIssues: () => getLinearIssues(),
    linearTools: () => getLinearTools(),
    notifyWaiting: (notice) => notifyWaiting(notice),
  });
  const scheduler = createRoutineScheduler({
    store,
    chats: routineChatsView,
    flowActions,
    now,
    ...(timers.setInterval ? { setInterval: timers.setInterval } : {}),
    ...(timers.clearInterval ? { clearInterval: timers.clearInterval } : {}),
    onChange: changed,
  });
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
    linkedIssue: async (issue) => Boolean(await routineChatsView.linkedChat(issue)),
    onChange: changed,
    now,
    ...(timers.setTimeout ? { setTimeout: timers.setTimeout } : {}),
    ...(timers.clearTimeout ? { clearTimeout: timers.clearTimeout } : {}),
  });
  prPoller = createPullRequestPoller({
    store,
    scheduler,
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

  const knowsRoutine = ({ routineId }) => store.get(routineId) !== null || store.wasRemoved(routineId);
  const runLeft = ({ routineId, runId }) => (store.get(routineId) !== null && !store.hasRun(runId)) || store.wasRemoved(routineId);

  function renamed(session) {
    if (typeof session.title !== "string" || session.title.trim() === "") return false;
    const routine = store.get(session.routine.routineId);
    if (!routine) return true;
    if (session.title === routine.name) return false;
    const issue = store.runs(routine.id).find((run) => run.id === session.routine.runId)?.event?.issue;
    return !(issue && session.title === `${issue.key} ${issue.title}`);
  }

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
    definitions: (chatId) =>
      [...(isLinkScopeKey(projectOfKey(chatId)) ? [] : tools.definitions(chatId)), ...(startedByRoutine(chatId) ? [flowOutputTool(chatId)] : [])]
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
    start() {
      scheduler.recover();
      scheduler.start();
      poller.start();
      prPoller.start();
    },
    tick: () => scheduler.tick(),
    idle: () => scheduler.idle().then(sweepsIdle),
    stop() {
      scheduler.stop();
      poller.stop();
      prPoller.stop();
      return settleWithin();
    },
    runningCount: () => store.runningCount(),
    list: () => ({ routines: store.list().map((routine) => Object.assign(routine, { runs: store.runs(routine.id) })) }),
    findPullRequest: (repo, number) => store.findPullRequest(repo, number),
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
      await keepTarget(routine);
      return routine;
    },
    reviewFindings: (url, findings) => babysitReviewFindings({ store, scheduler, now }, url, findings),
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
    async flowAct(runId, action, options = {}) {
      if (typeof runId !== "string" || !runId) throw new Error("Choose a Run.");
      if (!FLOW_ACTIONS.has(action)) throw new Error("That isn't something a flow Run does.");
      const clean = {};
      if (typeof options?.reason === "string") clean.reason = options.reason.slice(0, 2000);
      if (typeof options?.note === "string") clean.note = options.note.slice(0, 2000);
      const run = await scheduler.flowAct(runId, action, clean);
      changed();
      return { run };
    },
    async flowTest(id) {
      if (typeof id !== "string" || !id) throw new Error("Choose a Routine.");
      const run = await scheduler.flowTest(id);
      changed();
      return { run };
    },
  };

  function flowOutputTool(chatId) {
    return {
      name: "flow_step_output",
      description:
        "Hand back the fields this Routine flow step asks for, once, when the work is done. The step's message lists the fields and their types; send them as `fields`. A step with no fields takes an empty object.",
      input: { fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).describe("Each field the step asks for, by name.") },
      readOnly: false,
      run: async ({ fields }) => {
        const result = scheduler.flowOutput(chatId, fields ?? {});
        if (!result.ok) throw new Error(result.error);
        return result.text;
      },
    };
  }
}

const FLOW_ACTIONS = new Set(["approve", "reject", "pause", "resume", "end", "retry"]);

/**
 * What flow steps do outside Milagre, for flow-runner.cjs: look for and open a pull request from a Run's Worktree (git and
 * gh), comment on and read a Linear issue, read a review, and tell the owner a Run waits for them.
 */
function createFlowActions({ cwd, headBranch, git, gitActions, readPullRequest, linearIssues, linearTools, notifyWaiting }) {
  const folder = (chatId) => {
    const found = cwd(chatId);
    if (!found) throw new Error("The Run's Worktree is no longer in the Project");
    return found;
  };
  async function findPullRequest({ chatId, expected }) {
    if (expected && (await headBranch(chatId)) !== expected.branch)
      throw new Error("The branch changed since this action started. Restore it before retrying.");
    const lookup = await readPullRequest(folder(chatId));
    if (!lookup.known) throw new Error("Couldn't ask GitHub whether this branch has a pull request (is gh signed in?)");
    if (!lookup.pr) return null;
    return { url: lookup.pr.url, number: lookup.pr.number, branch: (await headBranch(chatId)) ?? "", draft: Boolean(lookup.pr.isDraft) };
  }
  async function pullRequestPreview({ chatId, base }) {
    const dir = folder(chatId);
    const branch = (await headBranch(chatId)) ?? "";
    const read = (args) =>
      git.read
        .checked(dir, args)
        .then(({ stdout }) => stdout.trim())
        .catch(() => "");
    const baseName = base || (await read(["rev-parse", "--abbrev-ref", "origin/HEAD"])).replace(/^origin\//, "") || "main";
    const stat = (await read(["diff", "--shortstat", `origin/${baseName}...HEAD`])) || (await read(["diff", "--shortstat", `${baseName}...HEAD`]));
    const remote = await read(["remote", "get-url", "origin"]);
    const head = await read(["rev-parse", "HEAD"]);
    if (!branch || !remote || !head) throw new Error("Could not read the branch, repository and commit for approval");
    const repository = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(remote)?.[1];
    return { branch, base: baseName, head, ...(repository ? { repository } : {}), ...(stat ? { changes: shortStat(stat) } : {}) };
  }
  async function openPullRequest({ chatId, base, title, body, draft, expected }) {
    const dir = folder(chatId);
    if (expected) {
      const current = await pullRequestPreview({ chatId, base });
      if (["branch", "base", "repository", "head"].some((field) => current[field] !== expected[field])) {
        throw new Error("The branch or commit changed after approval. Review a fresh preview before opening the pull request.");
      }
      base = expected.base;
    }
    const pushed = await gitActions.push({ cwd: dir });
    if (!pushed.ok) return { ok: false, message: pushed.message ?? "The push failed" };
    const opened = await gitActions.openPr({ cwd: dir, base, title, body, draft });
    return opened.ok ? { ...opened, branch: pushed.branch } : { ok: false, message: opened.message };
  }
  async function commentOnLinear({ issue, body }) {
    const tools = linearTools();
    if (!tools) throw new Error("Linear isn't connected on this Mac");
    const text = await tools.comment({ issue: issue.key, body, workspace: issue.workspace });
    return { url: /https?:\/\/\S+/.exec(String(text ?? ""))?.[0] };
  }
  async function issueState({ key, workspace }) {
    const issues = linearIssues();
    if (!issues) return null;
    const issue = await issues.readIssue(key, workspace);
    return issue?.state?.name ?? null;
  }
  async function reviewDecision({ chatId }) {
    const lookup = await readPullRequest(folder(chatId));
    return lookup.pr?.reviewDecision ?? null;
  }
  function notify(routine, run, text) {
    if (!run.chatId) return;
    try {
      notifyWaiting({ chatId: run.chatId, requestId: `flow:${run.id}`, title: routine.name, body: text });
    } catch (error) {
      console.warn("[routines] couldn't notify", error);
    }
  }
  return { findPullRequest, pullRequestPreview, openPullRequest, commentOnLinear, issueState, reviewDecision, notify };
}

function shortStat(stat) {
  const files = /(\d+) files? changed/.exec(stat)?.[1];
  const added = /(\d+) insertions?/.exec(stat)?.[1] ?? "0";
  const removed = /(\d+) deletions?/.exec(stat)?.[1] ?? "0";
  return files ? `${files} ${files === "1" ? "file" : "files"}, ${added} added, ${removed} removed` : stat;
}

const isRunChat = (session) => typeof session?.routine?.runId === "string";

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
    create(input) {
      const { store: secrets } = ready();
      const { signingSecret, signingHeader, ...rest } = input;
      const signing = nonEmpty(signingSecret);
      if (input.trigger.signed === true && !signing) throw new Error(SIGNED_NEEDS_SECRET);
      const { secret, hookId, ownerKey } = newHookSecret();
      const routine = store.create({
        ...rest,
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
    update(id, patch) {
      const { store: secrets } = ready();
      const routine = webhookRoutine(id);
      const { signingSecret, ...rest } = patch;
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
    rotate(id) {
      const { store: secrets, relayUrl } = ready();
      const routine = webhookRoutine(id);
      const current = secretOf(secrets, routine);
      const { secret, hookId, ownerKey } = newHookSecret();
      const next = { secret, ownerKey, signingSecret: current?.signingSecret };
      secrets.setSecret(id, { ...next, ...(current ? { previous: current } : {}) });
      try {
        store.update(id, { trigger: { kind: "webhook", hookId, signed: routine.trigger.signed } });
      } catch (error) {
        if (current) secrets.setSecret(id, current);
        else secrets.removeSecret(id);
        throw error;
      }
      try {
        secrets.setSecret(id, next);
      } finally {
        changed();
      }
      return { url: hookUrl(relayUrl, secret) };
    },
    hookIds: () => store.hookIds(),
    receive(deliveries) {
      const list = (Array.isArray(deliveries) ? deliveries : []).filter(isDelivery);
      if (list.length === 0) return { ack: true };
      const { store: secrets } = ready();
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
      results.forEach((result, index) => {
        if (result.queued) return;
        const { deliveryId } = items[index].event;
        if (result.reason === "seen" && waiting.has(deliveryId)) return;
        drop(deliveryId);
      });
      if (rejected) changed();
      return { ack: true };
    },
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
