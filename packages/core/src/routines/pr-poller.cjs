// Babysit PRs: one timer per live pull-request Routine reads its PR on the Routine's own interval and, only when something
// changed, queues a `pull-request` event through the scheduler. It also ends the Routine when a stop rule holds.
const crypto = require("node:crypto");
const { diffSnapshots } = require("./pull-request-watch.cjs");
const { ghMessage } = require("../pull-request-review.cjs");

const MINUTE_MS = 60_000;
const MAX_DELAY_MS = 15 * MINUTE_MS;

const isComment = (id) => id.startsWith("comment:");
const sha1 = (value) => crypto.createHash("sha1").update(value).digest("hex");
const record = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

// The time is part of the key: the same check failing, passing and failing again is a new change to hand over, and the
// store forgets no key it has seen.
function eventOf(routine, handing, kept, next, at) {
  const { repo, number } = routine.trigger;
  const ids = handing.map((change) => change.id).toSorted();
  const counts = ids.map((id) => kept.attempts[id] ?? 0).join(",");
  return {
    kind: "pull-request",
    key: `pr:${repo}#${number}:${sha1(`${ids.join("\n")}:${counts}:${at}`)}`,
    summary: handing.map((change) => change.text).join("\n"),
    changes: handing,
    branch: next.headRef,
  };
}

/**
 * `read({ repo, number, settings })` resolves the PR's snapshot (see readPullRequestSnapshot) and throws on a gh failure.
 * `onChange` runs when a Routine ended or its lastError changed. `now` is the runtime's clock; it and the timers are
 * injected for tests.
 */
