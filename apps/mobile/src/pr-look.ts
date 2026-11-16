import { CircleDotIcon, GitMergeIcon, GitPullRequestClosedIcon, GitPullRequestDraftIcon, GitPullRequestIcon, Tick02Icon } from "@hugeicons/core-free-icons";

export const PR_ICONS = {
  merged: GitMergeIcon,
  closed: GitPullRequestClosedIcon,
  draft: GitPullRequestDraftIcon,
  ready: Tick02Icon,
  checking: CircleDotIcon,
  open: GitPullRequestIcon,
} as const;
