const { isTurnEnd } = require("@milagre/shared/agent-runs");
const { clock, parsePass } = require("@milagre/shared/routines");
const { renderRoutinePrompt } = require("@milagre/shared/routine-prompt");
const { linearIssueUrl } = require("@milagre/shared/linear-issue");
const { providerFailure } = require("./fallback.cjs");
const { BABYSIT_PASS_HINT, babysitPrompt, effectiveLevel, effectiveResolve } = require("./babysit-prompt.cjs");
const { createFlowRunner } = require("./flow-runner.cjs");

const TICK_MS = 1000;
const BUSY = "chat was busy";
const PASS_HINT = '\n\nIf nothing needs doing, reply starting with "(pass)" and a short reason.';
const CONCURRENT_RUNS = 3;
const COMMENT_RETRY_MS = 15_000;
const NO_CHAT = "issue has no Chat";
const RUN_NOW_EVENTS = "Run now works for schedules and Heartbeats";
const RUN_NOW_BABYSIT = "A babysit Routine runs when its PR changes";
const AUTHOR_MAX = 80;

const errorText = (error) => error?.message ?? String(error);

const isComment = (event) => event?.kind === "linear" && event.change === "comment";
const isPullRequest = (event) => event?.kind === "pull-request";
const startsChat = (routine, run) =>
  routine.flow ? true : run.event ? !isComment(run.event) && !isPullRequest(run.event) : routine.target.kind === "new-chat";

const INVISIBLE = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

function authorName(author) {
  let text = String(author ?? "")
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ");
  while (/\{\{|\}\}/.test(text)) text = text.replace(/\{\{|\}\}/g, "");
  return Array.from(text.trim()).slice(0, AUTHOR_MAX).join("").trim();
}

const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const TEAM_KEY = /^[A-Za-z][A-Za-z0-9]*$/;
function linearPrompt(template, issue, comment, workspace) {
  const keyed = ISSUE_KEY.test(String(issue.key ?? ""));
  const url = keyed ? linearIssueUrl(issue.url, issue.key, workspace) : null;
  const name = keyed ? `Linear issue ${issue.key}` : "Linear issue";
  const values = {
    "issue.key": issue.key,
    "issue.title": issue.title,
    "issue.description": issue.description,
    "issue.url": url ?? issue.url,
    "issue.labels": (issue.labels ?? []).join(", "),
    "issue.state": issue.state,
    "issue.team": issue.team,
    "issue.assignee": issue.assignee,
  };
  const untrusted = {
    "issue.title": `${name} title`,
    "issue.description": `${name} description`,
    "issue.labels": `${name} labels`,
    "issue.assignee": `${name} assignee`,
    "issue.state": `${name} state`,
    ...(url ? {} : { "issue.url": `${name} url` }),
    ...(keyed ? {} : { "issue.key": `${name} key` }),
    ...(TEAM_KEY.test(String(issue.team ?? "")) ? {} : { "issue.team": `${name} team` }),
  };
  if (comment) {
    Object.assign(values, { "comment.body": comment.body, "comment.author": comment.author });
    Object.assign(untrusted, {
      "comment.author": keyed ? `Linear comment author on ${issue.key}` : "Linear comment author",
      "comment.body": keyed ? `Linear comment on ${issue.key}` : "Linear comment",
    });
  }
  return renderRoutinePrompt(template, values, untrusted);
}

function schedulePrompt(template, at, timezone) {
  const [date, time] = clock(at, timezone, true).split(" ");
  return renderRoutinePrompt(template, { date, time });
}

const claimedSettings = (routine) => ({ provider: routine.provider, model: routine.model, permissionMode: routine.permissionMode });
const fallbackSettings = (routine, fallback) => ({
  provider: fallback.provider,
  model: fallback.model,
  ...(fallback.effort ? { effort: fallback.effort } : {}),
  permissionMode: routine.permissionMode,
});
const sameModel = (a, b) => a.provider === b.provider && a.model === b.model;

