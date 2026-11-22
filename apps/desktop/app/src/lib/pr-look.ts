import {
  CancelCircleIcon,
  CircleDotIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { pullRequestPresentation } from "./pr-blockers";

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

export const PR_TONES = {
  purple: "text-purple",
  red: "text-red",
  orange: "text-orange",
  green: "text-green",
  ink3: "text-ink-3",
} as const;

export function prLook(pr: Parameters<typeof pullRequestPresentation>[0]) {
  const look = pullRequestPresentation(pr);
  const labelClass = {
    purple: "text-purple-ink",
    red: "text-red-ink",
    orange: "text-orange-ink",
    green: "text-green-ink",
    ink3: "text-ink-3",
  }[look.tone];
  return {
    ...look,
    labelClass,
    glyph: PR_ICONS[look.icon],
    toneClass: PR_TONES[look.tone],
  };
}
