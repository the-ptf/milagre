const { POLL_ISSUES, POLL_ISSUES_RESUME, POLL_COMMENTS, ISSUE_HISTORY, isNotFound } = require("../linear/issues.cjs");

const POLL_MS = 60_000;
const MAX_DELAY_MS = 15 * 60_000;
const OVERLAP_MS = 5_000;
const REQUEST_BUDGET = 40;
const BUFFER_MAX = 1000;
const MAX_BACKFILL_MS = 24 * 60 * 60_000;
const CLOCK_AHEAD_MS = 5 * 60_000;
const FAILURES_SHOWN = 3;
const FAILURE_MAX = 200;
const SIGN_IN = "Linear sign-in needed";
const SIGNED_OUT = new Set(["revoked", "not-connected"]);
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

function inScan(error, scan) {
  if (error && typeof error === "object" && !error.scan) error.scan = scan;
  return error;
}

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
    ...(typeof node.state?.type === "string" ? { stateType: node.state.type } : {}),
    ...(typeof node.state?.color === "string" ? { stateColor: node.state.color } : {}),
    team: String(node.team?.key ?? ""),
    ...(assignee ? { assignee: cap(assignee, TITLE_MAX) } : {}),
    workspace,
  };
}

function changeOf(trigger, node) {
  if (trigger.event === "assigned") return node.toAssignee?.isMe === true ? "assigned" : null;
  if (trigger.event === "label-added") {
    if (!trigger.label) return null;
    return (node.addedLabels ?? []).some((label) => lower(label?.name) === lower(trigger.label)) ? "label-added" : null;
  }
  if (trigger.event === "state") return trigger.state && node.toState?.name && lower(node.toState.name) === lower(trigger.state) ? "state" : null;
  return null;
}

function signInOf(api, workspace) {
  const entry = api?.workspaces?.().find((item) => item.id === workspace);
  return entry ? JSON.stringify(entry) : "";
}

function ask(api, workspace, budget, document, variables) {
  budget.left -= 1;
  return api.query(workspace, document, variables);
}

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

function forget(state, scan) {
  if (scan !== "comments") {
    state.issueScan = null;
    state.issueBase = undefined;
    state.histories = new Map();
    state.historiesRead ??= new Map();
  }
  if (scan !== "issues") state.commentScan = null;
}

const startOf = (routines) => Math.min(...routines.map((routine) => routine.createdAt)) - OVERLAP_MS;

const teamMatches = (trigger, issue) => !trigger.team || lower(issue?.team?.key) === lower(trigger.team);

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
      return null;
    }
  };
  const states = new Map();
  const stopped = new Map();
  let running = false;
  let rescan = null;

  const linearRoutines = () => store.list().filter((routine) => routine.enabled && routine.trigger.kind === "linear");
  const routinesOf = (workspace) => linearRoutines().filter((routine) => lower(routine.trigger.workspace) === workspace);
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
      return pollNow(workspace);
    }, ms);
    state.timer?.unref?.();
  }

  function sync() {
    const api = source();
    const wanted = new Set(running && api?.enabled?.() ? linearRoutines().map((routine) => lower(routine.trigger.workspace)) : []);
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

  async function pollIssues(api, workspace, routines, start, floor, state, budget, events, later) {
    const histories = new Map(state.histories);
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
    let scan = state.issueScan;
    if (!scan) {
      const since = Math.max(base === undefined ? start : base - OVERLAP_MS, floor);
      scan = { since, from: since, after: null, seen: base ?? start, last: null };
    }
    for (const [id, updated] of historiesRead) if (!(updated > scan.since)) historiesRead.delete(id);
    const { from } = scan;
    let { since, after, seen, last } = scan;
    let done = false;
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
        const targets = routines.filter((routine) => teamMatches(routine.trigger, issue));
        if (!targets.length) continue;
        const reading = histories.get(issue.id);
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

  function deliver(...lists) {
    const events = [].concat(...lists);
    if (!events.length) return;
    events.sort((a, b) => a.at - b.at);
    scheduler.enqueueEvents(events);
  }

  async function pollComments(api, workspace, routines, start, floor, state, budget, live) {
    const key = `${workspace}:comments`;
    let held = state.commentScan;
    let mark = held?.events.length ?? 0;
    let scan = held ? { ...held } : null;
    const linked = new Map();
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
          if (!comment.id || comment.botActor || !comment.issue?.identifier) continue;
          const targets = routines.filter((routine) => at > routine.createdAt && teamMatches(routine.trigger, comment.issue));
          if (!targets.length) continue;
          const issueKey = comment.issue.identifier;
          if (!linked.has(issueKey)) {
            try {
              linked.set(issueKey, Boolean(await linkedIssue({ key: issueKey, workspace })));
            } catch (error) {
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
            const times = [...scan.events, ...found].map((item) => item.at).sort((a, b) => a - b);
            const median = times[Math.floor((times.length - 1) / 2)];
            scan = { since: scan.since, until: median < scan.until ? median : scan.until - 1, after: null, events: [], newest: undefined, narrowed: true };
            continue;
          }
          if (!live()) return;
          deliver(scan.events, found);
          scan.events = [];
        } else scan.events.push(...found);
        if (connection?.pageInfo?.hasNextPage && connection.pageInfo.endCursor) {
          scan.after = connection.pageInfo.endCursor;
          continue;
        }
        if (!live()) return;
        deliver(scan.events);
        const saved = trusted(store.linearCursor(key));
        if (scan.newest !== undefined) store.setLinearCursor(key, Math.max(saved ?? scan.newest, scan.newest));
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

  async function pollOnce(api, workspace, state, live) {
    const routines = routinesOf(workspace);
    const issueRoutines = routines.filter((routine) => routine.trigger.event !== "comment");
    const commentRoutines = routines.filter((routine) => routine.trigger.event === "comment");
    const floor = now() - MAX_BACKFILL_MS;
    const budget = { left: requestBudget };
    if (issueRoutines.length) {
      const issueBudget = { left: commentRoutines.length ? Math.ceil(requestBudget / 2) : requestBudget };
      const share = issueBudget.left;
      const events = [];
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
      state.delay = Math.min(state.delay * 2, MAX_DELAY_MS);
      state.failures += 1;
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
