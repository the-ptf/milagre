// Linear triggers: one poll per signed-in workspace that has an enabled Linear Routine, about every minute, whose changes
// are matched against each of its Routines and queued through the scheduler (see global decision D4 of the Routines plan).
const { POLL_ISSUES, POLL_COMMENTS, ISSUE_HISTORY } = require("../linear/issues.cjs");

const POLL_MS = 60_000;
const MAX_DELAY_MS = 15 * 60_000;
// Each query reaches back this far behind the cursor; the store's per-Routine dedupe drops what was already seen.
const OVERLAP_MS = 5_000;
const MAX_PAGES = 5;
// However long polling was off (the switch, a pause, a sleeping Mac), a poll never reaches back further than this.
const MAX_BACKFILL_MS = 24 * 60 * 60_000;
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

// A connection's nodes from `after` on, up to MAX_PAGES pages of them. `complete` is false when the cap cut it short, and
// then `after` is where the next read goes on.
async function pages(api, workspace, document, variables, pick, after = null) {
  const nodes = [];
  let next = after;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const connection = pick(await api.query(workspace, document, { ...variables, after: next }));
    nodes.push(...(connection?.nodes ?? []));
    if (!connection?.pageInfo?.hasNextPage || !connection.pageInfo.endCursor) return { nodes, complete: true, after: null };
    next = connection.pageInfo.endCursor;
  }
  return { nodes, complete: false, after: next };
}

const teamMatches = (trigger, issue) => !trigger.team || lower(issue?.team?.key) === lower(trigger.team);

