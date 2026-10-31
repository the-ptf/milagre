const { execFile } = require("node:child_process");
const { createGit } = require("./git/client.cjs");
const { createGitDiff } = require("./git-diff.cjs");
const { thisComputer } = require("@milagre/shared/host-computer");
const { scheduled } = require("./process-lanes.cjs");

// The PR a Chat's branch opened, read and reviewed through gh: one GraphQL query for everything the PR panel
// shows, and GraphQL mutations (or `gh pr merge` / `gh pr ready`) for every write. Draft comments live in the
// viewer's pending review on GitHub, so the Mac and the phone see the same drafts.

const GH_LOGIN = `Sign in to GitHub on ${thisComputer} with \`gh auth login\`, then try again.`;
const GH_MISSING = `Install the GitHub CLI (\`${process.platform === "win32" ? "winget install GitHub.cli" : "brew install gh"}\`) on ${thisComputer} to review PRs here.`;
const OID = /^[0-9a-f]{40}$/;
const MAX_BODY = 65_000;
const FILE_PAGES = 30;
const METHODS = new Set(["squash", "merge", "rebase"]);
const EVENTS = new Set(["COMMENT", "APPROVE", "REQUEST_CHANGES"]);
// An image dragged into a PR description or comment. A private repository's answers 404 without a GitHub token, so
// they are read here with gh's, and only these: the token goes to github.com and to no other host.
const ATTACHMENT = /^https:\/\/github\.com\/(?:user-attachments\/assets|[\w.-]+\/[\w.-]+\/assets\/\d+)\/[0-9a-f-]{36}$/;
const MAX_IMAGE = 15 * 1024 * 1024;

const DETAIL_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      id number url title body state isDraft createdAt updatedAt
      author{login}
      baseRefName headRefName headRefOid baseRefOid additions deletions changedFiles
      mergeStateStatus reviewDecision viewerCanMergeAsAdmin viewerDidAuthor
      autoMergeRequest{mergeMethod}
      labels(first:20){nodes{name color}}
      commits(last:100){nodes{commit{oid messageHeadline}}}
      checks: commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{
        kind: __typename
        ... on CheckRun{name status conclusion detailsUrl checkSuite{workflowRun{workflow{name}}}}
        ... on StatusContext{context state targetUrl}
      }}}}}}
      files(first:100){nodes{path additions deletions changeType} pageInfo{hasNextPage endCursor}}
      reviewRequests(first:20){nodes{requestedReviewer{... on User{login} ... on Team{combinedSlug}}}}
      latestReviews(first:30){nodes{author{login} state commit{oid}}}
      reviewThreads(first:100){nodes{id path line originalLine diffSide isResolved isOutdated
        comments(first:50){nodes{id body createdAt author{login} pullRequestReview{state}}}}}
      comments(last:50){nodes{id body createdAt author{login}}}
      pending: reviews(states:PENDING,first:1){nodes{id comments{totalCount}}}
    }
  }
}`;

const FILES_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String!){
  repository(owner:$owner,name:$name){pullRequest(number:$number){
    files(first:100,after:$after){nodes{path additions deletions changeType} pageInfo{hasNextPage endCursor}}
  }}
}`;

