const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { scheduled } = require("./process-lanes.cjs");
const { createGit } = require("./git/client.cjs");
const { originId } = require("@milagre/shared/project-origin");
const { githubIssueRef } = require("@milagre/shared/github-issue");

const FIELDS = "number,title,body,url,state";

/** Credentials and raw CLI output stay on the Computer. Only public issue and account fields leave it. */
function createGitHubIssues({ exec = promisify(execFile), git = createGit().read, now = () => new Date().toISOString() } = {}) {
  async function gh(cwd, args) {
    try {
      const { stdout } = await scheduled(exec)("gh", args, {
        cwd,
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      });
      return JSON.parse(stdout);
    } catch (error) {
      if (error.code === "ENOENT") throw new Error("Install GitHub CLI and sign in on this Computer to import issues.", { cause: error });
      throw new Error(
        "GitHub is unavailable or this Computer's selected account cannot access the repository or issue. Check GitHub CLI sign-in and access on the Computer, then try again.",
        { cause: error },
      );
    }
  }
  async function identity(projectPath) {
    let remote;
    try {
      remote = (await git.checked(projectPath, ["remote", "get-url", "origin"])).stdout;
    } catch (error) {
      throw new Error("Choose a Project with a GitHub origin repository.", { cause: error });
    }
    const origin = originId(remote);
    if (!origin || !/^github\.com\/[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/i.test(origin)) throw new Error("Choose a Project with a github.com origin repository.");
    const originRepository = origin.slice("github.com/".length);
    const repo = await gh(projectPath, ["repo", "view", originRepository, "--json", "nameWithOwner,url"]);
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repo.url) || typeof repo.nameWithOwner !== "string")
      throw new Error("Choose a Project with a github.com repository.");
    const user = await gh(projectPath, ["api", "--hostname", "github.com", "user"]);
    if (typeof user.login !== "string" || !user.login) throw new Error("Sign in to GitHub CLI on this Computer.");
    return { repository: repo.nameWithOwner.toLowerCase(), account: user.login, originRepository };
  }
  function issue(row, who) {
    const ref = githubIssueRef(row.url);
    if (!ref || ref.repository !== who.repository || ref.number !== row.number || typeof row.title !== "string" || typeof row.body !== "string")
      throw new Error("GitHub returned an issue from a different repository. Select the matching Project.");
    if (row.state !== "OPEN") throw new Error("This GitHub issue is closed. Choose an open issue.");
    return { ...ref, title: row.title, body: row.body, state: "OPEN", importedAt: now(), account: who.account };
  }
  return {
    async list(projectPath) {
      const who = await identity(projectPath);
      const rows = await gh(projectPath, ["issue", "list", "--repo", who.repository, "--state", "open", "--limit", "50", "--json", FIELDS]);
      if (!Array.isArray(rows)) throw new Error("GitHub returned an invalid issue list. Try again.");
      return { repository: who.repository, account: who.account, issues: rows.map((row) => issue(row, who)) };
    },
    async read(projectPath, url, expectedAccount) {
      const ref = githubIssueRef(url);
      if (!ref) throw new Error("Paste a GitHub issue URL: https://github.com/owner/repository/issues/123.");
      const who = await identity(projectPath);
      if (ref.repository !== who.repository && ref.repository !== who.originRepository)
        throw new Error("This issue belongs to a different repository. Select its Project before importing.");
      if (expectedAccount !== undefined && expectedAccount !== who.account)
        throw new Error("The GitHub account on this Computer changed. Preview the issue again before importing.");
      return issue(await gh(projectPath, ["issue", "view", String(ref.number), "--repo", who.repository, "--json", FIELDS]), who);
    },
  };
}

module.exports = { createGitHubIssues };