function createRoutineScheduler({
  store,
  chats,
  now = Date.now,
  setInterval: setTimer = setInterval,
  clearInterval: clearTimer = clearInterval,
  onChange = () => {},
  flowActions = {},
}) {
  const flows = createFlowRunner({ store, chats, actions: flowActions, now, onChange: () => onChange() });
  let flowsResumed = false;
  const pending = new Map();
  let timer = null;
  let ticking = false;
  let swept = false;
  let recovered = false;
  const background = new Set();
  const track = (work) => {
    background.add(work);
    void work.finally(() => background.delete(work));
  };
  let comments = Promise.resolve();
  let stopped = false;
  const lookupWarned = new Set();
  const silenced = new Set();

  const signature = () =>
    store
      .list()
      .map((routine) => `${routine.id}:${routine.enabled}:${routine.nextRunAt}`)
      .join(",");

  function finish(run, chatId, outcome) {
    return store.finishRun(run.id, { chatId, ...outcome });
  }

  const failedAgain = (routine) => (routine?.failedStreak ?? 0) >= 2;

  function chatGone(chatId) {
    return !chats.exists(chatId) || chats.archived(chatId);
  }

  function sweepGone() {
    for (const routine of store.list()) {
      if (routine.target.kind !== "chat" || !chatGone(routine.target.chatId)) continue;
      store.complete(routine.id, "chat gone");
    }
  }

  function scheduleAllows(routine, run) {
    const chatId = routine.target.chatId;
    if (routine.maxRuns !== undefined && routine.runCount >= routine.maxRuns) {
      store.complete(routine.id, "max runs");
      finish(run, chatId, { status: "skipped-busy" });
      return false;
    }
    if (store.runs(routine.id).some((item) => item.status === "running" && item.id !== run.id)) {
      finish(run, chatId, { status: "skipped-busy" });
      return false;
    }
    return true;
  }

  async function deliver(chatId, entry, message) {
    let started;
    try {
      ({ started } = await chats.send(chatId, message));
      entry.sent = true;
    } catch (error) {
      if (pending.get(chatId) === entry) pending.delete(chatId);
      if (error?.busy && entry.comment) store.deferRun(entry.runId, now() + COMMENT_RETRY_MS);
      else if (error?.busy && !entry.newChat) finish({ id: entry.runId }, chatId, { status: "skipped-busy" });
      else if (retries(entry, errorText(error))) await retry(chatId, entry, errorText(error));
      else {
        finish({ id: entry.runId }, chatId, { status: "failed", error: errorText(error) });
        if (entry.newChat) leave(chatId, entry, false);
      }
      return;
    }
    Promise.resolve(started).then(
      (result) => {
        if (result?.turnId) entry.turnId ??= result.turnId;
        if (result?.steered) release(chatId, entry, BUSY);
        else if (!result?.turnId) release(chatId, entry, "turn did not start");
        return null;
      },
      (error) => release(chatId, entry, errorText(error)),
    );
  }

  async function beat(routine, run) {
    const chatId = routine.target.chatId;
    if (chatGone(chatId)) {
      store.complete(routine.id, "chat gone");
      finish(run, chatId, { status: "failed", error: "chat gone" });
      return;
    }
    if (pending.has(chatId) || chats.busy(chatId)) {
      finish(run, chatId, { status: "skipped-busy" });
      return;
    }
    const entry = { runId: run.id, sent: false, turnStarted: false };
    pending.set(chatId, entry);
    const at = now();
    const context = { kind: "routine-run", routineId: routine.id, runId: run.id, name: routine.name, at };
    const body = schedulePrompt(routine.prompt, at, routine.trigger.timezone);
    await deliver(chatId, entry, { body, prompt: body + PASS_HINT, context, settings: claimedSettings(routine) });
  }

  async function runInNewChat(routine, run) {
    let chat;
    try {
      chat = await chats.startChat({ routine, run });
    } catch (error) {
      finish(run, undefined, { status: "failed", error: errorText(error) });
      return;
    }
    const { chatId, worktreeId, createdWorktree, body, prompt, context } = chat;
    const removeWorktree = createdWorktree === true;
    if (!store.attachChat(run.id, { chatId, worktreeId })) {
      archive(chatId, removeWorktree);
      return;
    }
    const message = { body, prompt: prompt + PASS_HINT, context };
    const entry = { runId: run.id, sent: false, turnStarted: false, newChat: true, createdWorktree: removeWorktree, chatIds: [chatId], routine, message };
    pending.set(chatId, entry);
    await deliver(chatId, entry, { ...message, settings: claimedSettings(routine) });
  }

  const retries = (entry, error, event) => Boolean(entry.newChat && entry.routine && !entry.retried && !stopped && providerFailure(error, event));

  async function retry(chatId, entry, error) {
    const { routine, message } = entry;
    const projectPath = routine.target.projectPath;
    let ran = null;
    try {
      ran = chats.ranOn?.(chatId) ?? null;
    } catch {}
    const tried = { provider: ran?.provider ?? routine.provider, model: ran?.model ?? routine.model, effort: ran?.effort };
    let fallback = routine.fallback ?? null;
    if (!fallback) {
      try {
        fallback = (await chats.fallbackFor?.({ provider: tried.provider, projectPath })) ?? null;
      } catch (failure) {
        console.warn("[routines] couldn't pick a fallback model", failure);
      }
    }
    if (!fallback?.provider || !fallback.model || (tried.provider && tried.model && sameModel(tried, fallback)) || stopped) {
      finishFailed(chatId, entry, error);
      return;
    }
    let retried;
    try {
      retried = store.retryRun(entry.runId, { error, ...tried, fallback });
    } catch (failure) {
      console.warn("[routines] couldn't record a Run's retry", failure);
    }
    if (!retried) {
      finishFailed(chatId, entry, error);
      return;
    }
    onChange();
    let chat;
    try {
      chat = await chats.retryChat({ routine, run: retried, chatId });
    } catch (failure) {
      finish({ id: entry.runId }, chatId, { status: "failed", error: `${error} · retry on ${fallback.model} didn't start: ${errorText(failure)}` });
      leave(chatId, entry, false);
      return;
    }
    if (!store.attachChat(entry.runId, { chatId: chat.chatId, worktreeId: chat.worktreeId })) {
      archive(chat.chatId, chat.createdWorktree === true);
      return;
    }
    const next = {
      ...entry,
      sent: false,
      turnStarted: false,
      turnId: undefined,
      retried: true,
      createdWorktree: entry.createdWorktree || chat.createdWorktree === true,
      chatIds: [...entry.chatIds, chat.chatId],
    };
    pending.set(chat.chatId, next);
    await deliver(chat.chatId, next, { ...message, settings: fallbackSettings(routine, fallback) });
  }

  function finishFailed(chatId, entry, error) {
    finish({ id: entry.runId }, chatId, { status: "failed", error });
    if (entry.newChat) leave(chatId, entry, false);
    onChange();
  }

  function startRetry(chatId, entry, error) {
    track(
      retry(chatId, entry, error)
        .then(() => onChange())
        .catch((failure) => {
          console.warn("[routines] retry failed", failure);
          finish({ id: entry.runId }, chatId, { status: "failed", error });
          onChange();
        }),
    );
  }

  async function deliverComment(routine, run) {
    const { issue, comment } = run.event;
    let chatId;
    try {
      chatId = await chats.linkedChat({ key: issue.key, workspace: issue.workspace });
    } catch (error) {
      if (!lookupWarned.has(run.event.key)) {
        lookupWarned.add(run.event.key);
        console.warn("[routines] couldn't find a comment's Chat; it waits and tries again", error);
      }
      store.deferRun(run.id, now() + COMMENT_RETRY_MS);
      return;
    }
    lookupWarned.delete(run.event.key);
    if (stopped) {
      store.deferRun(run.id, now());
      return;
    }
    const current = store.get(routine.id);
    if (!current || !current.enabled || current.completedAt) {
      finish(run, undefined, { status: "skipped-busy", error: "Routine was turned off" });
      return;
    }
    if (!chatId) {
      finish(run, undefined, { status: "skipped-busy", error: NO_CHAT });
      return;
    }
    if (pending.has(chatId) || chats.busy(chatId)) {
      store.deferRun(run.id, now() + COMMENT_RETRY_MS);
      return;
    }
    const author = authorName(comment.author);
    const text = linearPrompt(routine.prompt, issue, comment, routine.trigger.workspace);
    const entry = { runId: run.id, sent: false, turnStarted: false, comment: true };
    pending.set(chatId, entry);
    const label = author ? `Linear comment · ${author}` : "Linear comment";
    const context = { kind: "routine-run", routineId: routine.id, runId: run.id, name: routine.name, at: now(), label };
    await deliver(chatId, entry, { body: text, prompt: text + PASS_HINT, context, settings: claimedSettings(routine) });
  }

  async function deliverPullRequest(routine, run) {
    const chatId = routine.target.chatId;
    if (chatGone(chatId)) {
      store.complete(routine.id, "chat gone");
      finish(run, chatId, { status: "failed", error: "chat gone" });
      return;
    }
    const { event } = run;
    const { settings, url, number } = routine.trigger;
    const worktree = await Promise.resolve()
      .then(() => chats.pullRequestWorktree?.(chatId, url))
      .catch(() => null);
    if (stopped) {
      store.deferRun(run.id, now());
      return;
    }
    const current = store.get(routine.id);
    if (!current || !current.enabled || current.completedAt || chatGone(chatId)) {
      finish(run, undefined, { status: "skipped-busy", error: "Routine was turned off" });
      return;
    }
    if (pending.has(chatId) || chats.busy(chatId)) {
      store.deferRun(run.id, now() + COMMENT_RETRY_MS);
      return;
    }
    const headBranch = worktree?.branch ?? null;
    const onBranch = headBranch !== null && headBranch === event.branch;
    const level = effectiveLevel(settings, onBranch);
    const text = babysitPrompt({ settings, event, pr: { url, number }, onBranch, headBranch, routineId: routine.id, worktreeAlias: worktree?.alias });
    const body = `PR #${number} changed:\n${event.summary}`;
    const entry = { runId: run.id, sent: false, turnStarted: false, comment: true };
    pending.set(chatId, entry);
    const context = {
      kind: "routine-run",
      routineId: routine.id,
      runId: run.id,
      name: routine.name,
      at: now(),
      label: `PR #${number}`,
      babysit: { level, resolveThreads: effectiveResolve(settings, level), ...(onBranch ? {} : { offBranch: true }) },
    };
    await deliver(chatId, entry, { body, prompt: text + BABYSIT_PASS_HINT, context, settings: claimedSettings(routine) });
  }

  async function dispatch(routine, run) {
    if (routine.flow) {
      if (!run.event && !scheduleAllows(routine, run)) return;
      await flows.start(routine, run);
      return;
    }
    if (run.event) {
      if (isComment(run.event)) await deliverComment(routine, run);
      else if (isPullRequest(run.event)) await deliverPullRequest(routine, run);
      else await runInNewChat(routine, run);
    } else if (scheduleAllows(routine, run)) {
      if (routine.target.kind === "new-chat") await runInNewChat(routine, run);
      else await beat(routine, run);
    }
  }

  async function dispatchSafely(routine, run) {
    try {
      await dispatch(routine, run);
    } catch (error) {
      console.warn("[routines] dispatch failed", error);
      for (const [chatId, entry] of pending) if (entry.runId === run.id) pending.delete(chatId);
      finish(run, undefined, { status: "failed", error: errorText(error) });
    }
  }

  function release(chatId, entry, error, event) {
    if (pending.get(chatId) !== entry) return;
    pending.delete(chatId);
    if (retries(entry, error, event)) {
      if (event) event.quiet = true;
      startRetry(chatId, entry, error);
      onChange();
      return;
    }
    const routine = finish({ id: entry.runId }, chatId, { status: "failed", error });
    if (entry.newChat) leave(chatId, entry, false);
    if (failedAgain(routine)) {
      if (event) event.quiet = true;
      else if (error !== BUSY) silenced.add(chatId);
    }
    onChange();
  }

  async function dispatchAll(claims) {
    for (const { routine, run } of claims) {
      if (isComment(run.event) || isPullRequest(run.event)) {
        comments = comments
          .then(() => {
            if (stopped) return store.deferRun(run.id, now());
            return dispatchSafely(routine, run);
          })
          .then(() => onChange())
          .catch((error) => console.warn("[routines] dispatch failed", error));
        continue;
      }
      if (startsChat(routine, run)) {
        track(
          dispatchSafely(routine, run)
            .then(() => onChange())
            .catch((error) => console.warn("[routines] dispatch failed", error)),
        );
        continue;
      }
      try {
        await dispatchSafely(routine, run);
      } catch (error) {
        console.warn("[routines] dispatch failed", error);
      }
    }
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const before = signature();
      const at = now();
      store.expireDue(at);
      const claims = [...store.claimDue(at), ...store.claimQueued(at, CONCURRENT_RUNS)];
      await dispatchAll(claims);
      await flows.tick();
      if (!swept) {
        swept = true;
        sweepGone();
      }
      if (claims.length > 0 || signature() !== before) onChange();
    } finally {
      ticking = false;
    }
  }

  function recover() {
    if (recovered) return;
    recovered = true;
    store.recoverInterrupted();
    swept = true;
    sweepGone();
  }

  function start() {
    recover();
    stopped = false;
    if (!flowsResumed) {
      flowsResumed = true;
      flows.resume();
    }
    if (timer) return;
    timer = setTimer(() => {
      tick().catch((error) => console.warn("[routines] tick failed", error));
    }, TICK_MS);
    timer.unref?.();
  }

  function stop() {
    stopped = true;
    if (!timer) return;
    clearTimer(timer);
    timer = null;
  }

  function patchContext(chatId, runId, patch, session) {
    try {
      return Promise.resolve(chats.patchRunContext(chatId, runId, patch, session)).catch((error) => console.warn("[routines] patchRunContext failed", error));
    } catch (error) {
      console.warn("[routines] patchRunContext failed", error);
      return Promise.resolve();
    }
  }

  function nameRun(chatId, runId, options) {
    try {
      track(Promise.resolve(chats.nameRun(chatId, runId, options)).catch((error) => console.warn("[routines] nameRun failed", error)));
    } catch (error) {
      console.warn("[routines] nameRun failed", error);
    }
  }

  function archive(chatId, removeWorktree, after = Promise.resolve()) {
    track(after.then(() => chats.archive(chatId, { removeWorktree })).catch((error) => console.warn("[routines] archive failed", error)));
  }

  /**
   * A Run in a Chat of its own has ended, however it ended, once `after` (its divider's patch) settles. A quiet one leaves
   * nothing to read, so its Chat is archived. Then the Worktree the Run made goes when it left nothing behind (no changes,
   * no commits off its base or upstream, no open PR): the adapter's retireWorktree keeps the Run's Chat, archived and
   * readable from the Run's history, and keeps the Worktree whenever any of that doesn't hold.
   */
  function leave(chatId, entry, quiet, after = Promise.resolve()) {
    track(
      after
        .then(async () => {
          if (quiet) await chats.archive(chatId, { removeWorktree: false });
          if (entry.createdWorktree) await chats.retireWorktree?.(entry.chatIds ?? [chatId]);
          return null;
        })
        .catch((error) => console.warn("[routines] couldn't tidy up after a Run", error)),
    );
  }

  function observe(chatId, event) {
    if (flows.observe(chatId, event)) return;
    if (silenced.has(chatId)) {
      if (event.type === "message-sent" || event.type === "turn-started") silenced.delete(chatId);
      else if (isTurnEnd(event) && event.type !== "turn-completed") {
        silenced.delete(chatId);
        event.quiet = true;
      }
    }
    const entry = pending.get(chatId);
    if (!entry) return;
    if (event.type === "message-sent") {
      if (event.routineRunId === entry.runId) entry.sent = true;
      return;
    }
    if (event.type === "turn-started") {
      if (!entry.sent || (entry.turnId && event.turnId && event.turnId !== entry.turnId)) return;
      entry.turnStarted = true;
      entry.turnId ??= event.turnId;
      return;
    }
    if (!isTurnEnd(event)) return;
    if (!entry.turnStarted) {
      if (entry.sent && event.type !== "turn-completed")
        release(chatId, entry, event.type === "turn-failed" ? (event.message ?? "turn failed") : "cancelled", event);
      return;
    }
    pending.delete(chatId);
    const run = { id: entry.runId };
    let quiet = false;
    let summary;
    if (event.type === "turn-completed") {
      const pass = parsePass(chats.replyText(chatId));
      if (pass.quiet) {
        quiet = true;
        summary = pass.summary;
        event.quiet = true;
        if (finish(run, chatId, { status: "quiet", summary })) nameRun(chatId, entry.runId, { quietSummary: summary });
      } else if (finish(run, chatId, { status: "acted" })) {
        nameRun(chatId, entry.runId, {});
      }
    } else {
      const error = event.type === "turn-failed" ? (event.message ?? "turn failed") : "cancelled";
      if (retries(entry, error, event)) {
        event.quiet = true;
        startRetry(chatId, entry, error);
        onChange();
        return;
      } else if (failedAgain(finish(run, chatId, { status: "failed", error }))) {
        event.quiet = true;
      }
    }
    const session = event.markedUnread ? { unread: false } : undefined;
    const patched = quiet ? patchContext(chatId, entry.runId, { quiet, summary }, session) : patchContext(chatId, entry.runId, { quiet });
    if (entry.newChat) leave(chatId, entry, quiet, patched);
    onChange();
  }

  function chatEnded(chatId, reason) {
    let completed = false;
    for (const routine of store.list()) {
      if (routine.target.kind !== "chat" || routine.target.chatId !== chatId) continue;
      store.complete(routine.id, reason);
      completed = true;
    }
    if (completed) onChange();
  }

  function enqueueEvents(items) {
    const results = store.enqueueMany(items);
    if (results.some((result) => result.queued || result.reason === "full" || result.reason === "too-many")) onChange();
    return results;
  }

  function enqueueEvent(routineId, event) {
    return enqueueEvents([{ routineId, event }])[0];
  }

  async function runNow(routineId) {
    const routine = store.get(routineId);
    if (routine && !routine.completedAt && routine.trigger.kind === "pull-request") throw new Error(RUN_NOW_BABYSIT);
    if (routine && !routine.completedAt && routine.trigger.kind !== "schedule") throw new Error(RUN_NOW_EVENTS);
    const started = store.startRun(routineId, now());
    if (!started) throw new Error(`Routine not found or completed: ${routineId}`);
    await dispatchSafely(started.routine, started.run);
    onChange();
    return store.runs(routineId).find((item) => item.id === started.run.id);
  }

  return {
    recover,
    idle: async ({ background: andBackground = true } = {}) => {
      await comments;
      if (!andBackground) return;
      while (background.size) await Promise.allSettled(background);
      await flows.idle();
    },
    start,
    stop,
    tick,
    observe,
    chatArchived: (chatId) => chatEnded(chatId, "chat archived"),
    chatDone: (chatId) => chatEnded(chatId, "chat done"),
    runNow,
    enqueueEvent,
    enqueueEvents,
    flowAct: (runId, action, options) => flows.act(runId, action, options),
    flowTest: (routineId) => flows.test(routineId),
    flowOutput: (chatId, value) => flows.recordOutput(chatId, value),
    runsFlowStep: (chatId) => flows.runsStep(chatId),
  };
}

module.exports = { createRoutineScheduler, linearPrompt, schedulePrompt };