const ID_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){pullRequest(number:$number){id headRefOid pending: reviews(states:PENDING,first:1){nodes{id}}}}
}`;

class ReviewError extends Error {}

function ghOptions(cwd, env) {
  return { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: { ...env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } };
}

function defaultExec(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else resolve({ stdout, stderr });
    });
  });
}

/** What a failed gh call says to the user: sign in, install gh, or GitHub's own words. */
function ghMessage(error) {
  if (error?.code === "ENOENT") return GH_MISSING;
  const stderr = String(error?.stderr ?? "");
  const stdout = String(error?.stdout ?? "");
  if (error?.code === 4 || /gh auth login|not logged in|authentication required/i.test(stderr)) return GH_LOGIN;
  try {
    const parsed = JSON.parse(stdout);
    const message = parsed?.errors?.[0]?.message;
    if (typeof message === "string" && message) return message;
  } catch {}
  const line = (stderr || stdout || error?.message || "").trim().split("\n").find(Boolean);
  return line ? line.replace(/^(gh: |GraphQL: )/, "").slice(0, 400) : "GitHub didn't answer.";
}

const text = (value) => (typeof value === "string" ? value : "");
const login = (actor) => text(actor?.login) || "ghost";

const STATUS = { ADDED: "added", DELETED: "deleted", RENAMED: "renamed", COPIED: "added" };
const toFile = (node) => ({
  path: text(node.path),
  additions: Number(node.additions) || 0,
  deletions: Number(node.deletions) || 0,
  status: STATUS[node.changeType] ?? "modified",
});

// The check-run conclusions and commit-status states GitHub counts against the PR, as its merge box does.
const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
function toCheck(node) {
  if (node?.kind === "StatusContext") {
    const state = text(node.state);
    const outcome = FAILED.has(state) ? "fail" : state === "SUCCESS" ? "pass" : "running";
    return { name: text(node.context), outcome, ...(node.targetUrl && { url: node.targetUrl }) };
  }
  const conclusion = text(node?.conclusion);
  const outcome =
    node?.status !== "COMPLETED"
      ? "running"
      : FAILED.has(conclusion)
        ? "fail"
        : conclusion === "SKIPPED"
          ? "skipped"
          : conclusion === "NEUTRAL" || conclusion === "STALE"
            ? "neutral"
            : "pass";
  const workflow = text(node?.checkSuite?.workflowRun?.workflow?.name);
  return { name: text(node?.name), ...(workflow && { workflow }), outcome, ...(node?.detailsUrl && { url: node.detailsUrl }) };
}

const CHECK_ORDER = { fail: 0, running: 1, pass: 2, neutral: 3, skipped: 4 };

function toReviewers(pr) {
  const head = text(pr.headRefOid);
  const reviewers = new Map();
  for (const review of pr.latestReviews?.nodes ?? []) {
    const state = text(review?.state);
    if (!["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"].includes(state)) continue;
    const stale = state !== "COMMENTED" && Boolean(review.commit?.oid) && review.commit.oid !== head;
    reviewers.set(login(review.author), { login: login(review.author), state, ...(stale && { stale: true }) });
  }
  for (const request of pr.reviewRequests?.nodes ?? []) {
    const who = request?.requestedReviewer;
    // A team goes by its org/slug, the name gh takes to add or remove it.
    const team = text(who?.combinedSlug);
    const name = text(who?.login) || team;
    // A re-requested review outranks the reviewer's last verdict.
    if (name) reviewers.set(name, { login: name, state: "REQUESTED", ...(team && !who?.login && { team: true }) });
  }
  return [...reviewers.values()];
}

function toComment(node) {
  const pending = node?.pullRequestReview?.state === "PENDING";
  return { id: text(node?.id), author: login(node?.author), body: text(node?.body), createdAt: text(node?.createdAt), ...(pending && { pending: true }) };
}

function toDetail(pr, files) {
  const contexts = pr.checks?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const method = text(pr.autoMergeRequest?.mergeMethod).toLowerCase();
  const pending = pr.pending?.nodes?.[0];
  return {
    number: pr.number,
    url: text(pr.url),
    title: text(pr.title),
    body: text(pr.body),
    state: ["OPEN", "MERGED", "CLOSED"].includes(pr.state) ? pr.state : "OPEN",
    isDraft: pr.isDraft === true,
    author: login(pr.author),
    createdAt: text(pr.createdAt),
    updatedAt: text(pr.updatedAt),
    baseRefName: text(pr.baseRefName),
    headRefName: text(pr.headRefName),
    headRefOid: text(pr.headRefOid),
    baseRefOid: text(pr.baseRefOid),
    additions: Number(pr.additions) || 0,
    deletions: Number(pr.deletions) || 0,
    changedFiles: Number(pr.changedFiles) || 0,
    mergeStateStatus: text(pr.mergeStateStatus) || "UNKNOWN",
    reviewDecision: ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"].includes(pr.reviewDecision) ? pr.reviewDecision : null,
    autoMerge: METHODS.has(method) ? { method } : null,
    viewerCanMergeAsAdmin: pr.viewerCanMergeAsAdmin === true,
    viewerIsAuthor: pr.viewerDidAuthor === true,
    checks: contexts
      .filter(Boolean)
      .map(toCheck)
      .filter((check) => check.name)
      .toSorted((a, b) => CHECK_ORDER[a.outcome] - CHECK_ORDER[b.outcome]),
    reviewers: toReviewers(pr),
    labels: (pr.labels?.nodes ?? []).filter(Boolean).map((label) => ({ name: text(label.name), color: text(label.color) })),
    commits: (pr.commits?.nodes ?? [])
      .map((node) => ({ oid: text(node?.commit?.oid), headline: text(node?.commit?.messageHeadline) }))
      .filter((commit) => commit.oid),
    files,
    threads: (pr.reviewThreads?.nodes ?? []).filter(Boolean).map((thread) => ({
      id: text(thread.id),
      path: text(thread.path),
      line: Number.isInteger(thread.line) ? thread.line : Number.isInteger(thread.originalLine) && !thread.isOutdated ? thread.originalLine : null,
      side: thread.diffSide === "LEFT" ? "LEFT" : "RIGHT",
      resolved: thread.isResolved === true,
      outdated: thread.isOutdated === true,
      comments: (thread.comments?.nodes ?? []).filter(Boolean).map(toComment),
    })),
    comments: (pr.comments?.nodes ?? []).filter(Boolean).map(toComment),
    pendingReview: pending?.id ? { id: pending.id, count: Number(pending.comments?.totalCount) || 0 } : null,
  };
}

function number(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new ReviewError("That isn't a PR number.");
  return value;
}

function body(value, { required = true } = {}) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (required && !trimmed) throw new ReviewError("Write something first.");
  if (trimmed.length > MAX_BODY) throw new ReviewError("That comment is too long for GitHub.");
  return trimmed;
}

function nodeId(value) {
  if (typeof value !== "string" || !/^[\w-]{4,200}$/.test(value)) throw new ReviewError("That review item no longer exists.");
  return value;
}

/** Label names or reviewer logins to add or remove, checked before they reach gh. */
function names(value, pattern, what) {
  const list = value ?? [];
  if (!Array.isArray(list) || list.length > 100 || !list.every((item) => typeof item === "string" && pattern.test(item))) {
    throw new ReviewError(`That isn't a ${what}.`);
  }
  return list;
}
const LABEL = /^[^\0\n]{1,100}$/;
// gh reads list flags as CSV: quoted, a label's commas and quotes stay part of its name.
const csv = (value) => `"${value.replaceAll('"', '""')}"`;
// A user login, or an org/team slug.
const REVIEWER = /^[\w.-]{1,100}(\/[\w.-]{1,100})?$/;

