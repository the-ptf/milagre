const { defaultExec, ghMessage, ghOptions } = require("../pull-request-review.cjs");

// Babysit PRs: read a watched PR's state through gh and compare two readings to decide what is new and whether
// babysitting should stop. The poller calls readPullRequestSnapshot on an interval and feeds the last two readings
// to diffSnapshots, which is pure.

/** The agent's own PR comments carry this, so a babysat PR never wakes itself. */
const BABYSIT_MARKER = "<!-- milagre-babysit -->";

const VIEW_FIELDS = "state,reviewDecision,mergeStateStatus,mergeable,statusCheckRollup,headRefName,baseRefName,comments,reviews";
const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){pullRequest(number:$number){
    reviewThreads(first:100){nodes{id isResolved comments(first:50){nodes{id body author{login}}}}}
  }}
}`;

// The check-run conclusions and commit-status states GitHub counts against the PR, as its merge box does.
const FAILED = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const FAILED_STATUS = new Set(["FAILURE", "ERROR"]);
const PENDING_STATUS = new Set(["PENDING", "EXPECTED"]);
const COMMENT_PREVIEW = 200;

const text = (value) => (typeof value === "string" ? value : "");
const login = (actor) => text(actor?.login) || "ghost";

/** `https://github.com/o/r/pull/12` -> `{ repo: "github.com/o/r", number: 12 }`; GHE hosts are kept. */
function parsePullRequestUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return null;
  }
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/.exec(url.pathname);
  if (!match || !/^https?:$/.test(url.protocol)) return null;
  return { repo: `${url.host}/${match[1]}/${match[2]}`, number: Number(match[3]) };
}

function splitRepo(repo) {
  const [host, owner, name] = String(repo).split("/");
  if (!host || !owner || !name) throw new Error(`Not a host/owner/repo: ${repo}`);
  return { host, owner, name };
}

/** Names of the checks that failed, and how many have yet to finish. */
function classifyChecks(rollup) {
  const failing = new Set();
  let pending = 0;
  for (const check of Array.isArray(rollup) ? rollup : []) {
    if (!check || typeof check !== "object") continue;
    if (typeof check.context === "string" && typeof check.state === "string") {
      if (FAILED_STATUS.has(check.state)) failing.add(text(check.context));
      else if (PENDING_STATUS.has(check.state)) pending += 1;
      continue;
    }
    if (check.status !== "COMPLETED") pending += 1;
    else if (FAILED.has(text(check.conclusion))) failing.add(text(check.name));
  }
  return { failingChecks: [...failing].filter(Boolean), pendingChecks: pending };
}

async function readPullRequestSnapshot({ repo, number }, { exec = defaultExec, env = process.env, settings } = {}) {
  const { host, owner, name } = splitRepo(repo);
  const options = ghOptions(undefined, env);
  async function gh(args) {
    try {
      return (await exec("gh", args, options)).stdout;
    } catch (error) {
      throw new Error(ghMessage(error), { cause: error });
    }
  }

  const view = JSON.parse(await gh(["pr", "view", String(number), "-R", repo, "--json", VIEW_FIELDS]));
  const threadsReply = JSON.parse(
    await gh(["api", "graphql", "--hostname", host, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`, "-f", `query=${THREADS_QUERY}`]),
  );
  if (threadsReply?.errors?.length) throw new Error(text(threadsReply.errors[0]?.message) || "GitHub didn't answer.");

  const comments = new Map();
  const add = (id, body, author, threadId) => {
    if (id && !comments.has(id)) comments.set(id, { id, body, author, threadId });
  };
  for (const node of view.comments ?? []) add(text(node?.id), text(node?.body), login(node?.author), null);
  for (const node of view.reviews ?? []) if (text(node?.body).trim()) add(text(node?.id), text(node.body), login(node?.author), null);
  const unresolvedThreads = [];
  for (const thread of threadsReply?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []) {
    const threadId = text(thread?.id);
    if (thread?.isResolved === false && threadId) unresolvedThreads.push(threadId);
    for (const node of thread?.comments?.nodes ?? []) add(text(node?.id), text(node?.body), login(node?.author), threadId);
  }

  const mergeState = text(view.mergeStateStatus);
  const headRef = text(view.headRefName);
  const baseRef = text(view.baseRefName);
  let behindBy = 0;
  // GitHub already says BEHIND when it is; otherwise count the commits only when behind is something to wake on.
  if (mergeState !== "BEHIND" && settings?.wake?.includes("behind") && headRef && baseRef) {
    try {
      const out = await gh(["api", `repos/${owner}/${name}/compare/${baseRef}...${headRef}`, "--hostname", host, "--jq", ".behind_by"]);
      behindBy = Number.parseInt(out.trim(), 10) || 0;
    } catch {
      // A fork's branch can't be compared by name: leave behind to the merge state.
    }
  }

  return {
    state: text(view.state) || "OPEN",
    reviewDecision: text(view.reviewDecision) || null,
    mergeable: text(view.mergeable),
    mergeState,
    headRef,
    baseRef,
    behindBy,
    ...classifyChecks(view.statusCheckRollup),
    comments: [...comments.values()],
    unresolvedThreads,
  };
}

const isBehind = (snapshot) => snapshot?.mergeState === "BEHIND" || snapshot?.behindBy > 0;

/**
 * What is new between two readings, and whether babysitting should stop. The first reading is a baseline: it
 * reports only the failing checks and conflicts already there, never old comments or a branch already behind.
 */
function diffSnapshots(prev, next, settings) {
  const wake = new Set(settings?.wake ?? []);
  const base = next.baseRef || "the base branch";
  const changes = [];

  if (prev && wake.has("comments")) {
    const known = new Set(prev.comments.map((entry) => entry.id));
    for (const entry of next.comments) {
      if (known.has(entry.id) || entry.body.includes(BABYSIT_MARKER)) continue;
      changes.push({ id: `comment:${entry.id}`, text: `Review comment from @${entry.author}: ${entry.body.slice(0, COMMENT_PREVIEW)}` });
    }
  }
  if (wake.has("checks")) {
    const failing = new Set(prev?.failingChecks ?? []);
    for (const name of next.failingChecks) if (!failing.has(name)) changes.push({ id: `check:${name}`, text: `Check failed: ${name}` });
  }
  if (wake.has("conflicts") && next.mergeable === "CONFLICTING" && prev?.mergeable !== "CONFLICTING") {
    changes.push({ id: "conflict", text: `Merge conflicts with ${base}` });
  }
  if (prev && wake.has("behind") && isBehind(next) && !isBehind(prev)) {
    changes.push({ id: "behind", text: `Branch is behind ${base}` });
  }

  let stop = null;
  if (next.state !== "OPEN") stop = "closed";
  else if (
    settings?.stopWhenGreen &&
    next.failingChecks.length === 0 &&
    next.pendingChecks === 0 &&
    next.unresolvedThreads.length === 0 &&
    (next.reviewDecision === "APPROVED" || next.reviewDecision === null)
  ) {
    stop = "green";
  }
  return { changes, stop };
}

module.exports = { parsePullRequestUrl, readPullRequestSnapshot, diffSnapshots, BABYSIT_MARKER };
