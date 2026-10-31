import type { ChatStep, PullRequest } from "./model.ts";

export type PullRequestRef = string;
export function associatedPullRequest<T extends { url: string }>(url: string, choices: readonly T[]): T | undefined;
type Messages = Array<{ steps?: ChatStep[] }>;
export function pullRequestRefs(messages: Messages): PullRequestRef[];
export function createdPullRequestUrl(detail: string): string | null;
export function pullRequestRefsCache(): (key: string, messages: Messages) => PullRequestRef[];
export function chatPullRequests(
  refs: PullRequestRef[],
  found: Record<PullRequestRef, PullRequest | null | undefined>,
  branch: PullRequest | undefined,
): PullRequest[];