/**
 * `linear` is the Mac's Linear connections ({ enabled, workspaces, query }) or a function returning them (the runtime makes
 * them after the Routines). `linkedIssue({ key, workspace })` resolves true when a Chat is linked to the issue: only those
 * issues' comments are queued. `onChange` runs when a Routine's lastError changed. `now` and the timers are injected for tests.
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
}) {
  const source = () => {
    try {
      return (typeof linear === "function" ? linear() : linear) ?? null;
    } catch {
      // Not made yet (read before the runtime declared it).
      return null;
    }
  };
  // workspace -> { timer, delay, polling, and how far its reads got: issueScan, issueBase, histories, historiesRead, commentScan }
  const states = new Map();
  // Workspaces whose sign-in is gone -> how the sign-in looked then ("" when it was missing). A different one resumes.
  const stopped = new Map();
  let running = false;
  let rescan = null;

  const linearRoutines = () => store.list().filter((routine) => routine.enabled && routine.trigger.kind === "linear");
  const routinesOf = (workspace) => linearRoutines().filter((routine) => lower(routine.trigger.workspace) === workspace);

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
      const state = {
        timer: null,
        delay: POLL_MS,
        polling: false,
        issueScan: null,
        issueBase: undefined,
        histories: new Map(),
        historiesRead: new Map(),
        commentScan: null,
      };
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
   * Issues changed since the cursor, oldest change first. A read the page cap cuts short goes on from Linear's own page
   * cursor on the next poll (`issueScan`), so issues sharing one updatedAt never hold it in place. An issue whose history is
   * longer than the cap is read on across polls too (`histories`). The saved cursor only moves once both are done, so a
   * restart reads again whatever wasn't finished; until then `issueBase` keeps the next scan's start in memory.
   */
  async function pollIssues(api, workspace, routines, start, floor, state, events, later) {
    const saved = store.linearCursor(workspace);
    const histories = new Map(state.histories);
    // issue id -> the updatedAt at which its long history was read whole: the same issue found again (the overlap, a
    // restarted scan) isn't read again until it changes.
    const historiesRead = new Map(state.historiesRead);
    for (const [id, scan] of state.histories) {
      const read = await pages(api, workspace, ISSUE_HISTORY, { id }, (data) => data?.issue?.history, scan.after);
      matchHistory(workspace, routines, scan.issue, read.nodes, scan.since, events);
      if (read.complete) {
        histories.delete(id);
        historiesRead.set(id, scan.updatedAt);
      } else histories.set(id, { ...scan, after: read.after });
    }
    const base = state.issueBase ?? saved;
    const scan = state.issueScan ?? { since: Math.max(base === undefined ? start : base - OVERLAP_MS, floor), after: null, seen: base ?? start };
    for (const [id, updated] of historiesRead) if (!(updated > scan.since)) historiesRead.delete(id);
    const read = await pages(api, workspace, POLL_ISSUES, { since: new Date(scan.since).toISOString() }, (data) => data?.issues, scan.after);
    let seen = scan.seen;
    for (const issue of read.nodes) {
      const updated = time(issue?.updatedAt);
      if (updated > seen) seen = updated;
      if (!issue?.id || !issue.identifier) continue;
      let nodes = issue.history?.nodes ?? [];
      const reading = histories.get(issue.id);
      // A long history being read on, or read whole at this updatedAt, gets only this page now. One that changed since is
      // read again from the start.
      const known = historiesRead.get(issue.id) === updated || reading?.updatedAt === updated;
      if (issue.history?.pageInfo?.hasNextPage && !known) {
        const whole = await pages(api, workspace, ISSUE_HISTORY, { id: issue.id }, (data) => data?.issue?.history);
        nodes = whole.nodes;
        if (whole.complete) {
          histories.delete(issue.id);
          historiesRead.set(issue.id, updated);
        } else histories.set(issue.id, { since: scan.since, after: whole.after, issue, updatedAt: updated });
      }
      matchHistory(workspace, routines, issue, nodes, scan.since, events);
    }
    const done = read.complete;
    later.push(() => {
      state.histories = histories;
      state.historiesRead = historiesRead;
      state.issueScan = done ? null : { ...scan, after: read.after, seen };
      if (done) state.issueBase = seen;
    });
    return done && histories.size === 0 ? { key: workspace, at: seen } : null;
  }

  /**
   * Comments made in (since, until]. A window is fixed when its read starts (`until` is then) and is read forward from
   * Linear's page cursor across polls (`commentScan`); its comments are queued, oldest first, only once all of it was read,
   * and only then does the cursor move to `until`. The 5 s overlap is only the start of a new window.
   */
  async function pollComments(api, workspace, routines, start, floor, state, events, later) {
    const key = `${workspace}:comments`;
    const saved = store.linearCursor(key);
    const scan = state.commentScan ?? {
      since: Math.max(saved === undefined ? start : saved - OVERLAP_MS, floor),
      until: now(),
      after: null,
      events: [],
    };
    const variables = { since: new Date(scan.since).toISOString(), until: new Date(scan.until).toISOString() };
    const read = await pages(api, workspace, POLL_COMMENTS, variables, (data) => data?.comments, scan.after);
    const found = [...scan.events];
    const commentRoutines = routines.filter((routine) => routine.trigger.event === "comment");
    const linked = new Map(); // issue key -> whether a Chat is linked to it
    for (const comment of read.nodes) {
      const at = time(comment?.createdAt);
      // Comments from an app (Milagre's own included) are a bot actor's; the user's own go through.
      if (!(at > scan.since) || !comment.id || comment.botActor || !comment.issue?.identifier) continue;
      const targets = commentRoutines.filter((routine) => at > routine.createdAt && teamMatches(routine.trigger, comment.issue));
      if (!targets.length) continue;
      const issueKey = comment.issue.identifier;
      if (!linked.has(issueKey)) linked.set(issueKey, await Promise.resolve(linkedIssue({ key: issueKey, workspace })).then(Boolean, () => false));
      if (!linked.get(issueKey)) continue;
      const issue = issueSnapshot(workspace, comment.issue);
      const author = cap(comment.user?.displayName || comment.user?.name || "", TITLE_MAX);
      const snapshot = { id: String(comment.id), body: cap(comment.body, TEXT_MAX), author, createdAt: at };
      for (const routine of targets) {
        found.push({ at, routineId: routine.id, event: { kind: "linear", key: `linear-comment:${comment.id}`, change: "comment", issue, comment: snapshot } });
      }
    }
    if (!read.complete) {
      later.push(() => {
        state.commentScan = { ...scan, after: read.after, events: found };
      });
      return null;
    }
    events.push(...found);
    later.push(() => {
      state.commentScan = null;
    });
    return { key, at: Math.max(saved ?? start, scan.until) };
  }

  // `live()` says the poll still counts: one that finishes after stop() changes nothing. How far the reads got is kept only
  // when the whole poll worked, together with queueing its events, so a failed poll reads the same pages again.
  async function pollOnce(api, workspace, state, live) {
    const routines = routinesOf(workspace);
    if (!routines.length) return;
    const start = Math.min(...routines.map((routine) => routine.createdAt)) - OVERLAP_MS;
    const floor = now() - MAX_BACKFILL_MS;
    const events = []; // { at, routineId, event }, queued oldest first
    const later = [];
    const issues = await pollIssues(api, workspace, routines, start, floor, state, events, later);
    const comments = await pollComments(api, workspace, routines, start, floor, state, events, later);
    if (!live()) return;
    events.sort((a, b) => a.at - b.at);
    for (const { routineId, event } of events) scheduler.enqueueEvent(routineId, event);
    for (const commit of later) commit();
    for (const cursor of [issues, comments]) if (cursor && Number.isFinite(cursor.at)) store.setLinearCursor(cursor.key, cursor.at);
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
