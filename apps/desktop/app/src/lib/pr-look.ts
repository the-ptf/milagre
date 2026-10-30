import { CircleDotIcon, GitMergeIcon, GitPullRequestClosedIcon, GitPullRequestDraftIcon, GitPullRequestIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { pullRequestPresentation } from "./pr-blockers";

// The glyph and colour of a PR's badge (pullRequestPresentation's icon and tone), the same in the sidebar and the PR tabs.

const PR_ICONS = {
  merged: GitMergeIcon,
  closed: GitPullRequestClosedIcon,
  draft: GitPullRequestDraftIcon,
  ready: Tick02Icon,
  checking: CircleDotIcon,
  open: GitPullRequestIcon,
} as const;

const PR_TONES = {
  purple: "text-purple-500",
  red: "text-red-ink",
  orange: "text-orange-ink",
  green: "text-green-ink",
  ink3: "text-ink-3",
} as const;

export function prLook(pr: Parameters<typeof pullRequestPresentation>[0]) {
  const look = pullRequestPresentation(pr);
  return { ...look, glyph: PR_ICONS[look.icon], toneClass: PR_TONES[look.tone] };
}
