const { isTurnEnd } = require("@milagre/shared/agent-runs");
const { clock, parsePass } = require("@milagre/shared/routines");
const { renderRoutinePrompt } = require("@milagre/shared/routine-prompt");
const { linearIssueUrl } = require("@milagre/shared/linear-issue");
const { providerFailure } = require("./fallback.cjs");
const { BABYSIT_PASS_HINT, babysitPrompt, effectiveLevel, effectiveResolve } = require("./babysit-prompt.cjs");

const TICK_MS = 1000;
const BUSY = "chat was busy";
const PASS_HINT = '\n\nIf nothing needs doing, reply starting with "(pass)" and a short reason.';
// The Runs of one Linear or webhook Routine going at once; its other events wait in its queue (store.cjs).
const CONCURRENT_RUNS = 3;
// How long a comment whose Chat is busy waits before it tries again.
const COMMENT_RETRY_MS = 15_000;
const NO_CHAT = "issue has no Chat";
const RUN_NOW_EVENTS = "Run now works for schedules and Heartbeats";
const RUN_NOW_BABYSIT = "A babysit Routine runs when its PR changes";
const AUTHOR_MAX = 80;

const errorText = (error) => error?.message ?? String(error);

const isComment = (event) => event?.kind === "linear" && event.change === "comment";
const isPullRequest = (event) => event?.kind === "pull-request";
// Whether a claimed Run makes a Chat: a trigger's (a comment and a pull-request event go into a Chat that exists), or a
// schedule's with a new-chat target.
const startsChat = (routine, run) => (run.event ? !isComment(run.event) && !isPullRequest(run.event) : routine.target.kind === "new-chat");

// Characters that show nothing or turn text around: zero-width spaces and joiners, direction marks and overrides,
// isolates, the BOM and soft hyphens.
const INVISIBLE = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

// A comment's author as its divider names them: one line, nothing invisible, no {{ or }}, at most 80 characters. Empty
// when nothing is left.
function authorName(author) {
  let text = String(author ?? "")
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ");
  // Taking out one pair of braces can bring two single ones together.
  while (/\{\{|\}\}/.test(text)) text = text.replace(/\{\{|\}\}/g, "");
  return Array.from(text.trim()).slice(0, AUTHOR_MAX).join("").trim();
}

// Linear's identifiers, as they look: an issue key (MIL-1) and a team key (MIL). Anything else is treated as text.
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const TEAM_KEY = /^[A-Za-z][A-Za-z0-9]*$/;
/**
 * A Linear Run's message: the Routine's prompt with the issue's fields filled in, and a comment's when there is one.
 * Everything people wrote in Linear (the title, description, labels, state name, assignee, author and comment) reaches the
 * agent fenced as data, however short. Only identifiers go in as they are: the key and team key when they look like
 * Linear's, and the URL up to the key when it is in the Routine's `workspace`. A source label names the issue only by a
 * key that looks like one.
 */
function linearPrompt(template, issue, comment, workspace) {
  const keyed = ISSUE_KEY.test(String(issue.key ?? ""));
  // The URL up to the key, in the Routine's workspace; anything after the key is text anyone renaming the issue writes.
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
    // A workflow state's name is text a Linear admin can set to anything.
    "issue.state": `${name} state`,
    // An identifier that doesn't look like one is data like the rest.
    ...(url ? {} : { "issue.url": `${name} url` }),
    ...(keyed ? {} : { "issue.key": `${name} key` }),
    ...(TEAM_KEY.test(String(issue.team ?? "")) ? {} : { "issue.team": `${name} team` }),
  };
  if (comment) {
    Object.assign(values, { "comment.body": comment.body, "comment.author": comment.author });
    Object.assign(untrusted, {
      "comment.author": keyed ? `Linear comment author on ${issue.key}` : "Linear comment author",
      // The author's name is fenced where {{comment.author}} puts it, never written into a label beside the instructions.
      "comment.body": keyed ? `Linear comment on ${issue.key}` : "Linear comment",
    });
  }
  return renderRoutinePrompt(template, values, untrusted);
}

