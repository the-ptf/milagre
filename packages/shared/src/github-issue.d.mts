/** The card of a Chat started from a GitHub issue. `repo` is `owner/repo` (`host/owner/repo` on GitHub Enterprise). */
export type GithubIssueContext = {
  kind: "github-issue";
  repo: string;
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  closedAs?: "completed" | "not_planned";
  note?: string;
};

export type GithubIssueComment = { author: string; body: string; at?: string };
/** One issue as the host's `gh` read it. `repo` is `owner/repo` (`host/owner/repo` on GitHub Enterprise), from the issue's own URL. */
export type GithubIssue = {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  closedAs?: "completed" | "not_planned";
  author?: string;
  labels?: string[];
  body?: string;
  comments?: GithubIssueComment[];
  commentCount?: number;
};
export type GithubIssueErrorCode = "gh-missing" | "gh-auth" | "no-github" | "issues-off" | "not-found" | "pull-request" | "no-access" | "failed";
/** `repo` is the Project's repository the list came from. */
export type GithubIssuesResult = { repo: string; issues: GithubIssue[] } | { error: string; code: GithubIssueErrorCode };

export const GITHUB_ISSUE_TITLE: string;
export const GITHUB_ISSUE_PLACEHOLDER: string;
export function githubIssuesFailure(message: unknown): string;
export function isGithubRepo(repo: unknown): repo is string;
export function githubIssueFromUrl(url: unknown): { repo: string; number: number } | null;
export function parseGithubIssueRef(text: unknown): { repo?: string; number: number } | null;
export function githubIssueKey(issue: Pick<GithubIssue, "repo" | "number">): string;
export function githubIssueRequest(request: unknown): { repo: string; number: number; note?: string } | null;
export function githubIssueFirstMessage(issue: Pick<GithubIssue, "repo" | "number" | "title" | "url">, typed?: string): string;
export function githubIssueContext(issue: GithubIssue, note?: string): GithubIssueContext;
export function isGithubIssueContext(context: unknown): context is GithubIssueContext;
export function githubIssueState(issue: Pick<GithubIssue, "state" | "closedAs">): { name: string; color: string };
export function githubIssuePrompt(issue: GithubIssue, note?: string): string;
