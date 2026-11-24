const { createGit, callbackExec } = require("./git/client.cjs");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { scheduled } = require("./process-lanes.cjs");

// createGit owns Git scheduling. Keep its executor raw; schedule only gh at the call sites below.
const execFileAsync = promisify(execFile);

const FIELDS = "number,url,state,title,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup";
// What a chat's commands can name: a PR URL or a number in the chat's repository, a branch its `git push` updated in a
// repository (`push:<owner>/<repo>:<branch>`, that branch's newest PR from that repository), or the branch a
// `gh pr merge` of the checked-out branch merged (`branch:<branch>`). Nothing gh reads as a flag.
const BRANCH_NAME = String.raw`(?!-)(?!.*\.\.)(?!.*//)[\w./-]{1,200}`;
const NAMED_BRANCH = new RegExp(String.raw`^(?:push:([\w.-]+/[\w.-]+):|branch:)(${BRANCH_NAME})$`);
const PR_REF = new RegExp(String.raw`^(?:\d+|https?://[^\s/]+/[\w.-]+/[\w.-]+/pull/\d+|push:[\w.-]+/[\w.-]+:${BRANCH_NAME}|branch:${BRANCH_NAME})$`);
/** The branch a `push:` or `branch:` ref names, with the repository a push went to; null for any other ref. */
function namedBranch(ref) {
  const match = typeof ref === "string" ? NAMED_BRANCH.exec(ref) : null;
  return match ? { branch: match[2], repo: match[1] ?? null } : null;
}
/** Whether a ref keeps being read after its PR merged: a pushed branch may get a new PR. */
const followsBranch = (ref) => typeof ref === "string" && ref.startsWith("push:");
// A chat that ran a long loop of `gh pr create` still makes a bounded number of lookups.
const MAX_REFS = 20;

const execOptions = (cwd) => ({
  cwd,
  encoding: "utf8",
  timeout: 15_000,
  maxBuffer: 1024 * 1024,
  env: { ...process.env, GH_PROMPT_DISABLED: "1" },
});

/**
 * Whether the checked-out branch has any PR, in any state (OPEN, CLOSED or MERGED): `known: false` when git or gh
 * failed, so a caller can tell "no PR" (`known: true, pr: null`) from "couldn't ask". Never throws.
 */
