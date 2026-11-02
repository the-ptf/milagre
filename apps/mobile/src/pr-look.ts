import { CircleDotIcon, GitMergeIcon, GitPullRequestClosedIcon, GitPullRequestDraftIcon, GitPullRequestIcon, Tick02Icon } from "@hugeicons/core-free-icons";

// The glyph of a PR's badge (pullRequestPresentation's icon), the same in the Chat lists, the header and the PR tabs.

export const PR_ICONS = {
  merged: GitMergeIcon,
  closed: GitPullRequestClosedIcon,
  draft: GitPullRequestDraftIcon,
  ready: Tick02Icon,
  checking: CircleDotIcon,
  open: GitPullRequestIcon,
} as const;
