// Linear triggers: one poll per signed-in workspace that has an enabled Linear Routine, about every minute, whose changes
// are matched against each of its Routines and queued through the scheduler (see global decision D4 of the Routines plan).
const { POLL_ISSUES, POLL_ISSUES_RESUME, POLL_COMMENTS, ISSUE_HISTORY, isNotFound } = require("../linear/issues.cjs");

const POLL_MS = 60_000;
const MAX_DELAY_MS = 15 * 60_000;
// Each query reaches back this far behind the cursor; the store's per-Routine dedupe drops what was already seen.
const OVERLAP_MS = 5_000;
// Requests one poll of a workspace makes at most, issue, history and comment pages together. What it doesn't get to waits
// for the next poll, which reads on from there.
const REQUEST_BUDGET = 40;
// Comment events a workspace's scan holds before handing them over. A window holding more is narrowed and read again.
const BUFFER_MAX = 1000;
// However long polling was off (the switch, a pause, a sleeping Mac), a poll never reaches back further than this.
const MAX_BACKFILL_MS = 24 * 60 * 60_000;
// A saved cursor this far ahead of the Mac's clock was set while the clock ran ahead, and isn't trusted.
const CLOCK_AHEAD_MS = 5 * 60_000;
// After this many failed polls in a row, the workspace's Routines say why.
const FAILURES_SHOWN = 3;
const FAILURE_MAX = 200;
const SIGN_IN = "Linear sign-in needed";
const SIGNED_OUT = new Set(["revoked", "not-connected"]);
// Snapshots are stored on queue items and Runs, so the text Linear sends is bounded.
const TEXT_MAX = 8_000;
const TITLE_MAX = 300;
const LABELS_MAX = 20;

