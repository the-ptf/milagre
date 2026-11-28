export type PullRequestListState = "open" | "merged" | "closed" | "all";
export type PullRequestChecksState = "pass" | "fail" | "running" | "none";

/** Counts from the head commit's check rollup. `total` includes skipped and neutral checks. */
export type PullRequestChecks = {
  state: PullRequestChecksState;
  passed: number;
  failed: number;
  running: number;
  skipped: number;
  total: number;
};

export type PullRequestListLabel = { name: string; color: string };
/** A Project on the answering computer whose repository the PR is in. `cwd` is a folder `pr:*` commands accept. */
export type PullRequestListProject = { path: string; name: string; cwd: string };
/** A Chat on the answering computer that opened or pushed to the PR. */
export type PullRequestListChat = { projectPath: string; chatId: number; title: string };

/** One PR as one computer's `pull-requests:list` reads it. `repo` is the canonical `owner/name`. */
export type PullRequestListItem = {
  url: string;
  repo: string;
  number: number;
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  author: { login: string; avatarUrl: string | null } | null;
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  createdAt: string;
  updatedAt: string;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" | null;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  reviewRequested: boolean;
  authored: boolean;
  labels: PullRequestListLabel[];
  checks: PullRequestChecks;
  projects: PullRequestListProject[];
  chats: PullRequestListChat[];
};

/** A computer's answer. `errors` name repositories or reads that failed; the rest of the list still came back. */
export type PullRequestList = {
  viewer: string | null;
  fetchedAt: number;
  repos: string[];
  items: PullRequestListItem[];
  errors: string[];
};

/** One check on the PR's head commit, for the checks hover card. */
export type PullRequestListCheck = {
  name: string;
  workflow: string | null;
  state: "pass" | "fail" | "running" | "skipped" | "neutral";
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

/** A PR in the merged list across computers: Projects and Chats carry the computer they are on. */
export type PullRequestRow = Omit<PullRequestListItem, "projects" | "chats"> & {
  projects: (PullRequestListProject & { computerId: string })[];
  chats: (PullRequestListChat & { computerId: string })[];
  computerId: string;
  computerIds: string[];
  offline: boolean;
};

export type PullRequestSort = "updated" | "readiness" | "blocked" | "newest" | "oldest" | "largest" | "smallest";
export type PullRequestFilters = {
  state: PullRequestListState;
  involvement: "all" | "review" | "authored";
  author: string | null;
  label: string | null;
  draft: "all" | "hide" | "only";
  review: "all" | "required" | "approved" | "changes";
  checks: "all" | "passing" | "failing" | "running";
  chat: "any" | "chat" | "none";
  project: string | null;
};
export type PullRequestGroupId = "review" | "authored" | "other";
export type PullRequestQuery = {
  words: string[];
  labels: string[];
  authors: string[];
  repos: string[];
  notLabels: string[];
  notAuthors: string[];
  notRepos: string[];
  draft: boolean | null;
};
type Choice<T extends string> = { id: T; label: string };

export const PULL_REQUEST_STATES: PullRequestListState[];
export const PULL_REQUEST_SORTS: Choice<PullRequestSort>[];
export const PULL_REQUEST_FILTER_DEFAULTS: Readonly<PullRequestFilters>;
export const PULL_REQUEST_FILTER_CHOICES: {
  state: Choice<PullRequestFilters["state"]>[];
  involvement: Choice<PullRequestFilters["involvement"]>[];
  draft: Choice<PullRequestFilters["draft"]>[];
  review: Choice<PullRequestFilters["review"]>[];
  checks: Choice<PullRequestFilters["checks"]>[];
  chat: Choice<PullRequestFilters["chat"]>[];
};
export const PULL_REQUEST_GROUPS: Choice<PullRequestGroupId>[];

type Filterable = Pick<
  PullRequestListItem,
  | "url"
  | "repo"
  | "number"
  | "title"
  | "state"
  | "isDraft"
  | "author"
  | "headRefName"
  | "additions"
  | "deletions"
  | "createdAt"
  | "updatedAt"
  | "mergeable"
  | "reviewDecision"
  | "reviewRequested"
  | "authored"
  | "labels"
  | "checks"
> & { projects: { path: string; name: string }[]; chats: unknown[] };

export function parsePullRequestQuery(text: unknown): PullRequestQuery;
export function pullRequestGroup(item: Pick<PullRequestListItem, "reviewRequested" | "authored">): PullRequestGroupId;
export function filterPullRequests<T extends Filterable>(items: readonly T[], filters?: PullRequestFilters, text?: string): T[];
export function activePullRequestFilters(filters: PullRequestFilters): number;
export function sortPullRequests<T extends Filterable>(items: readonly T[], sort?: PullRequestSort): T[];
export function groupPullRequests<T extends Filterable>(items: readonly T[]): (Choice<PullRequestGroupId> & { items: T[] })[];
export function pullRequestChecksLabel(checks: PullRequestChecks): string;
export function pullRequestChecksSummary(checks: PullRequestChecks): string;
export function pullRequestReviewBadge(item: Pick<PullRequestListItem, "state" | "isDraft" | "reviewDecision">): {
  label: string;
  tone: "green" | "red" | "orange" | "purple" | "neutral";
};
export function pullRequestFilterValues(items: readonly Filterable[]): {
  authors: string[];
  labels: string[];
  projects: { path: string; name: string }[];
};
export function mergePullRequestLists(lists: readonly { computerId: string; list: PullRequestList | null | undefined; offline?: boolean }[]): PullRequestRow[];
