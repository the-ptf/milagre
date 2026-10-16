const { isTurnEnd } = require("@milagre/shared/agent-runs");
const { parsePass } = require("@milagre/shared/routines");
const { renderRoutinePrompt } = require("@milagre/shared/routine-prompt");

const TICK_MS = 1000;
const BUSY = "chat was busy";
const PASS_HINT = '\n\nIf nothing needs doing, reply starting with "(pass)" and a short reason.';
// The Runs of one Linear or webhook Routine going at once; its other events wait in its queue (store.cjs).
const CONCURRENT_RUNS = 3;
// How long a comment whose Chat is busy waits before it tries again.
const COMMENT_RETRY_MS = 15_000;
const NO_CHAT = "issue has no Chat";
const RUN_NOW_EVENTS = "Run now works for schedules and heartbeats";
const AUTHOR_MAX = 80;

const errorText = (error) => error?.message ?? String(error);
const isComment = (event) => event?.kind === "linear" && event.change === "comment";
// Whether a claimed Run makes a Chat: a trigger's, or a schedule's with a new-chat target.
const startsChat = (routine, run) => (run.event ? !isComment(run.event) : routine.target.kind === "new-chat");

// A comment's author as its divider names them: one line, no {{ or }}, at most 80 characters. Empty when nothing is left.
function authorName(author) {
  let text = String(author ?? "").replace(/\s+/g, " ");
  // Taking out one pair of braces can bring two single ones together.
  while (/\{\{|\}\}/.test(text)) text = text.replace(/\{\{|\}\}/g, "");
  return Array.from(text.trim()).slice(0, AUTHOR_MAX).join("").trim();
}

// A Linear Run's message: the Routine's prompt with the issue's fields filled in, and a comment's when there is one.
// Everything people wrote in Linear (the title, description, labels, assignee, author and comment) reaches the agent as
// data: a block, or inline with its braces and tags made harmless when it is one short line. The key, URL, state and team
// are Linear's own.
function linearPrompt(template, issue, comment, author) {
  const values = {
    "issue.key": issue.key,
    "issue.title": issue.title,
    "issue.description": issue.description,
    "issue.url": issue.url,
    "issue.labels": (issue.labels ?? []).join(", "),
    "issue.state": issue.state,
    "issue.team": issue.team,
    "issue.assignee": issue.assignee,
  };
  const untrusted = {
    "issue.title": `Linear issue ${issue.key} title`,
    "issue.description": `Linear issue ${issue.key} description`,
    "issue.labels": `Linear issue ${issue.key} labels`,
    "issue.assignee": `Linear issue ${issue.key} assignee`,
  };
  if (comment) {
    Object.assign(values, { "comment.body": comment.body, "comment.author": comment.author });
    Object.assign(untrusted, {
      "comment.author": `Linear comment author on ${issue.key}`,
      "comment.body": author ? `Linear comment on ${issue.key} by ${author}` : `Linear comment on ${issue.key}`,
    });
  }
  return renderRoutinePrompt(template, values, untrusted);
}

/**
 * Starts each Routine's Runs and records how their turns went. A heartbeat's beat goes into its Chat; a trigger's Run (and a
 * schedule's with a new-chat target) starts a Chat of its own; a Linear comment goes into the Chat linked to its issue.
 * `chats` is the adapter the runtime builds: exists, archived, busy (a turn open, preparing, or an approval or question
 * pending), send (resolves once the message is accepted, with a `started` promise for the turn and whether the Chat was
 * `unread` before it), replyText, patchRunContext, startChat (makes a Run's Chat, in a new Worktree or the Project folder,
 * and words its first message), archive and linkedChat (the Chat a Linear issue's comments go into, or null).
 */