const lower = (value) => String(value ?? "").toLowerCase();
const time = (value) => {
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : NaN;
};
const cap = (value, max) => {
  const text = typeof value === "string" ? value : "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

// What a Routine shows after failed polls: Linear's message without credentials, long tokens, JSON or query text.
function failureText(error) {
  let text = String(error?.message ?? error ?? "");
  const body = text.search(/[{[]/);
  if (body >= 0) text = text.slice(0, body);
  text = text
    .replace(/\bBearer\s+\S+/gi, "")
    .replace(/\blin_\w+/gi, "")
    .replace(/[\w-]{32,}/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const message = `Linear polling failed: ${text || "Linear answered with an error."}`;
  return message.length > FAILURE_MAX ? `${message.slice(0, FAILURE_MAX - 1)}…` : message;
}

// Tags an error with the scan it broke, so only that scan's held state is dropped.
function inScan(error, scan) {
  if (error && typeof error === "object" && !error.scan) error.scan = scan;
  return error;
}

/** The issue as a Run keeps it (LinearIssueSnapshot in packages/shared/src/model.ts). */
function issueSnapshot(workspace, node) {
  const assignee = node.assignee?.name;
  return {
    id: String(node.id),
    key: String(node.identifier),
    title: cap(node.title, TITLE_MAX),
    description: cap(node.description, TEXT_MAX),
    url: String(node.url ?? ""),
    labels: (node.labels?.nodes ?? []).slice(0, LABELS_MAX).map((label) => cap(label?.name, TITLE_MAX)),
    state: String(node.state?.name ?? ""),
    team: String(node.team?.key ?? ""),
    ...(assignee ? { assignee: cap(assignee, TITLE_MAX) } : {}),
    workspace,
  };
}

// The change a history node makes for a Routine's trigger, or null when it isn't one the Routine waits for.
function changeOf(trigger, node) {
  if (trigger.event === "assigned") return node.toAssignee?.isMe === true ? "assigned" : null;
  if (trigger.event === "label-added") {
    if (!trigger.label) return null;
    return (node.addedLabels ?? []).some((label) => lower(label?.name) === lower(trigger.label)) ? "label-added" : null;
  }
  if (trigger.event === "state") return trigger.state && node.toState?.name && lower(node.toState.name) === lower(trigger.state) ? "state" : null;
  return null;
}

// How a workspace's sign-in looks now, or "" when it has none.
function signInOf(api, workspace) {
  const entry = api?.workspaces?.().find((item) => item.id === workspace);
  return entry ? JSON.stringify(entry) : "";
}

// One request of a poll, taken from its budget.
function ask(api, workspace, budget, document, variables) {
  budget.left -= 1;
  return api.query(workspace, document, variables);
}

// An issue's history from `after` on, while the budget lasts. `complete` is false when it ran out, and then `after` is where
// the next read goes on. An issue Linear no longer finds (deleted, or its team out of reach) has nothing left to read.
async function readHistory(api, workspace, budget, id, after) {
  const nodes = [];
  let next = after;
  while (budget.left > 0) {
    let connection;
    try {
      connection = (await ask(api, workspace, budget, ISSUE_HISTORY, { id, after: next }))?.issue?.history;
    } catch (error) {
      if (isNotFound(error)) return { nodes: [], complete: true, after: null, gone: true };
      throw error;
    }
    nodes.push(...(connection?.nodes ?? []));
    if (!connection?.pageInfo?.hasNextPage || !connection.pageInfo.endCursor) return { nodes, complete: true, after: null };
    next = connection.pageInfo.endCursor;
  }
  return { nodes, complete: false, after: next };
}

// Drops how far a workspace's reads got (`scan` "issues" or "comments", or both), so the next poll starts again from the
// saved cursors. A held page cursor Linear stopped taking would otherwise fail the same way on every poll.
function forget(state, scan) {
  if (scan !== "comments") {
    state.issueScan = null;
    state.issueBase = undefined;
    state.histories = new Map();
    state.historiesRead ??= new Map();
  }
  if (scan !== "issues") state.commentScan = null;
}

// The earliest time a scan for these Routines reaches back to: just before the first was made.
const startOf = (routines) => Math.min(...routines.map((routine) => routine.createdAt)) - OVERLAP_MS;

const teamMatches = (trigger, issue) => !trigger.team || lower(issue?.team?.key) === lower(trigger.team);

/**
 * `linear` is the Mac's Linear connections ({ enabled, workspaces, query }) or a function returning them (the runtime makes
 * them after the Routines). `linkedIssue({ key, workspace })` resolves true when a Chat is linked to the issue: only those
 * issues' comments are queued. `onChange` runs when a Routine's lastError changed. `now` is the runtime's clock; it and the
 * timers, `requestBudget` and `bufferMax` are injected for tests.
 */
function createLinearPoller({
  linear,
  store,
  scheduler,
  linkedIssue = async () => false,
  onChange = () => {},
  now = Date.now,
  setTimeout: setTimer = setTimeout,
  clearTimeout: clearTimer = clearTimeout,
  requestBudget = REQUEST_BUDGET,
  bufferMax = BUFFER_MAX,
}) {
  const source = () => {
    try {
      return (typeof linear === "function" ? linear() : linear) ?? null;
    } catch {
      // Not made yet (read before the runtime declared it).
      return null;
    }
  };
  // workspace -> { timer, delay, polling, failures, and how far its reads got: issueScan, issueBase, histories,
  // historiesRead, commentScan }
  const states = new Map();
  // Workspaces whose sign-in is gone -> how the sign-in looked then ("" when it was missing). A different one resumes.
  const stopped = new Map();
  let running = false;
  let rescan = null;

  const linearRoutines = () => store.list().filter((routine) => routine.enabled && routine.trigger.kind === "linear");
  const routinesOf = (workspace) => linearRoutines().filter((routine) => lower(routine.trigger.workspace) === workspace);
  // Cursors are Linear's own times. One further ahead of the Mac's clock than CLOCK_AHEAD_MS came from a clock that ran
  // ahead (or an older build that saved the Mac's time): it is read as now minus the overlap, and dedupe drops repeats.
  const trusted = (at) => (at !== undefined && at > now() + CLOCK_AHEAD_MS ? now() - OVERLAP_MS : at);

  function setErrors(workspace, message) {
    let changed = false;
    for (const routine of routinesOf(workspace)) {
      if ((routine.lastError ?? null) === message) continue;
      store.setLastError(routine.id, message);
      changed = true;
    }
    if (changed) onChange();
  }

  function signOut(api, workspace) {
    stopped.set(workspace, signInOf(api, workspace));
    setErrors(workspace, SIGN_IN);
  }

  function schedule(workspace, state, ms) {
    clearTimer(state.timer);
    state.timer = setTimer(() => {
      state.timer = null;
      // pollNow never rejects; returning it lets a test await the poll.
      return pollNow(workspace);
    }, ms);
    state.timer?.unref?.();
  }

  /** Matches the polling to the enabled Linear Routines, the Routines switch and the sign-ins. Cheap; safe to call often. */
  function sync() {
    const api = source();
    const wanted = new Set(running && store.enabled() && api?.enabled?.() ? linearRoutines().map((routine) => lower(routine.trigger.workspace)) : []);
    for (const [workspace, state] of states) {
      if (wanted.has(workspace)) continue;
      clearTimer(state.timer);
      states.delete(workspace);
    }
    for (const workspace of wanted) {
      if (states.has(workspace)) continue;
      if (stopped.has(workspace)) {
        const current = signInOf(api, workspace);
        if (!current || current === stopped.get(workspace)) {
          // Still signed out: a Routine added since says so too. Gone from the list now, any sign-in later is a new one.
          stopped.set(workspace, current);
          setErrors(workspace, SIGN_IN);
          continue;
        }
        stopped.delete(workspace);
      }
      if (!signInOf(api, workspace)) {
        signOut(api, workspace);
        continue;
      }
      const state = { timer: null, delay: POLL_MS, polling: false, failures: 0 };
      forget(state);
      states.set(workspace, state);
      schedule(workspace, state, 0);
    }
  }

  // Queues the changes in `nodes` (an issue's history) made after `since` that a Routine waits for.
  function matchHistory(workspace, routines, issue, nodes, since, events) {
    let snapshot = null;
    for (const node of nodes) {
      const at = time(node?.createdAt);
      if (!node?.id || !(at > since)) continue;
      for (const routine of routines) {
        if (!(at > routine.createdAt) || !teamMatches(routine.trigger, issue)) continue;
        const change = changeOf(routine.trigger, node);
        if (!change) continue;
        snapshot ??= issueSnapshot(workspace, issue);
        events.push({ at, routineId: routine.id, event: { kind: "linear", key: `linear:${issue.id}:${node.id}`, change, issue: snapshot } });
      }
    }
  }

  /**
   * Issues changed since the cursor, oldest change first, while `budget` lasts. A read cut short goes on from Linear's own
   * page cursor on the next poll (`issueScan`), so issues sharing one updatedAt never hold it in place; that read first
   * checks the issue the cursor names, and starts over just before it if it moved. An issue whose history is longer than
   * its first page is read whole, on across polls if need be (`histories`). The saved cursor only moves once both are
   * done, so a restart reads again whatever wasn't finished; until then `issueBase` keeps the next scan's start in memory.
   */
  async function pollIssues(api, workspace, routines, start, floor, state, budget, events, later) {
    const histories = new Map(state.histories);
    // issue id -> the updatedAt at which its long history was read whole: the same issue found again (the overlap, a
    // restarted scan) isn't read again until it changes.
    const historiesRead = new Map(state.historiesRead);
    for (const [id, held] of state.histories) {
      if (budget.left <= 0) break;
      const read = await readHistory(api, workspace, budget, id, held.after);
      matchHistory(workspace, routines, held.issue, read.nodes, held.from, events);
      if (!read.complete) histories.set(id, { ...held, after: read.after });
      else {
        histories.delete(id);
        if (!read.gone) historiesRead.set(id, held.updatedAt);
      }
    }
    const base = trusted(state.issueBase ?? store.linearCursor(workspace));
    // `since` is where the issue query starts and `from` where the window starts: changes made after `from` are queued. A
    // scan that starts over at its cursor issue only moves `since`, so issues it hadn't reached keep the whole window.
    let scan = state.issueScan;
    if (!scan) {
      const since = Math.max(base === undefined ? start : base - OVERLAP_MS, floor);
      scan = { since, from: since, after: null, seen: base ?? start, last: null };
    }
    for (const [id, updated] of historiesRead) if (!(updated > scan.since)) historiesRead.delete(id);
    const { from } = scan;
    let { since, after, seen, last } = scan;
    let done = false;
    // Only the first page of a held scan can be stale: the rest follow it at once.
    let check = Boolean(after && last);
    while (budget.left > 0) {
      let data;
      if (check) {
        check = false;
        data = await ask(api, workspace, budget, POLL_ISSUES_RESUME, { since: new Date(since).toISOString(), after, anchor: last.id }).catch((error) => {
          if (isNotFound(error)) return null;
          throw error;
        });
        if (!data || time(data.anchor?.updatedAt) !== last.updatedAt) {
          // The cursor's issue changed or went since: the cursor may skip issues now, so read again from just before it.
          since = Math.max(last.updatedAt - OVERLAP_MS, floor);
          after = null;
          last = null;
          continue;
        }
      } else data = await ask(api, workspace, budget, POLL_ISSUES, { since: new Date(since).toISOString(), after });
      const connection = data?.issues;
      for (const issue of connection?.nodes ?? []) {
        const updated = time(issue?.updatedAt);
        if (updated > seen) seen = updated;
        if (!issue?.id || !issue.identifier) continue;
        // A history is only read for an issue some Routine's team filter takes.
        const targets = routines.filter((routine) => teamMatches(routine.trigger, issue));
        if (!targets.length) continue;
        const reading = histories.get(issue.id);
        // A long history being read on, or read whole at this updatedAt, gets only this page now. One that changed since is
        // read again from the start: now while the budget lasts, else on a later poll.
        const known = historiesRead.get(issue.id) === updated || reading?.updatedAt === updated;
        if (!issue.history?.pageInfo?.hasNextPage || known) {
          matchHistory(workspace, targets, issue, issue.history?.nodes ?? [], from, events);
          continue;
        }
        const whole = await readHistory(api, workspace, budget, issue.id, null);
        matchHistory(workspace, targets, issue, whole.nodes, from, events);
        if (!whole.complete) histories.set(issue.id, { from, after: whole.after, issue: { ...issue, history: undefined }, updatedAt: updated });
        else {
          histories.delete(issue.id);
          if (!whole.gone) historiesRead.set(issue.id, updated);
        }
      }
      const nodes = connection?.nodes ?? [];
      if (nodes.length) last = { id: String(nodes.at(-1).id), updatedAt: time(nodes.at(-1).updatedAt) };
      if (!connection?.pageInfo?.hasNextPage || !connection.pageInfo.endCursor) {
        done = true;
        break;
      }
      after = connection.pageInfo.endCursor;
    }
    later.push(() => {
      state.histories = histories;
      state.historiesRead = historiesRead;
      state.issueScan = done ? null : { since, from, after, seen, last };
      if (done) state.issueBase = seen;
    });
    return done && histories.size === 0 ? { key: workspace, at: seen } : null;
  }

  // Hands events to the scheduler in one batch, oldest first. The sort is stable, so comments made at once keep Linear's order.
  // It sorts a copy (one per hand-over, not per poll): a held buffer keeps Linear's page order until the hand-over worked,
  // so a failed one can be cut back to what was held before the poll without losing what earlier pages read.
  function deliver(...lists) {
    const events = [].concat(...lists);
    if (!events.length) return;
    events.sort((a, b) => a.at - b.at);
    scheduler.enqueueEvents(events);
  }

  /**
   * Comments made in (since, until], while `budget` lasts. A window is fixed when its read starts (`until` is then) and is
   * read forward from Linear's page cursor across polls (`commentScan`). Linear can't sort comments, so a window's
   * comments are handed over, oldest first, only once all of it was read, and only then does the cursor move: to the
   * newest comment Linear sent, never the Mac's clock. A window holding more than `bufferMax` events is narrowed to the
   * older half of what it held and read again; the rest is the next window. The 5 s overlap only starts a new window.
   */
  async function pollComments(api, workspace, routines, start, floor, state, budget, live) {
    const key = `${workspace}:comments`;
    // The scan as last kept, and how many events it held then: a failed poll leaves it as it was.
    let held = state.commentScan;
    let mark = held?.events.length ?? 0;
    // Shares `held.events`: events are added in place, never copied per poll.
    let scan = held ? { ...held } : null;
    const linked = new Map(); // issue key -> whether a Chat is linked to it
    const keep = (next) => {
      state.commentScan = next;
      held = next;
      mark = next?.events.length ?? 0;
      scan = next ? { ...next } : null;
    };
    try {
      while (budget.left > 0) {
        if (!scan) {
          const saved = trusted(store.linearCursor(key));
          const since = Math.max(saved === undefined ? start : saved - OVERLAP_MS, floor);
          scan = { since, until: Math.max(now(), since + 1), after: null, events: [], newest: undefined, narrowed: false };
        }
        const variables = { since: new Date(scan.since).toISOString(), until: new Date(scan.until).toISOString(), after: scan.after };
        const connection = (await ask(api, workspace, budget, POLL_COMMENTS, variables))?.comments;
        const found = [];
        for (const comment of connection?.nodes ?? []) {
          const at = time(comment?.createdAt);
          if (!(at > scan.since)) continue;
          if (!(at <= scan.newest)) scan.newest = at;
          // Comments from an app (Milagre's own included) are a bot actor's; the user's own go through.
          if (!comment.id || comment.botActor || !comment.issue?.identifier) continue;
          const targets = routines.filter((routine) => at > routine.createdAt && teamMatches(routine.trigger, comment.issue));
          if (!targets.length) continue;
          const issueKey = comment.issue.identifier;
          if (!linked.has(issueKey)) {
            try {
              linked.set(issueKey, Boolean(await linkedIssue({ key: issueKey, workspace })));
            } catch (error) {
              // Not knowing isn't "unlinked": the comment waits for the next poll rather than be dropped.
              throw new Error(`Couldn't look up the Chat linked to ${issueKey}: ${error?.message ?? error}`, { cause: error });
            }
          }
          if (!linked.get(issueKey)) continue;
          const issue = issueSnapshot(workspace, comment.issue);
          const author = cap(comment.user?.displayName || comment.user?.name || "", TITLE_MAX);
          const snapshot = { id: String(comment.id), body: cap(comment.body, TEXT_MAX), author, createdAt: at };
          for (const routine of targets) {
            found.push({
              at,
              routineId: routine.id,
              event: { kind: "linear", key: `linear-comment:${comment.id}`, change: "comment", issue, comment: snapshot },
            });
          }
        }
        if (scan.events.length + found.length > bufferMax) {
          if (scan.until - scan.since > 1) {
            // Too many to hold: keep the older half of what was seen (by time) as this window, and read it again.
            const times = [...scan.events, ...found].map((item) => item.at).sort((a, b) => a - b);
            const median = times[Math.floor((times.length - 1) / 2)];
            scan = { since: scan.since, until: median < scan.until ? median : scan.until - 1, after: null, events: [], newest: undefined, narrowed: true };
            continue;
          }
          // A window one millisecond wide can't be narrowed, and its comments have no order to keep: hand over what it holds.
          if (!live()) return;
          deliver(scan.events, found);
          scan.events = [];
        } else scan.events.push(...found);
        if (connection?.pageInfo?.hasNextPage && connection.pageInfo.endCursor) {
          scan.after = connection.pageInfo.endCursor;
          continue;
        }
        // The whole window is read.
        if (!live()) return;
        deliver(scan.events);
        const saved = trusted(store.linearCursor(key));
        if (scan.newest !== undefined) store.setLinearCursor(key, Math.max(saved ?? scan.newest, scan.newest));
        // A narrowed window is followed at once by the rest, from where it stopped; a full one waits for the next poll.
        if (!scan.narrowed) {
          keep(null);
          return;
        }
        keep({ since: scan.until, until: Math.max(now(), scan.until + 1), after: null, events: [], newest: undefined, narrowed: false });
      }
      if (live()) state.commentScan = scan;
    } catch (error) {
      if (held) held.events.length = mark;
      throw inScan(error, "comments");
    }
  }

  // `live()` says the poll still counts: one that finishes after stop() changes nothing. How far each scan got is kept
  // only when that scan worked, together with handing over its events, so a failed scan reads the same pages again.
  async function pollOnce(api, workspace, state, live) {
    const routines = routinesOf(workspace);
    const issueRoutines = routines.filter((routine) => routine.trigger.event !== "comment");
    const commentRoutines = routines.filter((routine) => routine.trigger.event === "comment");
    const floor = now() - MAX_BACKFILL_MS;
    const budget = { left: requestBudget };
    if (issueRoutines.length) {
      // With comment Routines too, issues get half the budget and comments the rest, so neither starves the other.
      const issueBudget = { left: commentRoutines.length ? Math.ceil(requestBudget / 2) : requestBudget };
      const share = issueBudget.left;
      const events = []; // { at, routineId, event }
      const later = [];
      const cursor = await pollIssues(api, workspace, issueRoutines, startOf(issueRoutines), floor, state, issueBudget, events, later).catch((error) => {
        throw inScan(error, "issues");
      });
      budget.left -= share - issueBudget.left;
      if (!live()) return;
      deliver(events);
      for (const commit of later) commit();
      if (cursor && Number.isFinite(cursor.at)) store.setLinearCursor(cursor.key, cursor.at);
    }
    if (commentRoutines.length) await pollComments(api, workspace, commentRoutines, startOf(commentRoutines), floor, state, budget, live);
  }

  /** Polls one workspace now, then sets its next poll. Resolves when done; never throws. */
  async function pollNow(workspace) {
    const id = lower(workspace);
    const state = states.get(id);
    if (!running || !state || state.polling) return;
    state.polling = true;
    clearTimer(state.timer);
    state.timer = null;
    const api = source();
    try {
      if (!api) throw Object.assign(new Error("Linear isn't ready."), { code: "offline" });
      const live = () => running && states.get(id) === state;
      await pollOnce(api, id, state, live);
      if (!live()) return;
      state.delay = POLL_MS;
      state.failures = 0;
      setErrors(id, null);
    } catch (error) {
      if (!running || states.get(id) !== state) return;
      if (SIGNED_OUT.has(error?.code)) {
        states.delete(id);
        signOut(api, id);
        return;
      }
      // rate-limited, offline, failed, or anything unforeseen: back off.
      state.delay = Math.min(state.delay * 2, MAX_DELAY_MS);
      state.failures += 1;
      // Linear refused the read itself (a held page cursor it no longer takes, an issue gone): what that scan held goes, and
      // it starts again from its saved cursor, as a poll did before reads went on across polls.
      if (error?.code === "failed") forget(state, error.scan);
      if (state.failures >= FAILURES_SHOWN) setErrors(id, failureText(error));
      console.warn(`[routines] Linear poll of ${id} failed`, error?.message ?? error);
    } finally {
      state.polling = false;
    }
    if (running && states.get(id) === state) schedule(id, state, state.delay);
  }

  function rescanLater() {
    rescan = setTimer(() => {
      rescan = null;
      sync();
      if (running) rescanLater();
    }, POLL_MS);
    rescan?.unref?.();
  }

  return {
    start() {
      if (running) return;
      running = true;
      sync();
      rescanLater();
    },
    stop() {
      running = false;
      clearTimer(rescan);
      rescan = null;
      for (const state of states.values()) clearTimer(state.timer);
      states.clear();
    },
    sync,
    pollNow,
  };
}

module.exports = { createLinearPoller, issueSnapshot, SIGN_IN };
