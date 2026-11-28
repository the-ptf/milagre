const os = require("node:os");
const { z } = require("zod");
const { background, scheduled } = require("./process-lanes.cjs");
const { CHECK_ORDER, defaultExec, ghMessage, ghOptions, ghTimeout, retryTransient, toCheck } = require("./pull-request-review.cjs");

// GitHub rejects search queries over 256 characters, and a whole search when one repo in it is unknown, so repos are
// resolved first (that also follows renames) and searched in chunks that fit.
const QUERY_LIMIT = 256;
// GitHub answers 502 when a query runs past its time limit; 100 rows with check counts each did. A retry asks for half.
const PAGE = 50;
// Merged, closed and all stop at a search's newest MAX_ROWS: paging a repository's whole history every minute is what
// kept GitHub timing out. Open PRs are always read in full.
const MAX_ROWS = 300;
const LIST_TTL_MS = 60_000;
const QUIET_STALE_MS = 5 * 60_000;
const REPO_TTL_MS = 60 * 60_000;
const CHECKS_TTL_MS = 30_000;
const NAME = /^[A-Za-z0-9_.-]+$/;
const STATE_QUALIFIER = { open: "is:open", merged: "is:merged", closed: "is:closed is:unmerged", all: "" };

const ROW = `... on PullRequest{number title url state isDraft createdAt updatedAt additions deletions mergeable reviewDecision headRefName baseRefName
author{login avatarUrl} repository{nameWithOwner} labels(first:10){nodes{name color}}
reviewRequests(first:20){nodes{requestedReviewer{__typename ... on User{login}}}}
commits(last:1){nodes{commit{statusCheckRollup{state contexts{checkRunCountsByState{state count} statusContextCountsByState{state count}}}}}}}`;
const PAGE_FIELDS = `pageInfo{endCursor hasNextPage} nodes{${ROW}}`;
const SEARCH_QUERY = `query($q:String!,$first:Int!,$after:String){viewer{login} search(query:$q,type:ISSUE,first:$first,after:$after){issueCount ${PAGE_FIELDS}}}`;
const REPO_QUERY = `query($owner:String!,$name:String!,$states:[PullRequestState!],$first:Int!,$after:String){repository(owner:$owner,name:$name){
pullRequests(states:$states,first:$first,after:$after,orderBy:{field:UPDATED_AT,direction:DESC}){${PAGE_FIELDS}}}}`;
const CHECKS_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{kind:__typename
... on CheckRun{name status conclusion detailsUrl startedAt completedAt checkSuite{workflowRun{workflow{name}}}}
... on StatusContext{context state targetUrl createdAt}}}}}}}}}}`;

const RUNNING = new Set(["IN_PROGRESS", "PENDING", "QUEUED", "WAITING", "REQUESTED", "EXPECTED"]);
const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
const SKIPPED = new Set(["SKIPPED", "NEUTRAL", "STALE"]);

function toChecks(rollup) {
  const checks = { state: "none", passed: 0, failed: 0, running: 0, skipped: 0, total: 0 };
  const counts = [...(rollup?.contexts?.checkRunCountsByState ?? []), ...(rollup?.contexts?.statusContextCountsByState ?? [])];
  for (const { state, count } of counts) {
    const n = Number(count) || 0;
    if (!n) continue;
    checks.total += n;
    if (FAILED.has(state)) checks.failed += n;
    else if (RUNNING.has(state)) checks.running += n;
    else if (SKIPPED.has(state)) checks.skipped += n;
    else checks.passed += n;
  }
  checks.state = checks.failed ? "fail" : checks.running ? "running" : checks.passed ? "pass" : "none";
  return checks;
}

const enumOr = (value, allowed) => (allowed.includes(value) ? value : null);

function toItem(node, viewer) {
  const reviewers = (node.reviewRequests?.nodes ?? []).map((request) => request?.requestedReviewer?.login).filter(Boolean);
  const author = node.author?.login ? { login: node.author.login, avatarUrl: node.author.avatarUrl || null } : null;
  return {
    url: node.url,
    repo: node.repository?.nameWithOwner ?? "",
    number: node.number,
    title: node.title ?? "",
    state: enumOr(node.state, ["OPEN", "MERGED", "CLOSED"]) ?? "OPEN",
    isDraft: node.isDraft === true,
    author,
    headRefName: node.headRefName ?? "",
    baseRefName: node.baseRefName ?? "",
    additions: Number(node.additions) || 0,
    deletions: Number(node.deletions) || 0,
    createdAt: node.createdAt ?? "",
    updatedAt: node.updatedAt ?? "",
    mergeable: enumOr(node.mergeable, ["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
    reviewDecision: enumOr(node.reviewDecision, ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]),
    reviewRequested: Boolean(viewer) && reviewers.includes(viewer),
    authored: Boolean(viewer) && author?.login === viewer,
    labels: (node.labels?.nodes ?? []).filter((label) => label?.name).map((label) => ({ name: label.name, color: label.color ?? "" })),
    checks: toChecks(node.commits?.nodes?.[0]?.commit?.statusCheckRollup),
    projects: [],
    chats: [],
  };
}

/** `owner/name` from an origin id like `github.com/owner/name`; null for other hosts. */
function githubRepo(origin) {
  const match = /^github\.com\/([^/]+)\/([^/]+)$/.exec(origin ?? "");
  return match && NAME.test(match[1]) && NAME.test(match[2]) ? { owner: match[1], name: match[2] } : null;
}

/** Search queries for `repos` that each stay under GitHub's limit. */
function searchQueries(repos, state) {
  const tail = ` is:pr ${STATE_QUALIFIER[state] ?? STATE_QUALIFIER.open} sort:updated-desc`.replace(/\s+/g, " ");
  const queries = [];
  let current = [];
  for (const repo of repos) {
    const next = [...current, `repo:${repo}`];
    if (current.length && next.join(" ").length + tail.length > QUERY_LIMIT) {
      queries.push(current.join(" ") + tail);
      current = [`repo:${repo}`];
    } else current = next;
  }
  if (current.length) queries.push(current.join(" ") + tail);
  return queries;
}

/**
 * Reads the PRs of every Project's GitHub repository through `gh`, on this computer's account. `projects` gives
 * `{ path, name, origin }`; `chatsFor(url)` the Chats that opened or pushed to a PR.
 */
function createPullRequestList({ exec = defaultExec, env = process.env, now = Date.now, cwd = os.homedir(), retry } = {}) {
  const run = scheduled(exec);
  const repoCache = new Map();
  const lists = new Map();
  const checks = new Map();
  const lastRows = new Map();

  /** One GraphQL read, asked again with half the page (`first`) each time GitHub fails it on its side. */
  async function graphql(query, variables) {
    try {
      return await retryTransient(async (attempt) => {
        const args = ["api", "graphql", "-f", `query=${query}`];
        for (const [key, value] of Object.entries(variables)) {
          if (Array.isArray(value)) {
            for (const entry of value) args.push("-f", `${key}[]=${entry}`);
          } else {
            const sent = key === "first" ? Math.max(1, value >> attempt) : value;
            args.push(typeof sent === "number" ? "-F" : "-f", `${key}=${sent}`);
          }
        }
        const { stdout } = await run("gh", args, ghOptions(cwd, env));
        return JSON.parse(stdout);
      }, retry);
    } catch (error) {
      throw new Error(ghMessage(error), { cause: error });
    }
  }

  function partialData(error) {
    try {
      return JSON.parse(String(error.cause?.stdout || "null"))?.data ?? null;
    } catch {
      return null;
    }
  }

  async function canonical(origins) {
    const at = now();
    const missing = origins.filter((origin) => !(repoCache.get(origin)?.until > at));
    const targets = missing.map((origin) => ({ origin, repo: githubRepo(origin) }));
    for (const { origin, repo } of targets) if (!repo) repoCache.set(origin, { repo: null, until: at + REPO_TTL_MS });
    const asked = targets.filter((target) => target.repo);
    if (asked.length) {
      const fields = asked.map(({ repo }, index) => `r${index}:repository(owner:"${repo.owner}",name:"${repo.name}"){nameWithOwner}`);
      const result = await graphql(`query{${fields.join(" ")}}`, {}).catch((error) => {
        const partial = partialData(error);
        if (partial) return { data: partial };
        if (ghTimeout(error) && asked.every(({ origin }) => repoCache.has(origin))) return null;
        throw error;
      });
      if (result)
        asked.forEach(({ origin }, index) => repoCache.set(origin, { repo: result?.data?.[`r${index}`]?.nameWithOwner ?? null, until: at + REPO_TTL_MS }));
    }
    return new Map(origins.map((origin) => [origin, repoCache.get(origin)?.repo ?? null]));
  }

  async function read(projects, state, chatsFor) {
    const origins = [...new Set(projects.map((project) => project.origin).filter(Boolean))];
    const repoOf = await canonical(origins);
    const byRepo = new Map();
    for (const project of projects) {
      const repo = repoOf.get(project.origin);
      if (!repo) continue;
      const key = repo.toLowerCase();
      if (!byRepo.has(key)) byRepo.set(key, { repo, projects: [] });
      byRepo.get(key).projects.push({ path: project.path, name: project.name, cwd: project.cwd ?? project.path });
    }
    const repos = [...byRepo.values()].map((entry) => entry.repo);
    const errors = [];
    let viewer = null;
    const items = new Map();
    async function collect(rows, connection, next) {
      const cursors = new Set();
      let seen = 0;
      while (connection) {
        for (const node of connection.nodes ?? []) if (node?.url) rows.set(node.url, node);
        seen += connection.nodes?.length ?? 0;
        if (!connection.pageInfo?.hasNextPage || (state !== "open" && seen >= MAX_ROWS)) break;
        const cursor = connection.pageInfo.endCursor;
        if (!cursor || cursors.has(cursor)) throw new Error("GitHub did not return the next page of pull requests.");
        cursors.add(cursor);
        connection = await next(cursor);
      }
    }
    const queries = searchQueries(repos, state);
    const keys = new Set(queries.map((q) => `${state} ${q}`));
    for (const key of lastRows.keys()) if (key.startsWith(`${state} `) && !keys.has(key)) lastRows.delete(key);
    await Promise.all(
      queries.map(async (q) => {
        const key = `${state} ${q}`;
        const rows = new Map();
        try {
          const result = await graphql(SEARCH_QUERY, { q, first: PAGE });
          viewer ??= result?.data?.viewer?.login ?? null;
          const search = result?.data?.search;
          if (search?.issueCount > 1000) {
            for (const match of q.matchAll(/(?:^| )repo:([^/ ]+)\/([^ ]+)/g)) {
              const variables = { owner: match[1], name: match[2], ...(state === "all" ? {} : { states: [state.toUpperCase()] }), first: PAGE };
              const page = async (after) => (await graphql(REPO_QUERY, { ...variables, ...(after ? { after } : {}) })).data.repository.pullRequests;
              await collect(rows, await page(), page);
            }
          } else await collect(rows, search, async (after) => (await graphql(SEARCH_QUERY, { q, first: PAGE, after })).data.search);
          lastRows.set(key, { at: now(), viewer, rows });
        } catch (error) {
          const timeout = ghTimeout(error);
          const last = timeout ? lastRows.get(key) : undefined;
          if (!last) {
            errors.push(error.message);
            return;
          }
          viewer ??= last.viewer;
          for (const [url, node] of last.rows) if (!rows.has(url)) rows.set(url, node);
          if (now() - last.at >= QUIET_STALE_MS) errors.push(`${timeout} Showing the last pull requests loaded.`);
        } finally {
          for (const [url, node] of rows) items.set(url, node);
        }
      }),
    );
    const found = [...items.values()].map((node) => {
      const item = toItem(node, viewer);
      item.projects = byRepo.get(item.repo.toLowerCase())?.projects ?? [];
      item.chats = chatsFor(item.url);
      return item;
    });
    return { viewer, fetchedAt: now(), repos, items: found, errors };
  }

  /** The list for `state`; a cached answer under a minute old unless `force`. Runs in the background lane. */
  function list({ projects, state = "open", force = false, chatsFor = () => [] }) {
    const key = state in STATE_QUALIFIER ? state : "open";
    const hit = lists.get(key);
    if (!force && hit && now() - hit.at < LIST_TTL_MS) return hit.read;
    const fresh = background(() => read(projects, key, chatsFor));
    lists.set(key, { at: now(), read: fresh });
    fresh.catch(() => lists.get(key)?.read === fresh && lists.delete(key));
    return fresh;
  }

  /** Every check on a PR's head commit, failures first, for the checks hover card. */
  function checksOf({ repo, number }) {
    const [owner, name] = String(repo ?? "").split("/");
    if (!NAME.test(owner ?? "") || !NAME.test(name ?? "") || !Number.isSafeInteger(number) || number < 1)
      throw new Error("Name a PR as owner/name and number.");
    const key = `${repo}#${number}`;
    const hit = checks.get(key);
    if (hit && now() - hit.at < CHECKS_TTL_MS) return hit.read;
    const fresh = graphql(CHECKS_QUERY, { owner, name, number }).then((result) => {
      const nodes = result?.data?.repository?.pullRequest?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
      return nodes
        .map((node) => {
          const check = toCheck(node);
          return {
            name: check.name,
            workflow: check.workflow ?? null,
            state: check.outcome,
            url: check.url ?? null,
            startedAt: node?.startedAt ?? node?.createdAt ?? null,
            completedAt: node?.completedAt ?? null,
          };
        })
        .sort((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state] || a.name.localeCompare(b.name));
    });
    checks.set(key, { at: now(), read: fresh });
    const forget = () => checks.get(key)?.read === fresh && checks.delete(key);
    fresh.then((found) => found.length || forget(), forget);
    return fresh;
  }

  return { list, checksOf };
}

