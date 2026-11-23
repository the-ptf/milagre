import type { ChatStep, PullRequest } from "./model.ts";

export type PullRequestRef = string;
export function associatedPullRequest<T extends { url: string }>(url: string, choices: readonly T[]): T | undefined;
type Messages = Array<{ steps?: ChatStep[] }>;
export function pullRequestRefs(messages: Messages): PullRequestRef[];
export function createdPullRequestUrl(detail: string): string | null;
export function mergesCheckedOutBranch(command: string): boolean;
export function pushedBranches(detail: string): { repo: string; branch: string }[];
export function worktreeFree(
  state: { sessions?: Record<string, unknown>; worktrees?: Record<string, { id: number | string; path: string } | undefined> } | null | undefined,
  worktreePath: string | null | undefined,
  projectPath: string | null | undefined,
): boolean;
export function ownsWorktree(
  state: { sessions?: Record<string, unknown>; worktrees?: Record<string, { path: string } | undefined> } | null | undefined,
  sessionId: number | string,
  projectPath: string | null | undefined,
): boolean;
export function pullRequestRefsCache(): (key: string, messages: Messages) => PullRequestRef[];
export function chatPullRequests(
  refs: PullRequestRef[],
  found: Record<PullRequestRef, PullRequest | null | undefined>,
  branch: PullRequest | undefined,
): PullRequest[];
