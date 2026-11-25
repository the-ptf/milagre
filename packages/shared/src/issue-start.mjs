import { githubIssueContext, githubIssueFirstMessage, githubIssueKey, githubIssueRequest, githubIssueState, isGithubIssueContext } from "./github-issue.mjs";
import { issueFirstMessage, isLinearIssueContext, linearIssueContext, linearIssueRequest } from "./linear-issue.mjs";

/** A picked issue is a GitHub one when it carries a repository and a number; a Linear one has a key. */
export function isGithubIssue(issue) {
  return typeof issue?.repo === "string" && typeof issue?.number === "number";
}

/** The send request field that has the host read the issue and write the first message, prompt and card itself; none without an issue. */
export function issueSendFields(issue, note) {
  if (!issue) return {};
  if (isGithubIssue(issue)) {
    const githubIssue = githubIssueRequest({ repo: issue.repo, number: issue.number, note });
    return githubIssue ? { githubIssue } : {};
  }
  const linearIssue = linearIssueRequest({ key: issue.key, workspace: issue.workspace, note });
  return linearIssue ? { linearIssue } : {};
}

/** The Worktree request fields that name its branch after the issue; none without an issue. */
export function issueWorktreeFields(issue) {
  if (!issue) return {};
  if (isGithubIssue(issue)) return { githubIssue: { repo: issue.repo, number: issue.number } };
  return { issueKey: issue.key, ...(issue.workspace ? { issueWorkspace: issue.workspace } : {}) };
}

export function issueStartContext(issue, note) {
  return isGithubIssue(issue) ? githubIssueContext(issue, note) : linearIssueContext(issue, note);
}

export function issueStartMessage(issue, typed) {
  return isGithubIssue(issue) ? githubIssueFirstMessage(issue, typed) : issueFirstMessage(issue, typed);
}

/** A stable id for a picked issue, unique across Linear workspaces and GitHub repositories; undefined without one. */
export function issueChoiceId(issue) {
  if (!issue) return undefined;
  if (isGithubIssue(issue)) return `github:${githubIssueKey(issue)}`;
  return issue.workspace ? `${issue.workspace}:${issue.key}` : issue.key;
}

/** What the issue card at the top of a Chat shows, for a Linear or a GitHub issue; null for any other context. */
export function issueCard(context) {
  if (isGithubIssueContext(context)) {
    const key = githubIssueKey(context);
    return {
      source: "github",
      key,
      title: context.title,
      url: context.url,
      state: githubIssueState(context),
      note: context.note,
      label: `GitHub issue ${key}`,
    };
  }
  if (isLinearIssueContext(context))
    return {
      source: "linear",
      key: context.key,
      title: context.title,
      url: context.url,
      state: { name: context.state.name, color: context.state.color },
      note: context.note,
      label: `Linear issue ${context.key}`,
    };
  return null;
}
