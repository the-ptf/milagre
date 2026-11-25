import type { GithubIssue } from "./github-issue.d.mts";
import type { LinearIssue } from "./linear.ts";
import type { GithubIssueContext, LinearIssueContext } from "./model.ts";

/** An issue a Chat can start from: one from the Linear picker or the GitHub picker. */
export type PickedIssue = LinearIssue | GithubIssue;
export type IssueCardView = {
  source: "linear" | "github";
  key: string;
  title: string;
  url: string;
  state: { name: string; color: string };
  note?: string;
  label: string;
};

export function isGithubIssue(issue: unknown): issue is GithubIssue;
export function issueSendFields(
  issue: PickedIssue | undefined,
  note?: string,
): { linearIssue?: { key: string; workspace?: string; note?: string }; githubIssue?: { repo: string; number: number; note?: string } };
export function issueWorktreeFields(issue: PickedIssue | undefined): {
  issueKey?: string;
  issueWorkspace?: string;
  githubIssue?: { repo: string; number: number };
};
export function issueStartContext(issue: PickedIssue, note?: string): LinearIssueContext | GithubIssueContext;
export function issueStartMessage(issue: PickedIssue, typed?: string): string;
export function issueChoiceId(issue: PickedIssue): string;
export function issueChoiceId(issue: PickedIssue | undefined): string | undefined;
export function issueCard(context: unknown): IssueCardView | null;
