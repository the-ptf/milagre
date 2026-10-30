import type { PullRequest, PullRequestBlocker } from "./model.ts";
import { PR_ACTIONS } from "./pr-action.mjs";

type BlockerStatus = {
  number?: number;
  url: string;
  state: string;
  hasConflicts?: boolean;
  conflictStatusKnown?: boolean;
  isBehind?: boolean;
  changesRequested?: boolean;
  checks?: "running" | "failed";
};

export type { PullRequestBlocker } from "./model.ts";

/**
 * Most urgent first: conflicts must be fixed before a branch can be updated, and both before review lands.
 * Failed CI comes before an outdated branch, since updating the branch reruns the checks anyway.
 */
const ORDER: PullRequestBlocker[] = ["conflicts", "changes-requested", "checks-failed", "behind"];

export const BLOCKERS: Record<PullRequestBlocker, { short: string; long: string; action: string; tone: "red" | "orange" }> = {
  conflicts: { short: "Conflicts", long: "Merge conflicts", action: PR_ACTIONS.conflicts.label, tone: "red" },
  "changes-requested": { short: "Needs changes", long: "Changes requested", action: PR_ACTIONS["changes-requested"].label, tone: "red" },
  "checks-failed": { short: "CI failed", long: "CI checks failed", action: PR_ACTIONS["checks-failed"].label, tone: "red" },
  behind: { short: "Out of date", long: "Out of date with the base branch", action: PR_ACTIONS.behind.label, tone: "orange" },
};

function blocks(pr: BlockerStatus, blocker: PullRequestBlocker) {
  if (pr.state !== "OPEN") return false;
  if (blocker === "conflicts") return Boolean(pr.hasConflicts);
  if (blocker === "behind") return Boolean(pr.isBehind);
  if (blocker === "checks-failed") return pr.checks === "failed";
  return Boolean(pr.changesRequested);
}

/** A false flag only proves the blocker is gone when GitHub actually computed the merge state. */
function clears(pr: BlockerStatus, blocker: PullRequestBlocker) {
  if (pr.state !== "OPEN") return true;
  if (blocks(pr, blocker)) return false;
  return blocker === "changes-requested" || blocker === "checks-failed" || pr.conflictStatusKnown !== false;
}

export function pullRequestBlockers(pr: BlockerStatus | null | undefined): PullRequestBlocker[] {
  return pr ? ORDER.filter((blocker) => blocks(pr, blocker)) : [];
}

/** The same PR badge status, color and label in both chat lists. */
export function pullRequestPresentation(pr: BlockerStatus & { readyToMerge?: boolean }) {
  const blocker = pullRequestBlockers(pr)[0];
  const merged = pr.state === "MERGED";
  const ready = !merged && !blocker && !!pr.readyToMerge;
  const checking = !merged && !blocker && !ready && pr.checks === "running";
  const tone = merged ? "purple" : blocker ? BLOCKERS[blocker].tone : checking ? "orange" : "green";
  const icon = merged ? "merged" : ready ? "ready" : checking ? "checking" : "open";
  const label = blocker ? BLOCKERS[blocker].short : ready ? "Ready" : checking ? "CI running" : "";
  return { blocker, ready, checking, tone, icon, label } as const;
}

export type PullRequestTone = ReturnType<typeof pullRequestPresentation>["tone"];
/** A PR tone as palette keys, the same on both apps: the icon in the fill color, the label in its -ink shade. The
 * number beside them stays ink2. Purple is Ultracode's brand purple (ULTRACODE_PURPLE in ./themes). */
export const PR_TONE = {
  green: { icon: "green", label: "greenInk" },
  orange: { icon: "orange", label: "orangeInk" },
  red: { icon: "red", label: "redInk" },
  purple: { icon: "purple", label: "purpleInk" },
} as const satisfies Record<PullRequestTone, { icon: string; label: string }>;

/** The pill after a PR's number in its header: Draft, Merged or Closed; an open PR ready for review has none. Fill and
 * label are palette keys; the pill is full-round, 11 semibold. */
export function pullRequestStatePill(pr: { state: string; isDraft?: boolean }) {
  if (pr.state === "MERGED") return { label: "Merged", fill: "purpleTint", ink: "purpleInk" } as const;
  if (pr.state === "CLOSED") return { label: "Closed", fill: "redTint", ink: "redInk" } as const;
  return pr.isDraft ? ({ label: "Draft", fill: "hover", ink: "ink2" } as const) : null;
}

/** The auto-merge button's words once it is armed. */
export const AUTO_MERGE_LABEL = "Merges when ready";

/** Blocked PRs first, then other open PRs, then merged ones; retain creation order within each group. */
export function rowPullRequests(prs: PullRequest[]): PullRequest[] {
  const rank = (pr: PullRequest) => (pr.state === "MERGED" ? 2 : pullRequestBlockers(pr).length ? 0 : 1);
  return prs
    .map((pr, index) => ({ pr, index }))
    .sort((a, b) => rank(a.pr) - rank(b.pr) || a.index - b.index)
    .map(({ pr }) => pr);
}

/**
 * The composer's PR action: the first blocker among the PRs the Chat's row shows, in the row's order, that the agent
 * isn't already fixing. Reading the row's list keeps the action and the row's status about the same PRs.
 */
export function pullRequestAction(prs: PullRequest[], dismissed: string[] = []): { pr: PullRequest; blocker: PullRequestBlocker } | null {
  for (const pr of rowPullRequests(prs)) {
    const blocker = pullRequestBlockers(pr).find((candidate) => !isBlockerDismissed(dismissed, candidate, pr));
    if (blocker) return { pr, blocker };
  }
  return null;
}

const key = (blocker: PullRequestBlocker, url: string) => (blocker === "conflicts" ? url : `${blocker}:${url}`);

export function isBlockerDismissed(dismissed: string[], blocker: PullRequestBlocker, pr: BlockerStatus) {
  return dismissed.includes(key(blocker, pr.url));
}

/**
 * Once the agent is asked to fix a blocker, its action stays hidden through refreshes and failed lookups,
 * and comes back only after GitHub confirms that blocker cleared and it then recurs.
 */
export function updateBlockerDismissals(dismissed: string[], pr: BlockerStatus | null, clicked?: PullRequestBlocker): string[] {
  if (!pr) return dismissed;
  if (clicked) {
    const entry = key(clicked, pr.url);
    return blocks(pr, clicked) && !dismissed.includes(entry) ? [...dismissed, entry] : dismissed;
  }
  const cleared = ORDER.filter((blocker) => clears(pr, blocker)).map((blocker) => key(blocker, pr.url));
  return cleared.some((entry) => dismissed.includes(entry)) ? dismissed.filter((entry) => !cleared.includes(entry)) : dismissed;
}