function createRoutineScheduler({
  store,
  chats,
  keepAwake,
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
  let awake = null;
  // Chats whose beat failed to start again, its turn end not yet published: that end is marked quiet when it comes.
  const silenced = new Set();

  function syncKeepAwake() {
    const active = store.enabled() && store.list().some((routine) => routine.enabled);
    if (active === awake) return;
    awake = active;
    keepAwake.setRoutinesActive(active);
  }

  function changed() {
    syncKeepAwake();
    onChange();
  }

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
      ({ started, unread: entry.unread = false } = await chats.send(chatId, message));
    } catch (error) {
      if (pending.get(chatId) === entry) pending.delete(chatId);
      // The Chat got busy as the message was about to go (the adapter checks again as it is saved): a comment waits as
      // it does for a busy Chat, and a beat is skipped, uncounted, as it would have been a moment earlier.
      if (error?.busy && entry.comment) store.deferRun(entry.runId, now() + COMMENT_RETRY_MS);
      else if (error?.busy && !entry.newChat) finish({ id: entry.runId }, chatId, { status: "skipped-busy" });
      else finish({ id: entry.runId }, chatId, { status: "failed", error: errorText(error) });
      return;
    }
    // No turn of the Run's own will end it: a start that failed or was stopped resolves without a turn id, and a message
    // steered into a turn already running belongs to that turn, which isn't the Run's to classify.
    Promise.resolve(started).then(
      (result) => {
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
    const context = { kind: "routine-run", routineId: routine.id, runId: run.id, name: routine.name, at: now() };
    await deliver(chatId, entry, { body: routine.prompt, prompt: routine.prompt + PASS_HINT, context });
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
    const entry = { runId: run.id, sent: false, turnStarted: false, newChat: true, createdWorktree: removeWorktree };
    pending.set(chatId, entry);
    await deliver(chatId, entry, { body, prompt: prompt + PASS_HINT, context });
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
      finish(run, undefined, { status: "failed", error: errorText(error) });
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
    const text = linearPrompt(routine.prompt, issue, comment, author);
    const entry = { runId: run.id, sent: false, turnStarted: false, comment: true };
    pending.set(chatId, entry);
    const label = author ? `Linear comment · ${author}` : "Linear comment";
    const context = { kind: "routine-run", routineId: routine.id, runId: run.id, name: routine.name, at: now(), label };
    await deliver(chatId, entry, { body: text, prompt: text + PASS_HINT, context });
  }

  async function dispatch(routine, run) {
    if (run.event) {
      if (isComment(run.event)) await deliverComment(routine, run);
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
    const routine = finish({ id: entry.runId }, chatId, { status: "failed", error });
    if (failedAgain(routine)) {
      if (event) event.quiet = true;
      // A beat that steered into someone else's turn has no turn end of its own to silence.
      else if (error !== BUSY) silenced.add(chatId);
    }
    changed();
  }

  async function dispatchAll(claims) {
    for (const { routine, run } of claims) {
      if (startsChat(routine, run)) {
        // Making a Chat can take a while (a Worktree, a fetch), so it holds up neither the tick nor the other Routines. It
        // says when it's done: the Run has its Chat, or failed.
        void dispatchSafely(routine, run)
          .then(changed)
          .catch((error) => console.warn("[routines] dispatch failed", error));
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
      if (!store.enabled()) {
        syncKeepAwake();
        return;
      }
      const before = signature();
      const at = now();
      store.expireDue(at);
      // Schedule Runs, then the events waiting in each trigger's queue, three Runs at most going per Routine.
      const claims = [...store.claimDue(at), ...store.claimQueued(at, CONCURRENT_RUNS)];
      await dispatchAll(claims);
      // The flag may have been off at start(); the first enabled tick then does start's sweep, after its claims so a due beat still records its Run.
      if (!swept) {
        swept = true;
        sweepGone();
      }
      syncKeepAwake();
      // Expiry, a missed slot, a gone Chat or a used-up Routine whose queue the claim ended change the list without a claim.
      if (claims.length > 0 || signature() !== before) onChange();
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (timer) return;
    store.recoverInterrupted();
    if (store.enabled()) {
      swept = true;
      sweepGone();
    }
    syncKeepAwake();
    timer = setTimer(() => {
      tick().catch((error) => console.warn("[routines] tick failed", error));
    }, TICK_MS);
    timer.unref?.();
  }

  function stop() {
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

  // Archives a Chat a Run started, once `after` settles; its Worktree goes too when the Run made it (and, the adapter
  // checks, nothing in it is worth keeping).
  function archive(chatId, removeWorktree, after = Promise.resolve()) {
    void after.then(() => chats.archive(chatId, { removeWorktree })).catch((error) => console.warn("[routines] archive failed", error));
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
    if (event.type === "message-sent") {
      entry.sent = true;
      return;
    }
    if (event.type === "turn-started") {
      entry.turnStarted = true;
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
        finish(run, chatId, { status: "quiet", summary });
      } else {
        finish(run, chatId, { status: "acted" });
      }
    } else if (failedAgain(finish(run, chatId, { status: "failed", error: event.type === "turn-failed" ? event.message : "cancelled" }))) {
      event.quiet = true;
    }
    // A quiet beat leaves the Chat as unread (or not) as it was before it: its turn's end marked it unread.
    const patched = quiet ? patchContext(chatId, entry.runId, { quiet, summary }, { unread: entry.unread }) : patchContext(chatId, entry.runId, { quiet });
    // A quiet Run in a Chat of its own leaves nothing to read there: the Chat is archived once its divider says quiet.
    if (quiet && entry.newChat) archive(chatId, entry.createdWorktree, patched);
    changed();
  }

  function chatArchived(chatId) {
    let completed = false;
    for (const routine of store.list()) {
      if (routine.target.kind !== "chat" || routine.target.chatId !== chatId) continue;
      store.complete(routine.id, "chat archived");
      completed = true;
    }
    if (completed) changed();
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
    // A Linear or webhook Run needs the event it answers.
    if (routine && !routine.completedAt && routine.trigger.kind !== "schedule") throw new Error(RUN_NOW_EVENTS);
    const started = store.startRun(routineId, now());
    if (!started) throw new Error(`Routine not found or completed: ${routineId}`);
    await dispatchSafely(started.routine, started.run);
    changed();
    return store.runs(routineId).find((item) => item.id === started.run.id);
  }

  return { start, stop, tick, observe, chatArchived, runNow, enqueueEvent, enqueueEvents };
}

module.exports = { createRoutineScheduler, linearPrompt };
