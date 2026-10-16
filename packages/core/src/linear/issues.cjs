// Linear issues for the Mac's Chat list, the issue picker and each Worktree's chip (see the Linear spec, Issues).
// Every method reads through the Mac's connections; `linear` holds them (workspaces, query by workspace, enabled).
const { isIssueKey, issueKeyInBranch } = require("./links.cjs");

const ISSUE_TTL_MS = 60_000;
const TEAMS_TTL_MS = 10 * 60_000;
const OFF = "Linear is off in Settings › Connections › Linear.";
const DISCONNECTED = "Linear isn't connected.";
const ISSUE_FIELDS = "identifier title url branchName description state { name type color }";
const NOT_CONNECTED_CODES = new Set(["not-connected", "revoked"]);

const ASSIGNED = `query Assigned {
  viewer { assignedIssues(first: 50, orderBy: updatedAt, filter: { state: { type: { in: ["started", "unstarted"] } } }) { nodes { ${ISSUE_FIELDS} } } }
}`;
const SEARCH = `query Search($q: String!) { searchIssues(term: $q, first: 25) { nodes { ${ISSUE_FIELDS} } } }`;
const ONE = `query One($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`;
const TEAMS = "query Teams { teams(first: 100) { nodes { key } } }";
// The issue's state and its team's started states; the first by position is the one Linear calls In Progress.
const STARTED_STATES = `query Started($id: String!) {
  issue(id: $id) { id state { type } team { states(filter: { type: { eq: "started" } }) { nodes { id position } } } }
}`;
const MOVE = "mutation Move($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }";
// Only work not yet begun moves; started, done and canceled issues keep their status.
const NOT_STARTED = new Set(["triage", "backlog", "unstarted"]);

// Routines' Linear polling (routines/linear-poller.cjs). Every field is checked against the schema @linear/sdk publishes:
// Issue.history (IssueHistory.toAssignee.isMe, addedLabels.name, toState.name), IssueFilter.updatedAt and
// CommentFilter.createdAt (DateComparator.gt/lte, a DateTimeOrDuration), QueryIssuesArgs.sort (IssueSortInput.updatedAt
// with PaginationSortOrder Ascending), Comment.botActor (ActorBot.type) and Comment.user. Sizes keep each query well under
// Linear's 10 000-point complexity cap (linear-poller.test.cjs estimates them).
const ROUTINE_ISSUE_FIELDS = "id identifier title description url state { name } team { key } assignee { name } labels(first: 10) { nodes { name } }";
const HISTORY_FIELDS = "id createdAt toAssignee { isMe } addedLabels { name } toState { name }";
// Oldest change first, so a poll cut short by the page cap can resume where it stopped.
const POLL_ISSUES = `query PollIssues($since: DateTimeOrDuration!, $after: String) {
  issues(first: 25, after: $after, sort: [{ updatedAt: { order: Ascending } }], filter: { updatedAt: { gt: $since } }) {
    nodes { ${ROUTINE_ISSUE_FIELDS} updatedAt history(first: 10) { nodes { ${HISTORY_FIELDS} } pageInfo { hasNextPage endCursor } } }
    pageInfo { hasNextPage endCursor }
  }
}`;
// One issue's whole history, when the poll's first page of it wasn't all of it.
const ISSUE_HISTORY = `query IssueHistory($id: String!, $after: String) {
  issue(id: $id) { history(first: 50, after: $after) { nodes { ${HISTORY_FIELDS} } pageInfo { hasNextPage endCursor } } }
}`;
// Comments have no sort: a window bounded on both sides, which the poller narrows until it fits in the page cap.
const POLL_COMMENTS = `query PollComments($since: DateTimeOrDuration!, $until: DateTimeOrDuration!, $after: String) {
  comments(first: 50, after: $after, filter: { createdAt: { gt: $since, lte: $until } }) {
    nodes { id body createdAt botActor { type } user { name displayName } issue { ${ROUTINE_ISSUE_FIELDS} } }
    pageInfo { hasNextPage endCursor }
  }
}`;
// The Routines form's choices: a workspace's teams, and one team's labels (its own and the workspace's, groups left out,
// as an issue can't carry a group) and workflow states.
const ROUTINE_TEAMS = "query RoutineTeams { teams(first: 250) { nodes { key name } } }";
const ROUTINE_TEAM_OPTIONS = `query RoutineTeamOptions($team: String!) {
  issueLabels(first: 250, filter: { isGroup: { eq: false }, or: [{ team: { key: { eqIgnoreCase: $team } } }, { team: { null: true } }] }) { nodes { name } }
  teams(first: 1, filter: { key: { eqIgnoreCase: $team } }) { nodes { states(first: 100) { nodes { name type position } } } }
}`;

