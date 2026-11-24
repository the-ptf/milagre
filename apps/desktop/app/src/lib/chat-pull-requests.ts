import { ownsWorktree } from "@milagre/shared/chats";
import type { PullRequest } from "../model";

export { pullRequestRefs, pullRequestRefsCache, chatPullRequests, ownsWorktree, type PullRequestRef } from "@milagre/shared/chats";
export { rowPullRequests } from "@milagre/shared/pr-blockers";

/** The Worktree branch's PR for chatPullRequests: only a Chat that owns its Worktree gets it (#876). */
export function ownBranchPullRequest(
  state: Parameters<typeof ownsWorktree>[0],
  sessionId: number,
  projectPath: string | undefined,
  pr: PullRequest | null | undefined,
): PullRequest | undefined {
  return pr && ownsWorktree(state, sessionId, projectPath) ? pr : undefined;
}
