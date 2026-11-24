import {
  CancelCircleIcon,
  CircleDotIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";

export const PR_ICONS = {
  merged: GitMergeIcon,
  closed: GitPullRequestClosedIcon,
  draft: GitPullRequestDraftIcon,
  ready: Tick02Icon,
  checking: CircleDotIcon,
  open: GitPullRequestIcon,
  failed: CancelCircleIcon,
  passed: Tick02Icon,
} as const;
