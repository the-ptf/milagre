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
const STARTED_STATES = `query Started($id: String!) {
  issue(id: $id) { id state { type } team { states(filter: { type: { eq: "started" } }) { nodes { id position } } } }
}`;
const MOVE = "mutation Move($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }";
const NOT_STARTED = new Set(["triage", "backlog", "unstarted"]);

const ROUTINE_ISSUE_FIELDS =
  "id identifier title description url state { name type color } team { key } assignee { name } labels(first: 10) { nodes { name } }";
const HISTORY_FIELDS = "id createdAt toAssignee { isMe } addedLabels { name } toState { name }";
const POLL_ISSUES_PAGE = `issues(first: 25, after: $after, sort: [{ updatedAt: { order: Ascending } }], filter: { updatedAt: { gt: $since } }) {
    nodes { ${ROUTINE_ISSUE_FIELDS} updatedAt history(first: 10) { nodes { ${HISTORY_FIELDS} } pageInfo { hasNextPage endCursor } } }
    pageInfo { hasNextPage endCursor }
  }`;
const POLL_ISSUES = `query PollIssues($since: DateTimeOrDuration!, $after: String) {
  ${POLL_ISSUES_PAGE}
}`;
const POLL_ISSUES_RESUME = `query PollIssuesResume($since: DateTimeOrDuration!, $after: String!, $anchor: String!) {
  anchor: issue(id: $anchor) { id updatedAt }
  ${POLL_ISSUES_PAGE}
}`;
const ISSUE_HISTORY = `query IssueHistory($id: String!, $after: String) {
  issue(id: $id) { history(first: 50, after: $after) { nodes { ${HISTORY_FIELDS} } pageInfo { hasNextPage endCursor } } }
}`;
const POLL_COMMENTS = `query PollComments($since: DateTimeOrDuration!, $until: DateTimeOrDuration!, $after: String) {
  comments(first: 50, after: $after, filter: { createdAt: { gt: $since, lte: $until } }) {
    nodes { id body createdAt botActor { type } user { name displayName } issue { ${ROUTINE_ISSUE_FIELDS} } }
    pageInfo { hasNextPage endCursor }
  }
}`;
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

function isNotFound(error) {
  if (error?.code !== "failed") return false;
  const extensions = error.extensions ?? {};
  return [error.message, extensions.type, extensions.code].some((text) => typeof text === "string" && /not[ _]?found/i.test(text));
}

function createLinearIssues({ linear, now = Date.now }) {
  const cache = new Map();
  const teams = new Map();
  const assigned = new Map();

  function unavailable() {
    if (!linear.enabled()) return { error: OFF, notConnected: true };
    if (!linear.workspaces().length) return { error: DISCONNECTED, notConnected: true };
    return null;
  }

  const fromWorkspace = (workspace, node) => {
    const issue = toIssue(node);
    return issue ? { ...issue, workspace } : null;
  };

  async function fetchOne(workspace, key) {
    try {
      const data = await linear.query(workspace, ONE, { id: key });
      return fromWorkspace(workspace, data?.issue);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

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

  async function readIssues(wanted, { fresh = false } = {}) {
    const result = new Map();
    const missing = new Map();
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

  async function candidates(key, workspace, allowed) {
    const ids = linear
      .workspaces()
      .map((item) => item.id)
      .filter((id) => !allowed || allowed.includes(id));
    if (typeof workspace === "string") {
      const id = workspace.toLowerCase();
      if (ids.includes(id)) return [id];
      if (allowed) return [];
    }
    if (ids.length < 2) return ids;
    const team = key.split("-")[0];
    const owners = [];
    for (const id of ids) if ((await teamKeys(id).catch(() => null))?.has(team)) owners.push(id);
    return owners.length ? owners : ids;
  }

  async function readIssue(key, workspace, allowed) {
    const upper = String(key).toUpperCase();
    if (!isIssueKey(upper)) return null;
    for (const id of await candidates(upper, workspace, allowed)) {
      const issue = (await readIssues([[id, upper]], { fresh: true })).get(`${id}:${upper}`);
      if (issue) return issue;
    }
    return null;
  }

  async function list(query, { fresh = false, workspace } = {}) {
    const unready = unavailable();
    if (unready) return unready;
    const connected = linear.workspaces();
    const chosen = connected.find((item) => item.id === String(workspace ?? "").toLowerCase()) ?? connected[0];
    const named = { workspace: chosen.id, workspaces: connected.map((item) => ({ id: item.id, name: item.organization.name })) };
    const text = typeof query === "string" ? query.trim() : "";
    try {
      if (!text) {
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

  async function worktreeIssues(worktrees) {
    if (unavailable()) return {};
    try {
      const ids = linear.workspaces().map((item) => item.id);
      const named = [];
      for (const worktree of worktrees) {
        if (worktree.linearIssue === null) continue;
        if (worktree.linearIssue) {
          const key = String(worktree.linearIssue).toUpperCase();
          const stored = String(worktree.linearWorkspace ?? "").toLowerCase();
          const workspace = ids.includes(stored) ? stored : (await candidates(key).catch(() => ids))[0];
          if (workspace) named.push([worktree.path, workspace, key]);
          continue;
        }
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

  async function markStarted(key, workspace) {
    try {
      const data = await linear.query(workspace, STARTED_STATES, { id: key });
      const issue = data?.issue;
      if (!issue || !NOT_STARTED.has(issue.state?.type)) return "kept";
      const [target] = [...(issue.team?.states?.nodes ?? [])].sort((a, b) => a.position - b.position);
      if (!target) return "kept";
      const moved = await linear.query(workspace, MOVE, { id: issue.id, stateId: target.id });
      if (moved?.issueUpdate?.success !== true) return "failed";
      forget(key, workspace);
      return "moved";
    } catch {
      return "failed";
    }
  }

  async function routineOptions({ workspace, team } = {}) {
    const empty = { workspaces: [], teams: [], labels: [], states: [] };
    const unready = unavailable();
    if (unready) return { ...empty, error: unready.error };
    const connected = linear.workspaces();
    const result = { ...empty, workspaces: connected.map((item) => ({ id: item.id, name: item.organization?.name ?? item.id })) };
    const named = typeof workspace === "string" && workspace !== "";
    const chosen = named ? connected.find((item) => item.id === workspace.toLowerCase()) : connected[0];
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

  function forget(key, workspace) {
    cache.delete(`${workspace}:${String(key).toUpperCase()}`);
  }

  return { list, readIssue, worktreeIssues, markStarted, routineOptions, forget };
}

module.exports = { createLinearIssues, isNotFound, POLL_ISSUES, POLL_ISSUES_RESUME, POLL_COMMENTS, ISSUE_HISTORY, ROUTINE_TEAMS, ROUTINE_TEAM_OPTIONS };
