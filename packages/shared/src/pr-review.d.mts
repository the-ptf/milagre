export type ReviewSeverity = "high" | "medium" | "low";
/** `sent` went to a Chat to fix; `dismissed` the user set aside. */
export type ReviewFindingStatus = "open" | "sent" | "dismissed";

export type ReviewFinding = {
  id: string;
  path: string;
  line: number | null;
  severity: ReviewSeverity;
  title: string;
  body: string;
  suggestion: string | null;
  status: ReviewFindingStatus;
};

/** The latest review agent report on a PR, kept by the computer that ran it. `chatId` is the reviewing Chat's key. */
export type PrReview = {
  url: string;
  summary: string;
  reviewedAt: number;
  chatId: string | null;
  findings: ReviewFinding[];
  /** Findings handed to the PR's Babysit Heartbeat, when one watches it. */
  babysat: boolean;
};

export type ReviewCounts = { open: number; high: number; medium: number; low: number };
export type ReviewReport = { url: string; summary: string; findings: Omit<ReviewFinding, "id" | "status">[] };

export const REVIEW_SEVERITIES: ReviewSeverity[];
export const REVIEW_FINDING_STATUSES: ReviewFindingStatus[];
export function reviewForMePrompt(pr: { url: string; repo: string; number: number; title: string }, options?: { report?: boolean }): string;
export function mentionsPullRequestUrl(prompt: unknown, url: string): boolean;
export function parseReviewReport(input: unknown): ReviewReport | Error;
export function reviewCounts(review: Pick<PrReview, "findings"> | null | undefined): ReviewCounts;
export function reviewFixMessage(url: string, findings: readonly Pick<ReviewFinding, "path" | "line" | "severity" | "title" | "body" | "suggestion">[]): string;
export function reviewBabysitChanges(findings: readonly ReviewFinding[]): { id: string; text: string }[];

export const REVIEW_AGENT_DESCRIPTION: string;
export function findingsLabel(count: number): string;
export type ReviewCountMap = Record<string, ReviewCounts & { reviewedAt: number }>;
export function latestReviewSources<T>(
  entries: readonly (readonly [T, ReviewCountMap | null])[],
): Map<string, ReviewCounts & { reviewedAt: number; source: T }>;