// A schedule's message: the Routine's prompt with {{date}} and {{time}} filled in on the trigger's clock at `at`, the same
// for a heartbeat's beat and a Run in a Chat of its own.
function schedulePrompt(template, at, timezone) {
  const [date, time] = clock(at, timezone, true).split(" ");
  return renderRoutinePrompt(template, { date, time });
}

// What a Run executes on, as its Routine said when the Run was claimed (the claim's copy): an edit since never reaches it.
const claimedSettings = (routine) => ({ provider: routine.provider, model: routine.model, permissionMode: routine.permissionMode });
// A retry's: the fallback's provider, model and effort, in the Routine's permission mode.
const fallbackSettings = (routine, fallback) => ({
  provider: fallback.provider,
  model: fallback.model,
  ...(fallback.effort ? { effort: fallback.effort } : {}),
  permissionMode: routine.permissionMode,
});
const sameModel = (a, b) => a.provider === b.provider && a.model === b.model;

/**
 * Starts each Routine's Runs and records how their turns went. A heartbeat's beat goes into its Chat; a trigger's Run (and a
 * schedule's with a new-chat target) starts a Chat of its own; a Linear comment goes into the Chat linked to its issue.
 * `chats` is the adapter the runtime builds: exists, archived, busy (a turn open, preparing, or an approval or question
 * pending), send (resolves once the message is accepted, with a `started` promise for the turn), replyText,
 * patchRunContext, startChat (makes a Run's Chat, in a new Worktree or the Project folder, and words its first message),
 * archive, linkedChat (the Chat a Linear issue's comments go into, or null), headBranch (the branch checked out in a Chat's
 * Worktree, or null) and nameRun (titles an acted or quiet Run once
 * it has ended, and a Run's own Chat with it; `{ quietSummary }` for a quiet one). For a Run's retry, `ranOn(chatId)` is
 * the provider, model and effort its Chat's turn ran on (or null), `fallbackFor({ provider, projectPath })` the model to
 * retry on when the Routine names none (or null), and `retryChat({ routine, run, chatId })` makes the retry's Chat beside
 * the failed one (in its Worktree when it is still there).
 */
