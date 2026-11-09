// The PR a Chat's branch opened, as the PR panel (desktop), the PR sheet (phone) and the iPad side panel show it.
// The daemon reads it with gh (packages/core/src/pull-request-review.cjs); every write goes back to GitHub.

export type PullRequestState = "OPEN" | "MERGED" | "CLOSED";
export type MergeMethod = "squash" | "merge" | "rebase";
export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export type PullRequestCheck = {
  name: string;
  /** The GitHub Actions workflow the job belongs to, when it is one. */
  workflow?: string;
  outcome: "pass" | "fail" | "running" | "skipped" | "neutral";
  url?: string;
};

export type PullRequestReviewer = {
  login: string;
  /** REQUESTED: asked to review, nothing yet. */
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "REQUESTED" | "DISMISSED";
  /** The verdict came before the latest push. */
  stale?: boolean;
  /** A requested team; login is its org/slug and it has no avatar. */
  team?: true;
};

export type PullRequestFile = {
  path: string;
  additions: number;
  deletions: number;
  status: "added" | "deleted" | "modified" | "renamed";
};

export type PullRequestComment = {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  /** Part of the viewer's pending review: only they see it until the review is submitted. */
  pending?: boolean;
};

export type PullRequestThread = {
  id: string;
  path: string;
  /** The line in the new file (RIGHT) or the old one (LEFT); null when the thread is outdated past any line. */
  line: number | null;
  side: "LEFT" | "RIGHT";
  resolved: boolean;
  outdated: boolean;
  comments: PullRequestComment[];
};

export type PullRequestDetail = {
  number: number;
  url: string;
  title: string;
  body: string;
  state: PullRequestState;
  isDraft: boolean;
  author: string;
  createdAt: string;
  updatedAt: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  baseRefOid: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** GitHub's merge box state: CLEAN, BLOCKED, BEHIND, DIRTY (conflicts), UNSTABLE, DRAFT, UNKNOWN. */
  mergeStateStatus: string;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  autoMerge: { method: MergeMethod } | null;
  viewerCanMergeAsAdmin: boolean;
  viewerIsAuthor: boolean;
  checks: PullRequestCheck[];
  reviewers: PullRequestReviewer[];
  labels: { name: string; color: string }[];
  commits: { oid: string; headline: string }[];
  files: PullRequestFile[];
  /** Review threads on lines; pending ones hold the viewer's draft comments. */
  threads: PullRequestThread[];
  /** Comments on the PR itself, not on a line. */
  comments: PullRequestComment[];
  /** The viewer's draft review: its id and how many comments it holds, null when there is none. */
  pendingReview: { id: string; count: number } | null;
  /** Commits on the Chat's folder that an open PR doesn't have yet; absent when none (or from a Mac that predates it). */
  localCommits?: number;
};

export type PullRequestDetailResult = { ok: true; pr: PullRequestDetail } | { ok: false; message: string };

/** A write to GitHub; `message` says why it failed (signed out of gh, no permission, merge blocked). */
export type PullRequestWriteResult = { ok: true } | { ok: false; message: string };

export type PullRequestRef = { cwd: string; number: number };

/** What the merge box says: ready, blocked by something, or done. Shared by every client so they word it the same. */
export type MergeStatus = {
  tone: "ready" | "blocked" | "pending" | "merged" | "closed" | "draft";
  title: string;
  detail: string;
};

/** A label of the PR's repository; `color` is GitHub's hex without the #. */
export type RepoLabel = { name: string; color: string; description: string };

export type RepoLabelsResult = { ok: true; labels: RepoLabel[] } | { ok: false; message: string };

