const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { ghInstallHint } = require("@milagre/shared/git-codes");
const { githubIssueFromUrl, githubIssueKey, isGithubRepo, parseGithubIssueRef } = require("@milagre/shared/github-issue");
const { scheduled } = require("./process-lanes.cjs");

// Every read goes through the host's own `gh`, so the GitHub sign-in never leaves this computer. Arguments are an
// array and every value rides in `--flag=value` form, so nothing an issue or a search says is read as a flag.

const LIST_TTL_MS = 60_000;
const REPO_TTL_MS = 5 * 60_000;
const LIST_LIMIT = 30;
const MAX_COMMENTS = 50;
const LIST_FIELDS = "number,title,url,state,stateReason,author,labels";
const ISSUE_FIELDS = `${LIST_FIELDS},body,comments`;

class GithubIssueError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function classify(error, platform, subject) {
  if (error instanceof GithubIssueError) return error;
  const stderr = String(error?.stderr ?? "");
  const fail = (code, message) => new GithubIssueError(code, message);
  if (error?.code === "ENOENT")
    return fail("gh-missing", `Install the GitHub CLI (${ghInstallHint(platform)}) on this computer to start Chats from GitHub issues.`);
  if (error?.killed) return fail("failed", "gh took too long to answer. Try again.");
  if (error?.code === 4 || /gh auth login|not logged in|authentication required/i.test(stderr))
    return fail("gh-auth", "gh isn't signed in to GitHub on this computer. Run `gh auth login` in a terminal.");
  if (/no git remotes found|none of the git remotes|not a git repository/i.test(stderr))
    return fail("no-github", "This Project has no GitHub remote. Paste an issue link to start from another repository.");
  if (/disabled issues/i.test(stderr)) return fail("issues-off", `Issues are turned off for ${subject ?? "this repository"}.`);
  if (/Could not resolve to a Repository/i.test(stderr))
    return fail("no-access", `gh can't see ${subject ?? "this repository"}. Check the account in \`gh auth status\`.`);
  if (/Could not resolve to an issue/i.test(stderr)) return fail("not-found", `${subject ?? "That issue"} doesn't exist, or gh can't see it.`);
  const line = stderr.trim().split("\n")[0]?.slice(0, 300);
  return fail("failed", line || "gh couldn't read GitHub issues.");
}

function toIssue(node, fallbackRepo) {
  const named = githubIssueFromUrl(node?.url);
  const repo = named?.repo ?? fallbackRepo;
  if (!node || typeof node.number !== "number" || typeof node.title !== "string" || !isGithubRepo(repo)) return null;
  const closed = String(node.state).toUpperCase() === "CLOSED";
  const reason = String(node.stateReason ?? "").toUpperCase();
  const labels = Array.isArray(node.labels) ? node.labels.map((label) => label?.name).filter((name) => typeof name === "string" && name) : [];
  return {
    repo,
    number: node.number,
    title: node.title,
    url: String(node.url ?? ""),
    state: closed ? "closed" : "open",
    ...(closed && reason === "NOT_PLANNED" ? { closedAs: "not_planned" } : closed && reason === "COMPLETED" ? { closedAs: "completed" } : {}),
    ...(node.author?.login ? { author: node.author.login } : {}),
    ...(labels.length ? { labels } : {}),
  };
}

function withThread(node, issue) {
  const comments = (Array.isArray(node.comments) ? node.comments : [])
    .filter((comment) => typeof comment?.body === "string")
    .map((comment) => ({ author: comment.author?.login || "ghost", body: comment.body, ...(comment.createdAt ? { at: comment.createdAt } : {}) }));
  return {
    ...issue,
    ...(typeof node.body === "string" && node.body.trim() ? { body: node.body } : {}),
    comments: comments.slice(-MAX_COMMENTS),
    commentCount: comments.length,
  };
}

/**
 * GitHub issues for the Project's repository, read with the host's `gh` through the shared git/gh lanes.
 * `list` never throws: it answers `{ repo, issues }` or `{ error, code }` for the picker. `read` throws a
 * `GithubIssueError` whose message says what to do.
 */