function filePath(value) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.startsWith("/") || value.split("/").includes("..")) {
    throw new ReviewError("That file isn't in this PR.");
  }
  return value;
}

async function guard(task) {
  try {
    return await task();
  } catch (error) {
    return { ok: false, message: error instanceof ReviewError ? error.message : ghMessage(error) };
  }
}

function range(base, head) {
  if (!OID.test(base) || !OID.test(head)) throw new ReviewError("This PR's commits aren't known yet. Refresh and try again.");
  return { base, head };
}

/**
 * `exec(command, args, options)` resolves `{ stdout }` or rejects with `stdout`/`stderr`/`code`, as
 * promisified execFile does. Every method returns a result object and never throws.
 */
function createPullRequestReview({
  exec = scheduled(defaultExec),
  env = process.env,
  diff = createGitDiff({ env }),
  git = createGit({ env }),
  fetch = globalThis.fetch,
} = {}) {
  async function gh(cwd, args) {
    const { stdout } = await exec("gh", args, ghOptions(cwd, env));
    return stdout;
  }

  // gh fills {owner} and {repo} from the folder's repository (its default remote), as `gh pr view` does.
  async function graphql(cwd, query, fields = {}) {
    const args = ["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-f", `query=${query}`];
    for (const [key, value] of Object.entries(fields)) args.push(typeof value === "number" || typeof value === "boolean" ? "-F" : "-f", `${key}=${value}`);
    const parsed = JSON.parse(await gh(cwd, args));
    if (parsed?.errors?.length) throw new ReviewError(text(parsed.errors[0]?.message) || "GitHub didn't answer.");
    return parsed.data;
  }

  // A mutation's variables are named in its own query; gh sends them as typed fields.
  async function mutate(cwd, mutation, input) {
    const args = ["api", "graphql", "-f", `query=${mutation}`];
    for (const [key, value] of Object.entries(input)) args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
    const parsed = JSON.parse(await gh(cwd, args));
    if (parsed?.errors?.length) throw new ReviewError(text(parsed.errors[0]?.message) || "GitHub didn't answer.");
    return parsed.data;
  }

  async function read(cwd, prNumber) {
    const data = await graphql(cwd, DETAIL_QUERY, { number: prNumber });
    const pr = data?.repository?.pullRequest;
    if (!pr) throw new ReviewError(`PR #${prNumber} isn't in this repository.`);
    const files = (pr.files?.nodes ?? []).filter(Boolean).map(toFile);
    let page = pr.files?.pageInfo;
    for (let i = 1; page?.hasNextPage && page.endCursor && i < FILE_PAGES; i++) {
      const next = (await graphql(cwd, FILES_QUERY, { number: prNumber, after: page.endCursor }))?.repository?.pullRequest?.files;
      files.push(...(next?.nodes ?? []).filter(Boolean).map(toFile));
      page = next?.pageInfo;
    }
    const detail = toDetail(pr, files);
    const commits = detail.state === "OPEN" ? await localCommits(cwd, detail.headRefOid) : 0;
    return commits ? { ...detail, localCommits: commits } : detail;
  }

  /** Commits on the folder's HEAD that the PR's head doesn't have: made here and not pushed to it yet. */
  async function localCommits(cwd, head) {
    if (!/^[0-9a-f]{40}$/.test(head)) return 0;
    const counted = await git.read.run(cwd, ["rev-list", "--count", `${head}..HEAD`]);
    const count = counted.ok ? Number(counted.stdout.trim()) : 0;
    return Number.isSafeInteger(count) && count > 0 ? count : 0;
  }

  async function ids(cwd, prNumber) {
    const pr = (await graphql(cwd, ID_QUERY, { number: prNumber }))?.repository?.pullRequest;
    if (!pr?.id) throw new ReviewError(`PR #${prNumber} isn't in this repository.`);
    return { id: pr.id, head: text(pr.headRefOid), pending: pr.pending?.nodes?.[0]?.id ?? null };
  }

  async function pendingReview(cwd, prNumber) {
    const found = await ids(cwd, prNumber);
    if (found.pending) return found.pending;
    const data = await mutate(
      cwd,
      "mutation($pr:ID!,$commit:GitObjectID!){addPullRequestReview(input:{pullRequestId:$pr,commitOID:$commit}){pullRequestReview{id}}}",
      { pr: found.id, commit: found.head },
    );
    return nodeId(data?.addPullRequestReview?.pullRequestReview?.id);
  }

  /** Makes sure both commits are in the folder's object store, fetching them by id when a push came from elsewhere. */
  async function haveCommits(cwd, oids) {
    const missing = [];
    for (const oid of oids) if (!(await git.read.run(cwd, ["cat-file", "-e", `${oid}^{commit}`])).ok) missing.push(oid);
    if (!missing.length) return true;
    await git.write.run(cwd, ["fetch", "--no-tags", "--quiet", "--no-write-fetch-head", "origin", ...missing], { profile: "NETWORK" });
    for (const oid of missing) if (!(await git.read.run(cwd, ["cat-file", "-e", `${oid}^{commit}`])).ok) return false;
    return true;
  }

  /** The attachment's bytes as a data URL: github.com answers with a signed address on its storage, read without the token. */
  async function attachment(cwd, url) {
    if (typeof url !== "string" || !ATTACHMENT.test(url)) throw new ReviewError("That isn't a GitHub attachment.");
    const token = (await gh(cwd, ["auth", "token", "--hostname", "github.com"])).trim();
    const signed = await fetch(url, { redirect: "manual", headers: token ? { Authorization: `token ${token}` } : {} });
    const location = signed.headers.get("location");
    if (signed.status < 300 || signed.status >= 400 || !location?.startsWith("https://")) throw new ReviewError("GitHub didn't send this image.");
    const image = await fetch(location);
    const type = image.headers.get("content-type")?.split(";")[0].trim() ?? "";
    if (!image.ok || !type.startsWith("image/")) throw new ReviewError("GitHub didn't send this image.");
    if (Number(image.headers.get("content-length")) > MAX_IMAGE) throw new ReviewError("This image is too large to show here.");
    const bytes = Buffer.from(await image.arrayBuffer());
    if (bytes.length > MAX_IMAGE) throw new ReviewError("This image is too large to show here.");
    return `data:${type};base64,${bytes.toString("base64")}`;
  }

  return {
    detail: ({ cwd, number: n } = {}) => guard(async () => ({ ok: true, pr: await read(cwd, number(n)) })),

    /** An image of the PR's description or comments, which a private repository serves only to a signed-in viewer. */
    image: ({ cwd, url } = {}) => guard(async () => ({ ok: true, dataUrl: await attachment(cwd, url) })),

    /** The PR's files as GitHub diffs them: merge-base(base, head)..head, read from the folder's own git. */
    diffFiles: ({ cwd, base, head } = {}) =>
      guard(async () => {
        const commits = range(base, head);
        if (!(await haveCommits(cwd, [commits.base, commits.head]))) {
          return { isRepo: true, base: null, files: [], message: "Fetch this PR's commits to see its diff here." };
        }
        return diff.listDiffFiles({ cwd, mode: "range", range: commits });
      }),

    diffFile: ({ cwd, base, head, path, oldPath } = {}) =>
      guard(async () => {
        const commits = range(base, head);
        if (!(await haveCommits(cwd, [commits.base, commits.head]))) return { patch: "", binary: false, tooLarge: false };
        return diff.readDiffFile({ cwd, mode: "range", range: commits, path, oldPath });
      }),

    /** A draft comment on a line (or `startLine`..`line`), added to the viewer's pending review. */
    comment: ({ cwd, number: n, path, line, startLine, side = "RIGHT", body: written } = {}) =>
      guard(async () => {
        const review = await pendingReview(cwd, number(n));
        if (!Number.isSafeInteger(line) || line <= 0) throw new ReviewError("Pick a line to comment on.");
        const input = { review, path: filePath(path), line, side: side === "LEFT" ? "LEFT" : "RIGHT", body: body(written) };
        const multi = Number.isSafeInteger(startLine) && startLine > 0 && startLine < line;
        await mutate(
          cwd,
          multi
            ? "mutation($review:ID!,$path:String!,$line:Int!,$start:Int!,$side:DiffSide!,$body:String!){addPullRequestReviewThread(input:{pullRequestReviewId:$review,path:$path,line:$line,startLine:$start,side:$side,startSide:$side,body:$body}){thread{id}}}"
            : "mutation($review:ID!,$path:String!,$line:Int!,$side:DiffSide!,$body:String!){addPullRequestReviewThread(input:{pullRequestReviewId:$review,path:$path,line:$line,side:$side,body:$body}){thread{id}}}",
          multi ? { ...input, start: startLine } : input,
        );
        return { ok: true };
      }),

    /** A draft reply in an existing thread, added to the viewer's pending review. */
    reply: ({ cwd, number: n, threadId, body: written } = {}) =>
      guard(async () => {
        const review = await pendingReview(cwd, number(n));
        await mutate(
          cwd,
          "mutation($thread:ID!,$review:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread,pullRequestReviewId:$review,body:$body}){comment{id}}}",
          { thread: nodeId(threadId), review, body: body(written) },
        );
        return { ok: true };
      }),

    deleteComment: ({ cwd, commentId } = {}) =>
      guard(async () => {
        await mutate(cwd, "mutation($id:ID!){deletePullRequestReviewComment(input:{id:$id}){clientMutationId}}", { id: nodeId(commentId) });
        return { ok: true };
      }),

    /** Submits the pending review with a verdict, or a review with only a body when nothing is pending. */
    submit: ({ cwd, number: n, event, body: written } = {}) =>
      guard(async () => {
        if (!EVENTS.has(event)) throw new ReviewError("Choose Comment, Approve or Request changes.");
        const found = await ids(cwd, number(n));
        const summary = body(written, { required: false });
        if (!found.pending && event !== "APPROVE" && !summary) throw new ReviewError("Write a comment or add one to a line first.");
        if (found.pending) {
          await mutate(
            cwd,
            "mutation($review:ID!,$event:PullRequestReviewEvent!,$body:String!){submitPullRequestReview(input:{pullRequestReviewId:$review,event:$event,body:$body}){pullRequestReview{id}}}",
            { review: found.pending, event, body: summary },
          );
        } else {
          await mutate(
            cwd,
            "mutation($pr:ID!,$event:PullRequestReviewEvent!,$body:String!){addPullRequestReview(input:{pullRequestId:$pr,event:$event,body:$body}){pullRequestReview{id}}}",
            { pr: found.id, event, body: summary },
          );
        }
        return { ok: true };
      }),

    resolve: ({ cwd, threadId, resolved = true } = {}) =>
      guard(async () => {
        const name = resolved === false ? "unresolveReviewThread" : "resolveReviewThread";
        await mutate(cwd, `mutation($id:ID!){${name}(input:{threadId:$id}){thread{id}}}`, { id: nodeId(threadId) });
        return { ok: true };
      }),

    /** The repository's labels, for the labels picker. */
    labels: ({ cwd } = {}) =>
      guard(async () => {
        const listed = JSON.parse(await gh(cwd, ["label", "list", "--json", "name,color,description", "--limit", "1000"]));
        return {
          ok: true,
          labels: (Array.isArray(listed) ? listed : [])
            .map((label) => ({ name: text(label?.name), color: text(label?.color), description: text(label?.description) }))
            .filter((label) => label.name),
        };
      }),

    setLabels: ({ cwd, number: n, add, remove } = {}) =>
      guard(async () => {
        const flags = [
          ...names(add, LABEL, "label").map((name) => `--add-label=${csv(name)}`),
          ...names(remove, LABEL, "label").map((name) => `--remove-label=${csv(name)}`),
        ];
        if (flags.length) await gh(cwd, ["pr", "edit", String(number(n)), ...flags]);
        return { ok: true };
      }),

    /** Who can be asked to review: the repository's assignable users. */
    reviewerCandidates: ({ cwd } = {}) =>
      guard(async () => {
        const out = await gh(cwd, ["api", "repos/{owner}/{repo}/assignees", "--paginate", "--jq", ".[].login"]);
        return {
          ok: true,
          logins: out
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
        };
      }),

    requestReviewers: ({ cwd, number: n, add, remove } = {}) =>
      guard(async () => {
        const flags = [
          ...names(add, REVIEWER, "GitHub user").map((name) => `--add-reviewer=${name}`),
          ...names(remove, REVIEWER, "GitHub user").map((name) => `--remove-reviewer=${name}`),
        ];
        if (flags.length) await gh(cwd, ["pr", "edit", String(number(n)), ...flags]);
        return { ok: true };
      }),

    /** Merges now, or turns auto-merge on (`auto`) or off (`disableAuto`). `admin` bypasses unmet requirements where the viewer may. */
    merge: ({ cwd, number: n, method = "squash", auto = false, admin = false, disableAuto = false } = {}) =>
      guard(async () => {
        const ref = String(number(n));
        if (disableAuto) await gh(cwd, ["pr", "merge", ref, "--disable-auto"]);
        else {
          if (!METHODS.has(method)) throw new ReviewError("Choose squash, merge or rebase.");
          await gh(cwd, ["pr", "merge", ref, `--${method}`, ...(auto ? ["--auto"] : []), ...(admin && !auto ? ["--admin"] : [])]);
        }
        return { ok: true };
      }),

    /** Marks a draft ready for review, or (`draft`) turns it back into a draft. */
    ready: ({ cwd, number: n, draft = false } = {}) =>
      guard(async () => {
        await gh(cwd, ["pr", "ready", String(number(n)), ...(draft ? ["--undo"] : [])]);
        return { ok: true };
      }),
  };
}

module.exports = { createPullRequestReview, ghMessage, ghOptions, defaultExec, GH_LOGIN, GH_MISSING };
