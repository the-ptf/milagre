const { createGit, callbackExec } = require("./git/client.cjs");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { scheduled } = require("./process-lanes.cjs");

// createGit owns Git scheduling. Keep its executor raw; schedule only gh at the call sites below.
const execFileAsync = promisify(execFile);

const FIELDS = "number,url,state,title,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup";
// What a chat's commands can name: a PR URL or a number in the chat's repository. Nothing gh reads as a flag.
const PR_REF = /^(?:\d+|https?:\/\/[^\s/]+\/[\w.-]+\/[\w.-]+\/pull\/\d+)$/;
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

/** Resolve the latest PR for the checked-out branch, including PRs submitted from a fork. */
async function readPullRequest(cwd, exec = execFileAsync) {
  return toPullRequest((await readPullRequestState(cwd, exec)).pr);
}

// `pr view` can infer the wrong head repository for a fork or a branch tracking main.
async function readBranchPullRequest(cwd, branch, exec) {
  const { stdout } = await scheduled(exec)("gh", ["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", FIELDS], execOptions(cwd));
  return toPullRequest(JSON.parse(stdout)[0]);
}

// Two `gh pr list` per repository answer every worktree's branch, instead of one query per worktree
// every refresh. Calls arriving together (the renderer asks for each worktree at once) share them; the
// short TTL keeps a turn-end refresh, which exists to catch a just-created PR, from reading stale data.
// Checks come only with the open PRs: a hundred PRs' check rollups take GitHub ~7 s, and only an open PR shows them.
const BATCH_LIMIT = 100;
const BATCH_FIELDS = FIELDS.split(",")
  .filter((field) => field !== "statusCheckRollup")
  .join(",");
const BATCH_TTL = 2000;
const batchOptions = (cwd) => ({ ...execOptions(cwd), timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });

/**
 * A `readPullRequest(cwd)` that batches by repository. A branch absent from a full (truncated) batch, or
 * a failed batch, falls back to the per-branch query, so the answer is the same as `readPullRequest`'s.
 */
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
      // Newest first, so the first PR seen for a branch is its latest, as `--head <branch> --limit 1` returns.
      const byBranch = new Map();
      for (const pr of all) {
        if (typeof pr?.headRefName !== "string" || byBranch.has(pr.headRefName)) continue;
        // An open PR the open list missed (past its limit, or opened between the two reads) has no checks here:
        // null leaves its branch to the per-branch query.
        if (pr.state !== "OPEN") byBranch.set(pr.headRefName, pr);
        else byBranch.set(pr.headRefName, checks.has(pr.number) ? { ...pr, statusCheckRollup: checks.get(pr.number) } : null);
      }
      return { byBranch, truncated: all.length >= BATCH_LIMIT };
    });
    batches.set(repo, { at: now(), read });
    if (batches.size > 50) batches.delete(batches.keys().next().value);
    // A failed read isn't kept: the next call retries rather than serving the failure.
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

/** The PRs a chat created or merged, by URL or number, looked up from its folder; null where one can't be read. */
async function readPullRequests(cwd, refs, exec = execFileAsync) {
  if (!Array.isArray(refs)) return [];
  return Promise.all(
    refs.slice(0, MAX_REFS).map(async (ref) => {
      if (typeof ref !== "string" || !PR_REF.test(ref)) return null;
      try {
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
  // CLEAN means GitHub reports the PR mergeable with passing commit status. Unknown or blocked
  // states must never advertise readiness, even if a reviewer has already approved.
  const readyToMerge = pr.state === "OPEN" && pr.isDraft === false && pr.reviewDecision === "APPROVED" && pr.mergeStateStatus === "CLEAN";
  const hasConflicts = pr.state === "OPEN" && pr.mergeStateStatus === "DIRTY";
  const conflictStatusKnown = typeof pr.mergeStateStatus === "string" && pr.mergeStateStatus !== "UNKNOWN";
  // BEHIND only shows up when the base branch requires PRs to be up to date before merging.
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

// GitHub counts these check-run conclusions and commit-status states against the PR, as its merge box does.
const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
const RUNNING_STATES = new Set(["PENDING", "EXPECTED"]);
const ROLLUP_FAILED = new Set(["FAILURE", "ERROR"]);

/** A PR node from GraphQL (the fields of `PULL_REQUEST_FIELDS`) as `toPullRequest` reads it, checks rolled up. */
function fromGraphql(node) {
  if (!node || typeof node !== "object") return null;
  const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  return toPullRequest({ ...node, statusCheckRollup: typeof rollup === "string" ? rollup : null });
}
// What `fromGraphql` reads: the fields of `FIELDS`, with one rolled-up checks state instead of every check.
const PULL_REQUEST_FIELDS = "number url state title isDraft reviewDecision mergeStateStatus commits(last:1){nodes{commit{statusCheckRollup{state}}}}";

/**
 * "failed" when any check or commit status failed, "running" when none failed but some are still
 * to finish; nothing when they all passed or the PR has none. A failure outranks running checks,
 * since the branch needs a fix either way.
 */
function checksState(rollup) {
  // GraphQL's rolled-up state (`statusCheckRollup { state }`), which ranks a failure over pending checks the same way.
  if (typeof rollup === "string") return ROLLUP_FAILED.has(rollup) ? "failed" : RUNNING_STATES.has(rollup) ? "running" : undefined;
  if (!Array.isArray(rollup)) return undefined;
  let running = false;
  for (const check of rollup) {
    if (!check || typeof check !== "object") continue;
    // A check run reports status + conclusion; a commit status (legacy API) reports a single state.
    const outcome = typeof check.conclusion === "string" ? check.conclusion : typeof check.state === "string" ? check.state : "";
    if (FAILED_CONCLUSIONS.has(outcome)) return "failed";
    const done = typeof check.status === "string" ? check.status === "COMPLETED" : !RUNNING_STATES.has(outcome);
    if (!done) running = true;
  }
  return running ? "running" : undefined;
}

module.exports = {
  readPullRequest,
  readPullRequestState,
  readPullRequests,
  createPullRequestReader,
  fromGraphql,
  PULL_REQUEST_FIELDS,
  PR_REF,
  MAX_REFS,
};