function toIssue(node) {
  if (!node || typeof node !== "object") return null;
  return {
    key: node.identifier,
    title: node.title,
    url: node.url,
    branchName: node.branchName,
    ...(node.description ? { description: node.description } : {}),
    state: { name: node.state?.name, type: node.state?.type, color: node.state?.color },
  };
}

// Linear reports a missing entity as a failed GraphQL query whose message or extensions say "not found".
function isNotFound(error) {
  if (error?.code !== "failed") return false;
  const extensions = error.extensions ?? {};
  return [error.message, extensions.type, extensions.code].some((text) => typeof text === "string" && /not[ _]?found/i.test(text));
}

function createLinearIssues({ linear, now = Date.now }) {
  const cache = new Map(); // "workspace:KEY" -> { at, issue }, the issue null when that workspace has no such key
  const teams = new Map(); // workspace -> { at, keys }, its team keys in upper case
  const assigned = new Map(); // workspace -> { at, account, issues }, the viewer's open issues the picker opens on

  // Why issues can't be read right now, or null when they can.
  function unavailable() {
    if (!linear.enabled()) return { error: OFF, notConnected: true };
    if (!linear.workspaces().length) return { error: DISCONNECTED, notConnected: true };
    return null;
  }

  // Every issue says which workspace it came from, so picking it reads the same workspace again.
  const fromWorkspace = (workspace, node) => {
    const issue = toIssue(node);
    return issue ? { ...issue, workspace } : null;
  };

  // A key the workspace doesn't have is a missing issue, not a failed read. Any other failure is thrown.
  async function fetchOne(workspace, key) {
    try {
      const data = await linear.query(workspace, ONE, { id: key });
      return fromWorkspace(workspace, data?.issue);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  // One query for every key. Linear fails the whole batch when one key is missing, so then each key is asked alone.
  async function fetchBatch(workspace, keys) {
    const aliases = keys.map((key, index) => `i${index}: issue(id: ${JSON.stringify(key)}) { ${ISSUE_FIELDS} }`).join("\n");
    try {
      const data = await linear.query(workspace, `query Issues {\n${aliases}\n}`);
      return new Map(keys.map((key, index) => [key, fromWorkspace(workspace, data?.[`i${index}`])]));
    } catch (error) {
      if (error.code !== "failed") throw error;
    }
    const found = new Map();
    for (const key of keys) found.set(key, await fetchOne(workspace, key));
    return found;
  }

  // `wanted` holds [workspace, KEY] pairs; the answer maps "workspace:KEY" to the issue or null.
  async function readIssues(wanted, { fresh = false } = {}) {
    const result = new Map();
    const missing = new Map(); // workspace -> keys to fetch
    for (const [workspace, key] of wanted) {
      const id = `${workspace}:${key}`;
      if (result.has(id)) continue;
      const hit = fresh ? null : cache.get(id);
      if (hit && now() - hit.at < ISSUE_TTL_MS) result.set(id, hit.issue);
      else if (!missing.get(workspace)?.includes(key)) missing.set(workspace, [...(missing.get(workspace) ?? []), key]);
    }
    for (const [workspace, keys] of missing) {
      const found = await fetchBatch(workspace, keys);
      for (const key of keys) {
        const issue = found.get(key) ?? null;
        cache.set(`${workspace}:${key}`, { at: now(), issue });
        result.set(`${workspace}:${key}`, issue);
      }
    }
    return result;
  }

  async function teamKeys(workspace) {
    const hit = teams.get(workspace);
    if (hit && now() - hit.at < TEAMS_TTL_MS) return hit.keys;
    const data = await linear.query(workspace, TEAMS);
    const keys = new Set((data?.teams?.nodes ?? []).map((team) => String(team.key).toUpperCase()));
    teams.set(workspace, { at: now(), keys });
    return keys;
  }

  // The connected workspaces to ask about a key, best guess first: the one named, else those with the key's team,
  // else every one in order (a workspace whose teams can't be read right now is still tried).
  async function candidates(key, workspace) {
    const ids = linear.workspaces().map((item) => item.id);
    if (typeof workspace === "string" && ids.includes(workspace.toLowerCase())) return [workspace.toLowerCase()];
    if (ids.length < 2) return ids;
    const team = key.split("-")[0];
    const owners = [];
    for (const id of ids) if ((await teamKeys(id).catch(() => null))?.has(team)) owners.push(id);
    return owners.length ? owners : ids;
  }

  // A current copy of one issue, from the named workspace or the first one that has the key. Null when none has it.
  async function readIssue(key, workspace) {
    const upper = String(key).toUpperCase();
    if (!isIssueKey(upper)) return null;
    for (const id of await candidates(upper, workspace)) {
      const issue = (await readIssues([[id, upper]], { fresh: true })).get(`${id}:${upper}`);
      if (issue) return issue;
    }
    return null;
  }

  // The Chat list's picker: one workspace's assigned issues, or its matches for a query. With no workspace named it is
  // the first one connected. The assigned list is kept for a minute so reopening the picker is instant; `fresh` (its
  // refresh button) reads it again. `workspaces` lets the picker show one tab per workspace.
  async function list(query, { fresh = false, workspace } = {}) {
    const unready = unavailable();
    if (unready) return unready;
    const connected = linear.workspaces();
    const chosen = connected.find((item) => item.id === String(workspace ?? "").toLowerCase()) ?? connected[0];
    const named = { workspace: chosen.id, workspaces: connected.map((item) => ({ id: item.id, name: item.organization.name })) };
    const text = typeof query === "string" ? query.trim() : "";
    try {
      if (!text) {
        // Another sign-in to the same workspace is another account's issues.
        const account = chosen.viewer?.email ?? "";
        const hit = assigned.get(chosen.id);
        if (!fresh && hit?.account === account && now() - hit.at < ISSUE_TTL_MS) return { issues: hit.issues, ...named };
        const data = await linear.query(chosen.id, ASSIGNED);
        const issues = (data?.viewer?.assignedIssues?.nodes ?? []).map((node) => fromWorkspace(chosen.id, node));
        assigned.set(chosen.id, { at: now(), account, issues });
        return { issues, ...named };
      }
      const exact = isIssueKey(text) ? await fetchOne(chosen.id, text.toUpperCase()) : null;
      const data = await linear.query(chosen.id, SEARCH, { q: text });
      const matches = (data?.searchIssues?.nodes ?? []).map((node) => fromWorkspace(chosen.id, node)).filter((issue) => issue && issue.key !== exact?.key);
      return { issues: exact ? [exact, ...matches] : matches, ...named };
    } catch (error) {
      return { error: error.message, ...(NOT_CONNECTED_CODES.has(error.code) ? { notConnected: true } : {}) };
    }
  }

  // Worktree path -> the issue it was started from or names in its branch. Never throws: a failed read shows no chips.
  async function worktreeIssues(worktrees) {
    if (unavailable()) return {};
    try {
      const ids = linear.workspaces().map((item) => item.id);
      const named = []; // [path, workspace, KEY]
      for (const worktree of worktrees) {
        if (worktree.linearIssue) {
          const key = String(worktree.linearIssue).toUpperCase();
          const stored = String(worktree.linearWorkspace ?? "").toLowerCase();
          // A link saved before workspaces names no workspace: the one whose teams have the key reads it.
          const workspace = ids.includes(stored) ? stored : (await candidates(key).catch(() => ids))[0];
          if (workspace) named.push([worktree.path, workspace, key]);
          continue;
        }
        // Best effort: a workspace whose team keys can't be read recognizes no branch.
        for (const id of ids) {
          const key = issueKeyInBranch(worktree.name, await teamKeys(id).catch(() => new Set()));
          if (key) {
            named.push([worktree.path, id, key]);
            break;
          }
        }
      }
      const issues = await readIssues(named.map(([, workspace, key]) => [workspace, key]));
      const result = {};
      for (const [path, workspace, key] of named) {
        const issue = issues.get(`${workspace}:${key}`);
        if (issue) result[path] = issue;
      }
      return result;
    } catch {
      return {};
    }
  }

  // Moves an issue a Chat just started from to its team's first started status. Says what happened and never throws:
  // "moved", "kept" (already begun, or the team has no started status) or "failed".
  async function markStarted(key, workspace) {
    try {
      const data = await linear.query(workspace, STARTED_STATES, { id: key });
      const issue = data?.issue;
      if (!issue || !NOT_STARTED.has(issue.state?.type)) return "kept";
      const [target] = [...(issue.team?.states?.nodes ?? [])].sort((a, b) => a.position - b.position);
      if (!target) return "kept";
      const moved = await linear.query(workspace, MOVE, { id: issue.id, stateId: target.id });
      if (moved?.issueUpdate?.success !== true) return "failed";
      // The chips read the new status on their next poll, not a minute later.
      forget(key, workspace);
      return "moved";
    } catch {
      return "failed";
    }
  }

  // What the Routines form offers for a Linear trigger: the connected workspaces, the named one's teams (the first
  // workspace when none is named), and the named team's labels and states. Never throws: a failed read says why in `error`.
  async function routineOptions({ workspace, team } = {}) {
    const empty = { workspaces: [], teams: [], labels: [], states: [] };
    const unready = unavailable();
    if (unready) return { ...empty, error: unready.error };
    const connected = linear.workspaces();
    const result = { ...empty, workspaces: connected.map((item) => ({ id: item.id, name: item.organization?.name ?? item.id })) };
    const named = typeof workspace === "string" && workspace !== "";
    const chosen = named ? connected.find((item) => item.id === workspace.toLowerCase()) : connected[0];
    // A named workspace that isn't connected says so, rather than answer with another workspace's teams.
    if (!chosen) return { ...result, error: "That Linear workspace isn't connected." };
    try {
      const data = await linear.query(chosen.id, ROUTINE_TEAMS);
      result.teams = (data?.teams?.nodes ?? []).map((node) => ({ key: node.key, name: node.name })).toSorted((a, b) => a.name.localeCompare(b.name));
      if (typeof team === "string" && team.trim()) {
        const options = await linear.query(chosen.id, ROUTINE_TEAM_OPTIONS, { team: team.trim() });
        result.labels = [...new Set((options?.issueLabels?.nodes ?? []).map((node) => node.name))].toSorted((a, b) => a.localeCompare(b));
        result.states = (options?.teams?.nodes?.[0]?.states?.nodes ?? [])
          .toSorted((a, b) => a.position - b.position)
          .map((node) => ({ name: node.name, type: node.type }));
      }
      return result;
    } catch (error) {
      return { ...result, error: error.message };
    }
  }

  /** Drops one issue's copy, after it changed in Linear. */
  function forget(key, workspace) {
    cache.delete(`${workspace}:${String(key).toUpperCase()}`);
  }

  return { list, readIssue, worktreeIssues, markStarted, routineOptions, forget };
}

module.exports = { createLinearIssues, POLL_ISSUES, POLL_COMMENTS, ISSUE_HISTORY, ROUTINE_TEAMS, ROUTINE_TEAM_OPTIONS };