export type ReviewerCandidatesResult = { ok: true; logins: string[] } | { ok: false; message: string };

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** "23 passed · 3 skipped", failures and running checks first; empty when the PR has none. */
export function checksSummary(checks: PullRequestCheck[]): string {
  const count = (...outcomes: PullRequestCheck["outcome"][]) => checks.filter((check) => outcomes.includes(check.outcome)).length;
  return [
    count("fail") && `${count("fail")} failing`,
    count("running") && `${count("running")} running`,
    count("pass", "neutral") && `${count("pass", "neutral")} passed`,
    count("skipped") && `${count("skipped")} skipped`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The checks bar beside the PR's tabs: counts for its split bar and the words next to it. Failures come first
 * ("2 of 25 failing"), then running ("13 of 18 done"), then "27 passed · 6 skipped", the Checks section's words. Neutral checks pass.
 */
export function checksProgress(checks: PullRequestCheck[]): {
  passed: number;
  failed: number;
  running: number;
  skipped: number;
  total: number;
  label: string;
  tone: "pass" | "fail" | "running" | "none";
} {
  const count = (...outcomes: PullRequestCheck["outcome"][]) => checks.filter((check) => outcomes.includes(check.outcome)).length;
  const counts = { passed: count("pass", "neutral"), failed: count("fail"), running: count("running"), skipped: count("skipped"), total: checks.length };
  if (!counts.total) return { ...counts, label: "", tone: "none" };
  if (counts.failed) return { ...counts, label: `${counts.failed} of ${counts.total} failing`, tone: "fail" };
  if (counts.running) return { ...counts, label: `${counts.total - counts.running} of ${counts.total} done`, tone: "running" };
  return { ...counts, label: checksSummary(checks), tone: "pass" };
}

export function checksOutcome(checks: PullRequestCheck[]): PullRequestCheck["outcome"] | null {
  if (!checks.length) return null;
  if (checks.some((check) => check.outcome === "fail")) return "fail";
  if (checks.some((check) => check.outcome === "running")) return "running";
  return "pass";
}

export function openThreads(pr: PullRequestDetail): PullRequestThread[] {
  return pr.threads.filter((thread) => !thread.resolved && thread.comments.some((comment) => !comment.pending));
}

/** Whether "Merge" merges now; otherwise the client offers auto-merge (or, for an admin, merging anyway). */
export function canMergeNow(pr: PullRequestDetail): boolean {
  return pr.state === "OPEN" && !pr.isDraft && ["CLEAN", "UNSTABLE", "HAS_HOOKS"].includes(pr.mergeStateStatus);
}

/** The merge box's words, the same on desktop, phone and iPad. */
export function mergeStatus(pr: PullRequestDetail): MergeStatus {
  if (pr.state === "MERGED") return { tone: "merged", title: "Merged", detail: `Merged into ${pr.baseRefName}` };
  if (pr.state === "CLOSED") return { tone: "closed", title: "Closed", detail: "Closed without merging" };
  if (pr.isDraft) return { tone: "draft", title: "Draft", detail: "Mark it ready for review before merging" };
  const failing = pr.checks.filter((check) => check.outcome === "fail").length;
  const approvals = pr.reviewers.filter((reviewer) => reviewer.state === "APPROVED" && !reviewer.stale).length;
  if (pr.mergeStateStatus === "DIRTY") return { tone: "blocked", title: "Conflicts", detail: `This branch conflicts with ${pr.baseRefName}` };
  if (failing) return { tone: "blocked", title: "Checks failing", detail: `${plural(failing, "check")} failed of ${pr.checks.length}` };
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    const who = pr.reviewers.find((reviewer) => reviewer.state === "CHANGES_REQUESTED")?.login;
    return { tone: "blocked", title: "Changes requested", detail: who ? `${who} asked for changes` : "A reviewer asked for changes" };
  }
  if (pr.mergeStateStatus === "BEHIND") return { tone: "blocked", title: "Behind", detail: `Update the branch with ${pr.baseRefName} to merge` };
  if (pr.checks.some((check) => check.outcome === "running")) return { tone: "pending", title: "Checks running", detail: checksSummary(pr.checks) };
  if (canMergeNow(pr)) {
    const parts = [pr.checks.length ? "Checks passed" : "", approvals ? plural(approvals, "approval") : "", "no conflicts"].filter(Boolean);
    return { tone: "ready", title: "Ready to merge", detail: parts.join(" · ") };
  }
  if (pr.reviewDecision === "REVIEW_REQUIRED") return { tone: "pending", title: "Waiting for review", detail: "A review is required before merging" };
  if (pr.mergeStateStatus === "BLOCKED") return { tone: "blocked", title: "Blocked", detail: "A branch rule blocks merging" };
  return { tone: "pending", title: "Checking", detail: "GitHub is checking if it can merge" };
}

/** "2 files · 1 commit": the Worktree's work an open PR doesn't have yet; empty when there is none. */
export function notInPrLabel(files: number, commits: number) {
  return [countOf(files, "file"), countOf(commits, "commit")].filter(Boolean).join(" · ");
}

const countOf = (count: number, one: string) => (count > 0 ? `${count} ${one}${count === 1 ? "" : "s"}` : "");