function createPullRequestPoller({
  store,
  scheduler,
  read,
  onChange = () => {},
  now = Date.now,
  setTimeout: setTimer = setTimeout,
  clearTimeout: clearTimer = clearTimeout,
}) {
  // routine id -> { timer, delay, polling }
  const states = new Map();
  let running = false;

  const live = (routine) => Boolean(routine && routine.enabled && !routine.completedAt && routine.trigger.kind === "pull-request");
  const watched = () => (running ? store.list().filter(live) : []);
  const baseOf = (routine) => routine.trigger.settings.intervalMinutes * MINUTE_MS;

  function drop(id) {
    const state = states.get(id);
    if (!state) return;
    clearTimer(state.timer);
    states.delete(id);
  }

  function schedule(id, state, ms) {
    clearTimer(state.timer);
    state.timer = setTimer(() => {
      state.timer = null;
      // pollNow never rejects; returning it lets a test await the poll.
      return pollNow(id);
    }, ms);
    state.timer?.unref?.();
  }

  /** Matches the timers to the live pull-request Routines. Cheap; safe to call often. */
  function sync() {
    const wanted = new Map(watched().map((routine) => [routine.id, routine]));
    for (const id of states.keys()) if (!wanted.has(id)) drop(id);
    for (const id of wanted.keys()) {
      if (states.has(id)) continue;
      const state = { timer: null, delay: null, polling: false };
      states.set(id, state);
      schedule(id, state, 0);
    }
  }

  // The change ids that stand right now: everything wrong with the PR that diffSnapshots would report against a clean one.
  function standing(next, settings) {
    const clean = { ...next, failingChecks: [], mergeable: "MERGEABLE", mergeState: "CLEAN", behindBy: 0 };
    return diffSnapshots(clean, next, settings).changes.filter((change) => !isComment(change.id));
  }

  /**
   * What to hand the agent now, or the reason to stop instead. A comment is handed once. A failing check, a conflict or
   * the branch being behind is handed when it first appears. It is handed again only when it is still there after a Run
   * finished and the PR's head commit moved since it was handed: something was pushed and didn't fix it. That counts as
   * a failed attempt, and the Routine can end after too many. A Run that pushes nothing (Report only, the wrong branch,
   * a problem it can't fix) never wakes the agent again for the same problem. A check keeps its attempts while others
   * are still pending (a push restarts them), so failing again after a push is a repeat too; it starts over only once it
   * passes with nothing pending. A conflict or the branch being behind starts over as soon as it is resolved. A closed
   * PR stops at once; a green one only on a poll with nothing to hand over and nothing handed still waiting or running
   * (`pending`), so the last comments still reach the agent.
   */
  function decide(routine, stored, next, at, pending = false) {
    const settings = routine.trigger.settings;
    const { changes: fresh, stop } = diffSnapshots(stored?.snapshot ?? null, next, settings);
    if (stop === "closed") return { stop };

    const head = next.headOid ?? "";
    // Whether the head commit moved since the change was handed over.
    const pushedSince = (entry) => entry.head !== head;
    const remaining = standing(next, settings);
    const present = new Set(remaining.map((change) => change.id));
    const handed = {};
    const attempts = {};
    for (const [id, entry] of Object.entries(record(stored?.handed))) {
      const kept = present.has(id) || (id.startsWith("check:") && next.pendingChecks > 0);
      if (!kept || !entry || typeof entry !== "object") continue;
      handed[id] = entry;
      if (Number.isFinite(stored?.attempts?.[id])) attempts[id] = stored.attempts[id];
    }

    const handing = [...fresh];
    const ids = new Set(fresh.map((change) => change.id));
    const repeated = [];
    // A change that fails again after a push while its attempts are still kept is a repeat. Failing again on the same
    // commit (someone re-ran the check) is handed over as news but is no attempt of the agent's.
    for (const change of fresh) {
      if (isComment(change.id) || attempts[change.id] === undefined || !pushedSince(handed[change.id])) continue;
      repeated.push(change.id);
      attempts[change.id] += 1;
    }
    for (const change of remaining) {
      const since = handed[change.id];
      if (ids.has(change.id) || since === undefined) continue;
      if (!pushedSince(since)) continue;
      if (routine.lastRunAt === undefined || !(routine.lastRunAt > since.at)) continue;
      handing.push(change);
      repeated.push(change.id);
      attempts[change.id] = (attempts[change.id] ?? 0) + 1;
    }
    const cap = settings.stopAfterFailures;
    if (cap?.on && repeated.some((id) => attempts[id] >= cap.times)) return { stop: "failures" };
    if (stop && handing.length === 0 && !pending) return { stop };

    for (const change of handing) {
      if (isComment(change.id)) continue;
      handed[change.id] = { at, head };
      attempts[change.id] ??= 0;
    }
    return { handing, kept: { snapshot: next, attempts, handed } };
  }

  function setError(routine, message) {
    if ((routine.lastError ?? null) === message) return;
    store.setLastError(routine.id, message);
    onChange();
  }

  async function pollNow(id) {
    const state = states.get(id);
    if (!running || !state || state.polling) return;
    const before = store.get(id);
    if (!live(before)) return void drop(id);
    state.polling = true;
    clearTimer(state.timer);
    state.timer = null;
    const base = baseOf(before);
    const current = () => running && states.get(id) === state;
    try {
      const { repo, number, settings } = before.trigger;
      let next = null;
      try {
        next = await read({ repo, number, settings });
      } catch (error) {
        // Only a failed read is GitHub's trouble: it is shown on the Routine and the next try waits longer.
        if (!current()) return;
        state.delay = Math.min((state.delay ?? base) * 2, Math.max(MAX_DELAY_MS, base));
        console.warn(`[routines] pull request poll of ${id} failed`, error?.message ?? error);
        try {
          setError(store.get(id) ?? before, ghMessage(error));
        } catch (storeError) {
          console.warn("[routines] could not record a pull request poll error", storeError);
        }
      }
      if (next) {
        if (!current()) return;
        state.delay = base;
        try {
          // What happened while the read was out: the Routine may have ended or been deleted.
          const routine = store.get(id);
          if (!live(routine)) return void drop(id);
          const at = now();
          const decision = decide(routine, store.prSnapshot(id), next, at, store.hasPending(id));
          if (decision.stop) {
            // Why it ended, as the Chat's line says it: a closed PR may have merged.
            store.complete(id, decision.stop === "closed" && next.state === "MERGED" ? "merged" : decision.stop);
            drop(id);
            onChange();
            return;
          }
          const { handing, kept } = decision;
          // Handed over before the snapshot moves on: a crash in between hands the same changes over again, perhaps as
          // a second Run (the key holds the time), where the other order would lose them.
          if (handing.length) scheduler.enqueueEvents([{ at, routineId: id, event: eventOf(routine, handing, kept, next, at) }]);
          store.setPrSnapshot(id, kept);
          setError(routine, null);
        } catch (error) {
          // Not GitHub's doing: logged, and the normal schedule goes on.
          console.warn(`[routines] pull request poll of ${id} could not be applied`, error?.message ?? error);
        }
      }
    } finally {
      state.polling = false;
    }
    if (current()) schedule(id, state, state.delay);
  }

  return {
    start() {
      if (running) return;
      running = true;
      sync();
    },
    stop() {
      running = false;
      for (const id of states.keys()) drop(id);
    },
    sync,
    pollNow,
  };
}

module.exports = { createPullRequestPoller };