function createGithubIssues({ exec = promisify(execFile), env = () => process.env, platform = process.platform, now = Date.now } = {}) {
  const run = scheduled(exec);
  const repos = new Map();
  const lists = new Map();

  async function gh(cwd, args, subject) {
    try {
      const { stdout } = await run("gh", args, {
        cwd,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...env(), GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
      });
      return JSON.parse(stdout);
    } catch (error) {
      if (error instanceof SyntaxError) throw new GithubIssueError("failed", "gh answered with something Milagre couldn't read.");
      throw classify(error, platform, subject);
    }
  }

  async function projectRepo(projectPath, fresh) {
    const hit = repos.get(projectPath);
    if (!fresh && hit && now() - hit.at < REPO_TTL_MS) return hit.repo;
    const view = await gh(projectPath, ["repo", "view", "--json=nameWithOwner,url,hasIssuesEnabled"]);
    const host = (() => {
      try {
        return new URL(view.url).host.toLowerCase();
      } catch {
        return "github.com";
      }
    })();
    const name = host === "github.com" ? view.nameWithOwner : `${host}/${view.nameWithOwner}`;
    if (!isGithubRepo(name))
      throw new GithubIssueError("no-github", "This Project has no GitHub remote. Paste an issue link to start from another repository.");
    const repo = { name, issues: view.hasIssuesEnabled !== false };
    repos.set(projectPath, { at: now(), repo });
    return repo;
  }

  async function readIssue(projectPath, { repo, number }, { thread = true } = {}) {
    const subject = githubIssueKey({ repo, number });
    const node = await gh(projectPath, ["issue", "view", String(number), `--repo=${repo}`, `--json=${thread ? ISSUE_FIELDS : LIST_FIELDS}`], subject);
    if (/\/pull\/\d+/.test(String(node?.url ?? ""))) throw new GithubIssueError("pull-request", `${subject} is a pull request, not an issue.`);
    const issue = toIssue(node, repo);
    if (!issue) throw new GithubIssueError("failed", "gh answered with something Milagre couldn't read.");
    return thread ? withThread(node, issue) : issue;
  }

  async function search(projectPath, repo, text, fresh) {
    const id = `${repo}\0${text}`;
    const hit = lists.get(id);
    if (!fresh && hit && now() - hit.at < LIST_TTL_MS) return hit.issues;
    const args = [
      "issue",
      "list",
      `--repo=${repo}`,
      "--state=open",
      `--limit=${LIST_LIMIT}`,
      `--json=${LIST_FIELDS}`,
      `--search=${text || "sort:updated-desc"}`,
    ];
    const nodes = await gh(projectPath, args, repo);
    const issues = (Array.isArray(nodes) ? nodes : []).map((node) => toIssue(node, repo)).filter(Boolean);
    lists.set(id, { at: now(), issues });
    return issues;
  }

  async function list(projectPath, query, { fresh = false } = {}) {
    const text = typeof query === "string" ? query.trim() : "";
    const ref = parseGithubIssueRef(text);
    try {
      if (ref?.repo) {
        const issue = await readIssue(projectPath, ref, { thread: false });
        return { repo: issue.repo, issues: [issue] };
      }
      const { name, issues } = await projectRepo(projectPath, fresh);
      if (!issues) return { error: `Issues are turned off for ${name}.`, code: "issues-off" };
      const exact = ref ? await readIssue(projectPath, { repo: name, number: ref.number }, { thread: false }).catch(() => null) : null;
      const found = await search(projectPath, name, text, fresh);
      return { repo: name, issues: exact ? [exact, ...found.filter((issue) => githubIssueKey(issue) !== githubIssueKey(exact))] : found };
    } catch (error) {
      const failure = classify(error, platform);
      return { error: failure.message, code: failure.code };
    }
  }

  return { list, readIssue };
}

module.exports = { createGithubIssues, GithubIssueError };
