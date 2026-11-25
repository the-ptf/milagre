const { branchSlug } = require("@milagre/shared/branch-policy");
const { githubIssueContext, githubIssueFirstMessage, githubIssuePrompt, githubIssueRequest } = require("@milagre/shared/github-issue");
const { isLinkScopeKey } = require("@milagre/shared/chat-scopes");
const { createGithubIssues } = require("../github-issues.cjs");

const shared = new WeakMap();

/** One GitHub issue reader per runtime: `options.githubIssues` in tests, the host's `gh` otherwise. */
function githubIssuesFor(options) {
  if (options.githubIssues) return options.githubIssues;
  if (!shared.has(options)) shared.set(options, createGithubIssues());
  return shared.get(options);
}

function registerGithubIssues({ commands, options, states, environmentReady }) {
  const issues = githubIssuesFor(options);
  commands.handle("github:issues", async (_event, value) => {
    const projectPath = value?.projectPath;
    if (typeof projectPath !== "string" || isLinkScopeKey(projectPath) || !states.has(projectPath))
      throw new Error("Open the Project before listing its issues.");
    await environmentReady;
    return issues.list(projectPath, value?.query, { fresh: value?.fresh === true });
  });
}

/** The first message of a Chat started from a GitHub issue, read fresh from GitHub; the text sent stands when gh can't answer. */
async function githubIssueMessage(options, rest, request) {
  const ask = githubIssueRequest(request);
  if (!ask) throw new Error("That GitHub issue isn't valid.");
  const issue = await githubIssuesFor(options)
    .readIssue(rest.projectPath, ask)
    .catch((error) => {
      console.warn(`Milagre couldn't read ${ask.repo}#${ask.number} for its card:`, error.message);
      return null;
    });
  if (!issue) return { ...rest, context: undefined };
  const files = Array.isArray(rest.files) ? rest.files : [];
  return {
    ...rest,
    body: githubIssueFirstMessage(issue, ask.note),
    prompt: githubIssuePrompt(issue, ask.note) + (files.length ? `\n\nAttached files:\n${files.join("\n")}` : ""),
    context: githubIssueContext(issue, ask.note),
  };
}

/** What a Worktree started from a GitHub issue is named after; throws, with what to do, when gh can't read it. */
async function githubWorktreeIssue(options, projectPath, request) {
  const ask = githubIssueRequest(request);
  if (!ask) throw new Error("That GitHub issue isn't valid.");
  const issue = await githubIssuesFor(options).readIssue(projectPath, ask, { thread: false });
  return { title: issue.title, ticket: String(issue.number), branch: `${issue.number}-${branchSlug(issue.title)}` };
}

module.exports = { registerGithubIssues, githubIssueMessage, githubWorktreeIssue };