/** The `pull_requests_list` agent tool. A connection scoped to some Projects sees only their PRs. */
function pullRequestTools({ read, act, host, scope, inProjectScope, caller }) {
  return [
    read(
      "pull_requests_list",
      "List GitHub pull requests in the repositories of this computer's Projects (open by default), newest first, with checks, review decision, whether the user's review is requested, and the Chats that opened them.",
      { state: z.enum(["open", "merged", "closed", "all"]).default("open") },
      async ({ state }) => {
        const list = await host.pullRequests({ state });
        const active = scope();
        const items = list.items
          .map((item) => ({ ...item, projects: item.projects.filter((project) => inProjectScope(active, project.path)) }))
          .filter((item) => item.projects.length);
        return { ...list, items };
      },
    ),
    act(
      "pr_review_report",
      "Hand a finished pull request review to Milagre: the PR's URL, a short summary and every finding (path, line, severity high/medium/low, title, body, suggestion). Milagre shows them on the PR and can send them to the Chat that fixes it. Works while the review agent is on in Settings › Church.",
      "create",
      {
        url: z.string().min(1).max(300),
        summary: z.string().max(2000).default(""),
        findings: z
          .array(
            z.object({
              path: z.string().min(1).max(500),
              line: z.number().int().positive().optional(),
              severity: z.enum(["high", "medium", "low"]),
              title: z.string().min(1).max(200),
              body: z.string().max(4000).default(""),
              suggestion: z.string().max(4000).optional(),
            }),
          )
          .max(50),
      },
      async (args) => {
        const active = scope();
        if (active.projectPaths !== "*") {
          const list = await host.pullRequests({ state: "open" });
          const pr = list.items.find((item) => item.url === args.url);
          if (!pr?.projects.some((project) => inProjectScope(active, project.path))) throw new Error("This PR is outside the connection's Projects.");
        }
        return host.reviewReport(args, caller ?? null);
      },
    ),
  ];
}

module.exports = { pullRequestTools, createPullRequestList, searchQueries, toChecks, githubRepo };