function createRoutineScheduler({
  store,
  chats,
  now = Date.now,
  setInterval: setTimer = setInterval,
  clearInterval: clearTimer = clearInterval,
  onChange = () => {},
}) {
  // chatId -> the Run in flight there. `sent` flips on its message-sent, `turnStarted` on turn-started; a turn's end only
  // classifies the Run after both. `newChat` marks a Chat the Run started itself, which a quiet end archives.
  const pending = new Map();
  let timer = null;
  let ticking = false;
  let swept = false;
  let recovered = false;
  // Work going on off the tick (a Run's Chat being made, a quiet Run's Chat being archived), so idle() can wait for it.
  const background = new Set();
  const track = (work) => {
    background.add(work);
    void work.finally(() => background.delete(work));
  };
  // The comments going out, one after another (see dispatchAll), and whether the scheduler was stopped since.
  let comments = Promise.resolve();
  let stopped = false;
  // The comments whose failed Chat lookup was logged, by event key: a comment retried every 15 s is logged once.
  const lookupWarned = new Set();
  // Chats whose beat failed to start again, its turn end not yet published: that end is marked quiet when it comes.
  const silenced = new Set();

  // What the UI lists of the Routines that a tick can change without a claim: which there are, which are on, and when each
  // runs next (a slot missed while the Mac slept moves it, and leaves a missed Run).
  const signature = () =>
    store
      .list()
      .map((routine) => `${routine.id}:${routine.enabled}:${routine.nextRunAt}`)
      .join(",");

  // Resolves with the Routine as the Run left it, or null when the Run was already finished.
  function finish(run, chatId, outcome) {
    return store.finishRun(run.id, { chatId, ...outcome });
  }

  // A failed beat right after another failed beat tells no one: the first failure was announced (store.cjs ends the
  // heartbeat on the third, and pauses a trigger).
  const failedAgain = (routine) => (routine?.failedStreak ?? 0) >= 2;

  function chatGone(chatId) {
    return !chats.exists(chatId) || chats.archived(chatId);
  }

  // Heartbeats whose Chat is gone or archived end; nothing will ever answer them.
  function sweepGone() {
    for (const routine of store.list()) {
      if (routine.target.kind !== "chat" || !chatGone(routine.target.chatId)) continue;
      store.complete(routine.id, "chat gone");
    }
  }

  // A schedule Routine never has two Runs at once, and one whose maxRuns was lowered to what it already ran ends instead of
  // running again. Either way the Run just claimed is skipped-busy, which doesn't count.
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

  // Sends a Run's message into `chatId`, whose pending `entry` is already set, and leaves the Run to the turn it starts.
  async function deliver(chatId, entry, message) {
    let started;
    try {
      ({ started } = await chats.send(chatId, message));
      // The message is saved: whatever starts in the Chat now is the Run's turn (or steers into it).
      entry.sent = true;
    } catch (error) {
      if (pending.get(chatId) === entry) pending.delete(chatId);
      // The Chat got busy as the message was about to go (the adapter checks again as it is saved): a comment waits as
      // it does for a busy Chat, and a beat is skipped, uncounted, as it would have been a moment earlier.
      if (error?.busy && entry.comment) store.deferRun(entry.runId, now() + COMMENT_RETRY_MS);
      else if (error?.busy && !entry.newChat) finish({ id: entry.runId }, chatId, { status: "skipped-busy" });
      else if (retries(entry, errorText(error))) await retry(chatId, entry, errorText(error));
      else {
        finish({ id: entry.runId }, chatId, { status: "failed", error: errorText(error) });
        if (entry.newChat) leave(chatId, entry, false);
      }
      return;
    }
    // No turn of the Run's own will end it: a start that failed or was stopped resolves without a turn id, and a message
    // steered into a turn already running belongs to that turn, which isn't the Run's to classify.
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

  // A Run in a Chat of its own. The adapter makes the Chat from the Routine as it was when the Run was claimed, and words
  // its first message.
  async function runInNewChat(routine, run) {
    let chat;
    try {
      chat = await chats.startChat({ routine, run });
    } catch (error) {
      // store.cjs pauses the trigger on the third failure in a row.
      finish(run, undefined, { status: "failed", error: errorText(error) });
      return;
    }
    const { chatId, worktreeId, createdWorktree, body, prompt, context } = chat;
    const removeWorktree = createdWorktree === true;
    if (!store.attachChat(run.id, { chatId, worktreeId })) {
      // The Routine was deleted while its Chat was being made: nothing runs there, and the Chat goes.
      archive(chatId, removeWorktree);
      return;
    }
    const message = { body, prompt: prompt + PASS_HINT, context };
    const entry = { runId: run.id, sent: false, turnStarted: false, newChat: true, createdWorktree: removeWorktree, chatIds: [chatId], routine, message };
    pending.set(chatId, entry);
    await deliver(chatId, entry, { ...message, settings: claimedSettings(routine) });
  }

  // Whether a failed attempt gets its one retry: a Run in a Chat of its own, on its first attempt, failing for a
  // provider-side reason, while the scheduler runs.
  const retries = (entry, error, event) => Boolean(entry.newChat && entry.routine && !entry.retried && !stopped && providerFailure(error, event));

  /**
   * The one retry of a Run whose attempt in `chatId` failed for a provider-side reason: a new Chat beside it (in the same
   * Worktree when it is still there) gets the same first message, on the Routine's fallback or, when it names none, the
   * model `fallbackFor` picks on another installed provider. The Run keeps the failed attempt (store.cjs retryRun) and
   * goes on running, so it ends, and counts toward the failure streak, once. With no model to retry on, it fails as is.
   */
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

  // Starts a failed attempt's retry off the tick: it may look up models and make a Chat.
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

  // A Linear comment goes into the Chat linked to its issue. A person wrote it, so a busy Chat makes it wait rather than skip
  // it: its Run goes back to the head of the queue, uncounted, and tries again in 15 s (store.cjs gives up after 2 h, and
  // holds the later comments on that issue back meanwhile, so they arrive in order).
  async function deliverComment(routine, run) {
    const { issue, comment } = run.event;
    let chatId;
    try {
      chatId = await chats.linkedChat({ key: issue.key, workspace: issue.workspace });
    } catch (error) {
      // The Chats couldn't be looked up just now: the comment waits and tries again, uncounted, as for a busy Chat (store.cjs
      // gives up after 2 h). Its key is already seen, so failing it would lose it for good.
      if (!lookupWarned.has(run.event.key)) {
        lookupWarned.add(run.event.key);
        console.warn("[routines] couldn't find a comment's Chat; it waits and tries again", error);
      }
      store.deferRun(run.id, now() + COMMENT_RETRY_MS);
      return;
    }
    lookupWarned.delete(run.event.key);
    // Stopped while the Chat was looked up: back to the queue for next time.
    if (stopped) {
      store.deferRun(run.id, now());
      return;
    }
    // The Routine may have been turned off or deleted while its Chat was looked up.
    const current = store.get(routine.id);
    if (!current || !current.enabled || current.completedAt) {
      finish(run, undefined, { status: "skipped-busy", error: "Routine was turned off" });
      return;
    }
    if (!chatId) {
      // A comment on an issue no Chat works on isn't for this Routine: skipped, so it never counts as a failure.
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

  // A watched PR's change goes into the Routine's own Chat, in the babysit prompt. Like a comment it waits for a busy Chat
  // rather than being skipped (store.cjs keeps a pull-request Run to one at a time, and its events in order). It goes at
  // the level the setting says only while the Chat's Worktree is on the PR's branch; anywhere else it only reports.
  async function deliverPullRequest(routine, run) {
    const chatId = routine.target.chatId;
    if (chatGone(chatId)) {
      store.complete(routine.id, "chat gone");
      finish(run, chatId, { status: "failed", error: "chat gone" });
      return;
    }
    const { event } = run;
    let headBranch = null;
    try {
      headBranch = (await chats.headBranch?.(chatId)) ?? null;
    } catch {
      // A branch that can't be read is a Worktree that isn't known to be on the PR's: report only.
    }
    // Stopped while the branch was read: back to the queue for next time.
    if (stopped) {
      store.deferRun(run.id, now());
      return;
    }
    // The Routine may have been turned off or deleted, or its Chat archived, meanwhile.
    const current = store.get(routine.id);
    if (!current || !current.enabled || current.completedAt || chatGone(chatId)) {
      finish(run, undefined, { status: "skipped-busy", error: "Routine was turned off" });
      return;
    }
    if (pending.has(chatId) || chats.busy(chatId)) {
      store.deferRun(run.id, now() + COMMENT_RETRY_MS);
      return;
    }
    const { settings, url, number } = routine.trigger;
    const onBranch = headBranch !== null && headBranch === event.branch;
    const level = effectiveLevel(settings, onBranch);
    const text = babysitPrompt({ settings, event, pr: { url, number }, onBranch, headBranch, routineId: routine.id });
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
    if (run.event) {
      if (isComment(run.event)) await deliverComment(routine, run);
      else if (isPullRequest(run.event)) await deliverPullRequest(routine, run);
      else await runInNewChat(routine, run);
    } else if (scheduleAllows(routine, run)) {
      if (routine.target.kind === "new-chat") await runInNewChat(routine, run);
      else await beat(routine, run);
    }
  }

  // Whatever a dispatch didn't see coming ends its Run, which would otherwise hold its slot until the daemon restarts.
  async function dispatchSafely(routine, run) {
    try {
      await dispatch(routine, run);
    } catch (error) {
      console.warn("[routines] dispatch failed", error);
      for (const [chatId, entry] of pending) if (entry.runId === run.id) pending.delete(chatId);
      finish(run, undefined, { status: "failed", error: errorText(error) });
    }
  }

  // Ends a pending Run that no turn end will finish. `event` is the turn end that says so, when one did.
  function release(chatId, entry, error, event) {
    if (pending.get(chatId) !== entry) return;
    pending.delete(chatId);
    if (retries(entry, error, event)) {
      // The retry speaks for the Run: the failed attempt's end tells no one.
      if (event) event.quiet = true;
      startRetry(chatId, entry, error);
      onChange();
      return;
    }
    const routine = finish({ id: entry.runId }, chatId, { status: "failed", error });
    if (entry.newChat) leave(chatId, entry, false);
    if (failedAgain(routine)) {
      if (event) event.quiet = true;
      // A beat that steered into someone else's turn has no turn end of its own to silence.
      else if (error !== BUSY) silenced.add(chatId);
    }
    onChange();
  }

  async function dispatchAll(claims) {
    for (const { routine, run } of claims) {
      if (isComment(run.event) || isPullRequest(run.event)) {
        // Finding a comment's Chat reads every Project, and a babysit Run reads its Worktree's branch, so both go out off the
        // tick, one after another in the order they were claimed (comments on one issue, and one PR's events, arrive in
        // order), and a heartbeat never waits on that.
        comments = comments
          .then(() => {
            // Stopped meanwhile (Routines off, Milagre closing): the comment goes back to its queue for next time.
            if (stopped) return store.deferRun(run.id, now());
            return dispatchSafely(routine, run);
          })
          .then(() => onChange())
          .catch((error) => console.warn("[routines] dispatch failed", error));
        continue;
      }
      if (startsChat(routine, run)) {
        // Making a Chat can take a while (a Worktree, a fetch), so it holds up neither the tick nor the other Routines. It
        // says when it's done: the Run has its Chat, or failed.
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
      // Schedule Runs, then the events waiting in each trigger's queue, three Runs at most going per Routine.
      const claims = [...store.claimDue(at), ...store.claimQueued(at, CONCURRENT_RUNS)];
      await dispatchAll(claims);
      // A tick before start() does start's sweep, after its claims so a due beat still records its Run.
      if (!swept) {
        swept = true;
        sweepGone();
      }
      // Expiry, a missed slot, a gone Chat or a used-up Routine whose queue the claim ended change the list without a claim.
      if (claims.length > 0 || signature() !== before) onChange();
    } finally {
      ticking = false;
    }
  }

  // Once per daemon start: Runs a stop cut short fail (store.cjs), and heartbeats whose Chat is gone end. Never again
  // later, when a Run in flight would be failed with them.
  function recover() {
    if (recovered) return;
    recovered = true;
    store.recoverInterrupted();
    swept = true;
    sweepGone();
  }

  // The tick timer, from the runtime's start until its stop.
  function start() {
    recover();
    stopped = false;
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

  // Resolves once the patch is in, or has failed (logged).
  function patchContext(chatId, runId, patch, session) {
    try {
      return Promise.resolve(chats.patchRunContext(chatId, runId, patch, session)).catch((error) => console.warn("[routines] patchRunContext failed", error));
    } catch (error) {
      console.warn("[routines] patchRunContext failed", error);
      return Promise.resolve();
    }
  }

  // Asks for a Run that has ended to be titled from what it did. Nothing it does reaches the Run, which has its status.
  function nameRun(chatId, runId, options) {
    try {
      track(Promise.resolve(chats.nameRun(chatId, runId, options)).catch((error) => console.warn("[routines] nameRun failed", error)));
    } catch (error) {
      console.warn("[routines] nameRun failed", error);
    }
  }

  // Archives a Chat a Run started, once `after` settles; its Worktree goes too when the Run made it (and, the adapter
  // checks, nothing in it is worth keeping).
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

  // Runs synchronously: it marks the event quiet before the runtime broadcasts it.
  function observe(chatId, event) {
    if (silenced.has(chatId)) {
      if (event.type === "message-sent" || event.type === "turn-started") silenced.delete(chatId);
      else if (isTurnEnd(event) && event.type !== "turn-completed") {
        silenced.delete(chatId);
        event.quiet = true;
      }
    }
    const entry = pending.get(chatId);
    if (!entry) return;
    // Only the Run's own message counts (ChatHost names the Run on its message-sent), and only a turn after it, so a
    // user's turn that starts and ends while the Run's message is on its way is never taken for the Run's.
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
      // A turn end before the beat's message is the Chat's previous turn, published late. One after it, before any
      // turn-started, is the beat's turn failing to start (no agent CLI, Stop while it started).
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
    // A quiet beat takes back only the unread mark its turn's end set (ChatHost marks that end `markedUnread`): a mark
    // already there, or one the user cleared during the beat, is left as it is.
    const session = event.markedUnread ? { unread: false } : undefined;
    const patched = quiet ? patchContext(chatId, entry.runId, { quiet, summary }, session) : patchContext(chatId, entry.runId, { quiet });
    if (entry.newChat) leave(chatId, entry, quiet, patched);
    onChange();
  }

  // A Chat archived or marked Done ends every Heartbeat on it (a Babysit PR one too): its work is over, and a beat would
  // only bring a Done Chat back to the list.
  function chatEnded(chatId, reason) {
    let completed = false;
    for (const routine of store.list()) {
      if (routine.target.kind !== "chat" || routine.target.chatId !== chatId) continue;
      store.complete(routine.id, reason);
      completed = true;
    }
    if (completed) onChange();
  }

  /**
   * Queues Linear or webhook events (`[{ routineId, event }]`) with one store write, and returns what store.cjs
   * `enqueueMany` said about each. The next tick, within a second, starts their Runs where a Routine has a slot free.
   */
  function enqueueEvents(items) {
    const results = store.enqueueMany(items);
    // A full queue (or a Routine with too many events to remember) answers an event with a missed Run, which the UI
    // lists too. One change for the whole batch.
    if (results.some((result) => result.queued || result.reason === "full" || result.reason === "too-many")) onChange();
    return results;
  }

  // One event: `enqueueEvents` with one item.
  function enqueueEvent(routineId, event) {
    return enqueueEvents([{ routineId, event }])[0];
  }

  async function runNow(routineId) {
    const routine = store.get(routineId);
    if (routine && !routine.completedAt && routine.trigger.kind === "pull-request") throw new Error(RUN_NOW_BABYSIT);
    // A Linear or webhook Run needs the event it answers.
    if (routine && !routine.completedAt && routine.trigger.kind !== "schedule") throw new Error(RUN_NOW_EVENTS);
    const started = store.startRun(routineId, now());
    if (!started) throw new Error(`Routine not found or completed: ${routineId}`);
    await dispatchSafely(started.routine, started.run);
    onChange();
    return store.runs(routineId).find((item) => item.id === started.run.id);
  }

  return {
    recover,
    // Resolves once the comments claimed so far have gone out (or waited) and, unless `background` is false, the Chats
    // being made or archived are done; for tests and an orderly stop.
    idle: async ({ background: andBackground = true } = {}) => {
      await comments;
      if (!andBackground) return;
      while (background.size) await Promise.allSettled(background);
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
  };
}

module.exports = { createRoutineScheduler, linearPrompt, schedulePrompt };