async function readPullRequestState(cwd, exec = execFileAsync) {
  try {
    const git = createGit({ execFile: callbackExec(exec) }).read;
    const { stdout: branchOutput } = await git.checked(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const branch = branchOutput.trim();
    if (!branch) return { known: false, pr: null };
    const { stdout } = await scheduled(exec)("gh", ["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", FIELDS], execOptions(cwd));
    return { known: true, pr: JSON.parse(stdout)[0] ?? null };
  } catch {
    // No PR, offline, or gh unavailable: this optional metadata never blocks a chat.
    return { known: false, pr: null };
  }
}

async function readPullRequest(cwd, exec = execFileAsync) {
  return toPullRequest((await readPullRequestState(cwd, exec)).pr);
}

/** The branch's newest PR; with `repo`, the newest one whose head is that repository's branch, not a fork's namesake. */
async function readBranchPullRequest(cwd, branch, exec, repo = null) {
  const fields = repo ? `${FIELDS},headRepository,headRepositoryOwner` : FIELDS;
  const args = ["pr", "list", "--head", branch, "--state", "all", "--limit", repo ? "10" : "1", "--json", fields];
  const { stdout } = await scheduled(exec)("gh", args, execOptions(cwd));
  const prs = JSON.parse(stdout);
  const head = (pr) => `${pr?.headRepositoryOwner?.login}/${pr?.headRepository?.name}`.toLowerCase();
  return toPullRequest(repo ? prs.find((pr) => head(pr) === repo.toLowerCase()) : prs[0]);
}

// Two `gh pr list` per repository answer every worktree's branch, instead of one query per worktree
const BATCH_LIMIT = 100;
const BATCH_FIELDS = FIELDS.split(",")
  .filter((field) => field !== "statusCheckRollup")
  .join(",");
const BATCH_TTL = 2000;
const batchOptions = (cwd) => ({ ...execOptions(cwd), timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });

function createPullRequestReader({ exec = execFileAsync, now = Date.now, ttlMs = BATCH_TTL } = {}) {
  const batches = new Map();
  function batchFor(cwd, repo) {
    const hit = batches.get(repo);
    if (hit && now() - hit.at < ttlMs) return hit.read;
    const list = (state, fields) =>
      scheduled(exec)("gh", ["pr", "list", "--state", state, "--limit", String(BATCH_LIMIT), "--json", `${fields},headRefName`], batchOptions(cwd)).then(
        ({ stdout }) => {
          const parsed = JSON.parse(stdout);
          if (!Array.isArray(parsed)) throw new Error("Unexpected gh output");
          return parsed;
        },
      );
    const read = Promise.all([list("all", BATCH_FIELDS), list("open", FIELDS)]).then(([all, open]) => {
      const checks = new Map(open.map((pr) => [pr?.number, pr?.statusCheckRollup]));
      const byBranch = new Map();
      for (const pr of all) {
        if (typeof pr?.headRefName !== "string" || byBranch.has(pr.headRefName)) continue;
        if (pr.state !== "OPEN") byBranch.set(pr.headRefName, pr);
        else byBranch.set(pr.headRefName, checks.has(pr.number) ? { ...pr, statusCheckRollup: checks.get(pr.number) } : null);
      }
      return { byBranch, truncated: all.length >= BATCH_LIMIT };
    });
    batches.set(repo, { at: now(), read });
    if (batches.size > 50) batches.delete(batches.keys().next().value);
    read.catch(() => {
      if (batches.get(repo)?.read === read) batches.delete(repo);
    });
    return read;
  }
  return async function readPullRequestBatched(cwd) {
    try {
      const client = createGit({ execFile: callbackExec(exec) }).read;
      const { stdout: branchOutput } = await client.checked(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
      const branch = branchOutput.trim();
      if (!branch) return null;
      const repo = await client.commonDir(cwd).catch(() => null);
      const batch = repo ? await batchFor(cwd, repo).catch(() => null) : null;
      if (batch) {
        const pr = batch.byBranch.get(branch);
        if (pr) return toPullRequest(pr);
        if (!batch.truncated && !batch.byBranch.has(branch)) return null;
      }
      return await readBranchPullRequest(cwd, branch, exec);
    } catch {
      return null;
    }
  };
}

async function readPullRequests(cwd, refs, exec = execFileAsync) {
  if (!Array.isArray(refs)) return [];
  return Promise.all(
    refs.slice(0, MAX_REFS).map(async (ref) => {
      if (typeof ref !== "string" || !PR_REF.test(ref)) return null;
      try {
        const named = namedBranch(ref);
        if (named) return await readBranchPullRequest(cwd, named.branch, exec, named.repo);
        const { stdout } = await scheduled(exec)("gh", ["pr", "view", ref, "--json", FIELDS], execOptions(cwd));
        return toPullRequest(JSON.parse(stdout));
      } catch {
        return null;
      }
    }),
  );
}

function toPullRequest(pr) {
  if (!pr || !["OPEN", "MERGED", "CLOSED"].includes(pr.state) || !Number.isSafeInteger(pr.number) || pr.number <= 0) return null;
  const url = new URL(pr.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const readyToMerge = pr.state === "OPEN" && pr.isDraft === false && pr.reviewDecision === "APPROVED" && pr.mergeStateStatus === "CLEAN";
  const hasConflicts = pr.state === "OPEN" && pr.mergeStateStatus === "DIRTY";
  const conflictStatusKnown = typeof pr.mergeStateStatus === "string" && pr.mergeStateStatus !== "UNKNOWN";
  const isBehind = pr.state === "OPEN" && pr.mergeStateStatus === "BEHIND";
  const changesRequested = pr.state === "OPEN" && pr.reviewDecision === "CHANGES_REQUESTED";
  const checks = pr.state === "OPEN" ? checksState(pr.statusCheckRollup) : undefined;
  return {
    number: pr.number,
    url: url.href,
    state: pr.state,
    title: typeof pr.title === "string" ? pr.title : "",
    isDraft: pr.state === "OPEN" && pr.isDraft === true,
    readyToMerge,
    hasConflicts,
    conflictStatusKnown,
    isBehind,
    changesRequested,
    ...(checks && { checks }),
  };
}

const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
const RUNNING_STATES = new Set(["PENDING", "EXPECTED"]);
const ROLLUP_FAILED = new Set(["FAILURE", "ERROR"]);

function fromGraphql(node) {
  if (!node || typeof node !== "object") return null;
  const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  return toPullRequest({ ...node, statusCheckRollup: typeof rollup === "string" ? rollup : null });
}
const PULL_REQUEST_FIELDS = "number url state title isDraft reviewDecision mergeStateStatus commits(last:1){nodes{commit{statusCheckRollup{state}}}}";

function checksState(rollup) {
  if (typeof rollup === "string")
    return ROLLUP_FAILED.has(rollup) ? "failed" : RUNNING_STATES.has(rollup) ? "running" : rollup === "SUCCESS" ? "passed" : undefined;
  if (!Array.isArray(rollup)) return undefined;
  let running = false;
  let seen = false;
  for (const check of rollup) {
    if (!check || typeof check !== "object") continue;
    const outcome = typeof check.conclusion === "string" ? check.conclusion : typeof check.state === "string" ? check.state : "";
    if (!outcome && typeof check.status !== "string") continue;
    seen = true;
    if (FAILED_CONCLUSIONS.has(outcome)) return "failed";
    const done = typeof check.status === "string" ? check.status === "COMPLETED" : !RUNNING_STATES.has(outcome);
    if (!done) running = true;
  }
  return running ? "running" : seen ? "passed" : undefined;
}

const OPEN_LIMIT = 20;

/** The open PRs of the repository `cwd` is in, as `toPullRequest` reads them plus when each was last updated. Throws when gh fails. */
async function listOpenPullRequests(cwd, exec = execFileAsync) {
  const { stdout } = await scheduled(exec)(
    "gh",
    ["pr", "list", "--state", "open", "--limit", String(OPEN_LIMIT), "--json", `${FIELDS},updatedAt`],
    execOptions(cwd),
  );
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error("Unexpected gh output");
  return parsed.flatMap((item) => {
    const pr = toPullRequest(item);
    if (!pr) return [];
    const updatedAt = typeof item.updatedAt === "string" && !Number.isNaN(Date.parse(item.updatedAt)) ? item.updatedAt : undefined;
    return [{ ...pr, ...(updatedAt && { updatedAt }) }];
  });
}

module.exports = {
  listOpenPullRequests,
  readPullRequest,
  readPullRequestState,
  readPullRequests,
  createPullRequestReader,
  fromGraphql,
  PULL_REQUEST_FIELDS,
  PR_REF,
  namedBranch,
  followsBranch,
  MAX_REFS,
};
