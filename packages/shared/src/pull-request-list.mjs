export const PULL_REQUEST_STATES = ["open", "merged", "closed", "all"];

export const PULL_REQUEST_SORTS = [
  { id: "updated", label: "Recently updated" },
  { id: "readiness", label: "Merge readiness" },
  { id: "blocked", label: "Blocked on me" },
  { id: "newest", label: "Newest" },
  { id: "oldest", label: "Oldest" },
  { id: "largest", label: "Largest" },
  { id: "smallest", label: "Smallest" },
];

export const PULL_REQUEST_FILTER_DEFAULTS = Object.freeze({
  state: "open",
  involvement: "all",
  author: null,
  label: null,
  draft: "all",
  review: "all",
  checks: "all",
  chat: "any",
  project: null,
});

export const PULL_REQUEST_FILTER_CHOICES = {
  state: [
    { id: "open", label: "Open" },
    { id: "merged", label: "Merged" },
    { id: "closed", label: "Closed" },
    { id: "all", label: "All" },
  ],
  involvement: [
    { id: "all", label: "All" },
    { id: "review", label: "Review requested" },
    { id: "authored", label: "Authored" },
  ],
  draft: [
    { id: "all", label: "All" },
    { id: "hide", label: "Hide drafts" },
    { id: "only", label: "Only drafts" },
  ],
  review: [
    { id: "all", label: "All" },
    { id: "required", label: "Review required" },
    { id: "approved", label: "Approved" },
    { id: "changes", label: "Changes requested" },
  ],
  checks: [
    { id: "all", label: "All" },
    { id: "passing", label: "Passing" },
    { id: "failing", label: "Failing" },
    { id: "running", label: "Running" },
  ],
  chat: [
    { id: "any", label: "Any" },
    { id: "chat", label: "Opened by a Chat" },
    { id: "none", label: "No Chat" },
  ],
};

export const PULL_REQUEST_GROUPS = [
  { id: "review", label: "Review requested" },
  { id: "authored", label: "Yours" },
  { id: "other", label: "Others" },
];

const TOKEN = /(-?)(label|author|repo|is):("[^"]*"|\S+)/gi;

/** Splits a search box into free words and `label:`, `author:`, `repo:`, `is:draft` terms, GitHub style. */
export function parsePullRequestQuery(text) {
  const query = { words: [], labels: [], authors: [], repos: [], draft: null };
  const rest = String(text ?? "").replace(TOKEN, (_all, not, key, raw) => {
    const value = raw.replace(/^"|"$/g, "").toLowerCase();
    if (!value) return " ";
    const kind = key.toLowerCase();
    if (kind === "label") query.labels.push(value);
    else if (kind === "author") query.authors.push(value);
    else if (kind === "repo") query.repos.push(value);
    else if (value === "draft") query.draft = !not;
    return " ";
  });
  query.words = rest.toLowerCase().split(/\s+/).filter(Boolean);
  return query;
}

function matchesQuery(item, query) {
  const haystack = `${item.title} #${item.number} ${item.repo} ${item.author?.login ?? ""} ${item.headRefName ?? ""}`.toLowerCase();
  if (!query.words.every((word) => haystack.includes(word))) return false;
  const labels = new Set(item.labels.map((label) => label.name.toLowerCase()));
  if (!query.labels.every((label) => labels.has(label))) return false;
  if (query.authors.length && !query.authors.includes((item.author?.login ?? "").toLowerCase())) return false;
  if (query.repos.length && !query.repos.some((repo) => item.repo.toLowerCase() === repo || item.repo.toLowerCase().endsWith(`/${repo}`))) return false;
  if (query.draft !== null && item.isDraft !== query.draft) return false;
  return true;
}

export function pullRequestGroup(item) {
  if (item.reviewRequested) return "review";
  if (item.authored) return "authored";
  return "other";
}

function matchesFilters(item, filters) {
  const group = pullRequestGroup(item);
  if (filters.involvement === "review" && group !== "review") return false;
  if (filters.involvement === "authored" && group !== "authored") return false;
  if (filters.author && (item.author?.login ?? "") !== filters.author) return false;
  if (filters.label && !item.labels.some((label) => label.name === filters.label)) return false;
  if (filters.draft === "hide" && item.isDraft) return false;
  if (filters.draft === "only" && !item.isDraft) return false;
  if (filters.review === "required" && item.reviewDecision !== "REVIEW_REQUIRED") return false;
  if (filters.review === "approved" && item.reviewDecision !== "APPROVED") return false;
  if (filters.review === "changes" && item.reviewDecision !== "CHANGES_REQUESTED") return false;
  if (filters.checks === "passing" && item.checks.state !== "pass") return false;
  if (filters.checks === "failing" && item.checks.state !== "fail") return false;
  if (filters.checks === "running" && item.checks.state !== "running") return false;
  if (filters.chat === "chat" && !item.chats.length) return false;
  if (filters.chat === "none" && item.chats.length) return false;
  if (filters.project && !item.projects.some((project) => project.path === filters.project)) return false;
  if (filters.state !== "all" && item.state !== filters.state.toUpperCase()) return false;
  return true;
}

export function filterPullRequests(items, filters = PULL_REQUEST_FILTER_DEFAULTS, text = "") {
  const query = parsePullRequestQuery(text);
  return items.filter((item) => matchesFilters(item, filters) && matchesQuery(item, query));
}

