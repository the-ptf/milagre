// Linear triggers: one poll per signed-in workspace that has an enabled Linear Routine, about every minute, whose changes
// are matched against each of its Routines and queued through the scheduler (see global decision D4 of the Routines plan).
const { POLL_ISSUES, POLL_COMMENTS } = require("../linear/issues.cjs");

const POLL_MS = 60_000;
const MAX_DELAY_MS = 15 * 60_000;
// Each query reaches back this far behind the cursor; the store's per-Routine dedupe drops what was already seen.
const OVERLAP_MS = 5_000;
const MAX_PAGES = 5;
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

// A connection's nodes, up to MAX_PAGES pages of them.
async function pages(api, workspace, document, since, pick) {
  const nodes = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const connection = pick(await api.query(workspace, document, { since, after }));
    nodes.push(...(connection?.nodes ?? []));
    if (!connection?.pageInfo?.hasNextPage || !connection.pageInfo.endCursor) break;
    after = connection.pageInfo.endCursor;
  }
  return nodes;
}

const teamMatches = (trigger, issue) => !trigger.team || lower(issue?.team?.key) === lower(trigger.team);

/**
 * `linear` is the Mac's Linear connections ({ enabled, workspaces, query }) or a function returning them (the runtime makes
 * them after the Routines). `linkedIssue({ key, workspace })` resolves true when a Chat is linked to the issue: only those
 * issues' comments are queued. `onChange` runs when a Routine's lastError changed. Timers are injected for tests; every
 * time compared comes from Linear or the store, so no clock is needed.
 */
function createLinearPoller({
  linear,
  store,
  scheduler,
  linkedIssue = async () => false,
  onChange = () => {},
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
  const states = new Map(); // workspace -> { timer, delay, polling }
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
      const state = { timer: null, delay: POLL_MS, polling: false };
      states.set(workspace, state);
      schedule(workspace, state, 0);
    }
  }

  async function pollOnce(api, workspace) {
    const routines = routinesOf(workspace);
    if (!routines.length) return;
    const start = Math.min(...routines.map((routine) => routine.createdAt)) - OVERLAP_MS;
    const cursor = store.linearCursor(workspace);
    const since = cursor === undefined ? start : cursor - OVERLAP_MS;
    const sinceText = new Date(since).toISOString();
    const issues = await pages(api, workspace, POLL_ISSUES, sinceText, (data) => data?.issues);
    const comments = await pages(api, workspace, POLL_COMMENTS, sinceText, (data) => data?.comments);
    let seen = cursor ?? start;
    const events = []; // { at, routineId, event }, queued oldest first

    for (const issue of issues) {
      const updated = time(issue?.updatedAt);
      if (updated > seen) seen = updated;
      if (!issue?.id || !issue.identifier) continue;
      let snapshot = null;
      for (const node of issue.history?.nodes ?? []) {
        const at = time(node?.createdAt);
        if (!(at > since) || !node.id) continue;
        for (const routine of routines) {
          if (!(at > routine.createdAt) || !teamMatches(routine.trigger, issue)) continue;
          const change = changeOf(routine.trigger, node);
          if (!change) continue;
          snapshot ??= issueSnapshot(workspace, issue);
          events.push({ at, routineId: routine.id, event: { kind: "linear", key: `linear:${issue.id}:${node.id}`, change, issue: snapshot } });
        }
      }
    }

    const commentRoutines = routines.filter((routine) => routine.trigger.event === "comment");
    const linked = new Map(); // issue key -> whether a Chat is linked to it
    for (const comment of comments) {
      const at = time(comment?.createdAt);
      if (at > seen) seen = at;
      // Comments from an app (Milagre's own included) are a bot actor's; the user's own go through.
      if (!(at > since) || !comment.id || comment.botActor || !comment.issue?.identifier) continue;
      const targets = commentRoutines.filter((routine) => at > routine.createdAt && teamMatches(routine.trigger, comment.issue));
      if (!targets.length) continue;
      const key = comment.issue.identifier;
      if (!linked.has(key)) linked.set(key, await Promise.resolve(linkedIssue({ key, workspace })).then(Boolean, () => false));
      if (!linked.get(key)) continue;
      const issue = issueSnapshot(workspace, comment.issue);
      const author = cap(comment.user?.displayName || comment.user?.name || "", TITLE_MAX);
      const snapshot = { id: String(comment.id), body: cap(comment.body, TEXT_MAX), author, createdAt: at };
      for (const routine of targets) {
        events.push({ at, routineId: routine.id, event: { kind: "linear", key: `linear-comment:${comment.id}`, change: "comment", issue, comment: snapshot } });
      }
    }

    events.sort((a, b) => a.at - b.at);
    for (const { routineId, event } of events) scheduler.enqueueEvent(routineId, event);
    if (Number.isFinite(seen)) store.setLinearCursor(workspace, seen);
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
      await pollOnce(api, id);
      state.delay = POLL_MS;
      setErrors(id, null);
    } catch (error) {
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
