import type { ChatSendRequest, OpenProject } from "./model.ts";

export type GitHubIssue = { repository: string; number: number; url: string; title: string; body: string; state: "OPEN"; importedAt: string; account: string };
export type GitHubIssueContext = GitHubIssue & { kind: "github-issue"; note?: string };
export type GitHubIssueList = { repository: string; account: string; issues: GitHubIssue[] };
export type GitHubImportTarget = { kind: "worktree"; baseBranch: string } | { kind: "chat"; worktreeId: number } | { kind: "existing"; sessionId: number };
export type GitHubImportRequest = {
  projectPath: string;
  url: string;
  account: string;
  target: GitHubImportTarget;
  note?: string;
  options: Pick<ChatSendRequest, "clientMessageId" | "provider" | "model" | "permissionMode" | "effort" | "ultracode" | "fastMode" | "replies" | "tldrEnabled">;
};
export type GitHubImportResult = { project: OpenProject; sessionId: number; worktreeId: number };
export function githubIssueRef(value: unknown): { repository: string; number: number; url: string } | null;
export function githubIssueContext(issue: GitHubIssue, note?: string): GitHubIssueContext;
export function isGitHubIssueContext(value: unknown): value is GitHubIssueContext;
export function githubIssueBody(issue: GitHubIssue, note?: string): string;
export function githubIssuePrompt(issue: GitHubIssue, note?: string): string;