/** How many filters differ from the defaults, for the Filters button's count. The state filter is not counted. */
export function activePullRequestFilters(filters) {
  return Object.keys(PULL_REQUEST_FILTER_DEFAULTS).filter((key) => key !== "state" && filters[key] !== PULL_REQUEST_FILTER_DEFAULTS[key]).length;
}

function readiness(item) {
  if (item.isDraft) return 5;
  if (item.checks.state === "fail" || item.mergeable === "CONFLICTING" || item.reviewDecision === "CHANGES_REQUESTED") return 4;
  if (item.checks.state === "running") return 3;
  if (item.reviewDecision === "REVIEW_REQUIRED") return 2;
  if (item.reviewDecision === "APPROVED" || item.reviewDecision === null) return item.checks.state === "pass" || item.checks.state === "none" ? 0 : 1;
  return 1;
}

function blocked(item) {
  if (item.reviewRequested) return 0;
  if (item.authored && (item.checks.state === "fail" || item.reviewDecision === "CHANGES_REQUESTED" || item.mergeable === "CONFLICTING")) return 1;
  return 2;
}

const time = (value) => Date.parse(value ?? "") || 0;
const size = (item) => (item.additions ?? 0) + (item.deletions ?? 0);
const COMPARE = {
  updated: (a, b) => time(b.updatedAt) - time(a.updatedAt),
  readiness: (a, b) => readiness(a) - readiness(b),
  blocked: (a, b) => blocked(a) - blocked(b),
  newest: (a, b) => time(b.createdAt) - time(a.createdAt),
  oldest: (a, b) => time(a.createdAt) - time(b.createdAt),
  largest: (a, b) => size(b) - size(a),
  smallest: (a, b) => size(a) - size(b),
};

export function sortPullRequests(items, sort = "updated") {
  const compare = COMPARE[sort] ?? COMPARE.updated;
  return [...items].sort((a, b) => compare(a, b) || COMPARE.updated(a, b) || a.url.localeCompare(b.url));
}

/** Review requested, then yours, then the rest; empty groups are left out. */
export function groupPullRequests(items) {
  return PULL_REQUEST_GROUPS.map((group) => ({ ...group, items: items.filter((item) => pullRequestGroup(item) === group.id) })).filter(
    (group) => group.items.length,
  );
}

/** The short checks text a row shows: `9/9`, `4/9` while running, `1 failed`, or empty with no checks. */
export function pullRequestChecksLabel(checks) {
  const counted = checks.total - checks.skipped;
  if (checks.failed) return `${checks.failed} failed`;
  return counted ? `${checks.passed}/${counted}` : "";
}

/** The checks summary the hover card and the panel lead with: `1 failed · 2 running · 6 passed`. */
export function pullRequestChecksSummary(checks) {
  return [
    checks.failed && `${checks.failed} failed`,
    checks.running && `${checks.running} running`,
    checks.passed && `${checks.passed} passed`,
    checks.skipped && `${checks.skipped} skipped`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The review badge a row shows when it has no Review for me button. */
export function pullRequestReviewBadge(item) {
  if (item.state === "MERGED") return { label: "Merged", tone: "purple" };
  if (item.state === "CLOSED") return { label: "Closed", tone: "red" };
  if (item.isDraft) return { label: "Draft", tone: "neutral" };
  if (item.reviewDecision === "CHANGES_REQUESTED") return { label: "Changes requested", tone: "red" };
  if (item.reviewDecision === "APPROVED") return { label: "Approved", tone: "green" };
  if (item.reviewDecision === "REVIEW_REQUIRED") return { label: "Review required", tone: "orange" };
  return { label: "No review", tone: "neutral" };
}

/** The values the Author, Labels and Project submenus offer, from the PRs loaded. */
export function pullRequestFilterValues(items) {
  const authors = new Set();
  const labels = new Set();
  const projects = new Map();
  for (const item of items) {
    if (item.author?.login) authors.add(item.author.login);
    for (const label of item.labels) labels.add(label.name);
    for (const project of item.projects) if (!projects.has(project.path)) projects.set(project.path, project.name);
  }
  const byName = (a, b) => a.localeCompare(b);
  return {
    authors: [...authors].sort(byName),
    labels: [...labels].sort(byName),
    projects: [...projects].map(([path, name]) => ({ path, name })).sort((a, b) => byName(a.name, b.name)),
  };
}

/**
 * One list from every computer's answer. A PR two computers both see shows once, from the first online computer in
 * `lists` order, with every computer's Projects and Chats.
 */
export function mergePullRequestLists(lists) {
  const byUrl = new Map();
  const ordered = [...lists].sort((a, b) => Number(Boolean(a.offline)) - Number(Boolean(b.offline)));
  for (const { computerId, list, offline } of ordered) {
    for (const item of list?.items ?? []) {
      const projects = item.projects.map((project) => ({ ...project, computerId }));
      const chats = item.chats.map((chat) => ({ ...chat, computerId }));
      const seen = byUrl.get(item.url);
      if (seen) {
        seen.projects.push(...projects);
        seen.chats.push(...chats);
        seen.computerIds.push(computerId);
        continue;
      }
      byUrl.set(item.url, { ...item, projects, chats, computerId, computerIds: [computerId], offline: Boolean(offline) });
    }
  }
  return [...byUrl.values()];
}
