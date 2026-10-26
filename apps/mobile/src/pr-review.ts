import { parsePatch, type DiffLine } from "@milagre/shared/diff-parse";
import { splitRows, wordChanges, type Range } from "@milagre/shared/diff-layout";
import { openThreads } from "@milagre/shared/pull-request-review";
import type {
  MergeMethod,
  MergeStatus,
  PullRequestCheck,
  PullRequestDetail,
  PullRequestFile,
  PullRequestThread,
  ReviewGuide,
  ReviewGuideResult,
} from "@milagre/shared/pull-request-review";
import type { DiffRow } from "./diff-rows";

// What the PR sheet (phone) and the PR panel (iPad) work out from a PR, kept out of the components so it is tested.

export const MERGE_METHODS: { value: MergeMethod; title: string }[] = [
  { value: "squash", title: "Squash and merge" },
  { value: "merge", title: "Create a merge commit" },
  { value: "rebase", title: "Rebase and merge" },
];

export const mergeLabel = (method: MergeMethod) => (method === "merge" ? "Merge" : (MERGE_METHODS.find((entry) => entry.value === method)?.title ?? "Merge"));

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Long branch names lose their middle, not their end: the end tells Worktree branches apart. */
export function middleTruncate(text: string, max = 30) {
  if (text.length <= max) return text;
  const keep = max - 1;
  return `${text.slice(0, Math.ceil(keep / 2))}…${text.slice(text.length - Math.floor(keep / 2))}`;
}

/** "2h", "3d": how long ago, for the author line. */
export function ago(iso: string, now = Date.now()) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.max(0, Math.round((now - at) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d` : `${Math.round(days / 30)}mo`;
}

export function viewedCount(files: PullRequestFile[]) {
  return { viewed: files.filter((file) => file.viewed === "VIEWED").length, total: files.length };
}

/** The PR's files under their folders, folders and names in order. */
export function filesByFolder(files: PullRequestFile[]): { folder: string; files: PullRequestFile[] }[] {
  const groups = new Map<string, PullRequestFile[]>();
  for (const file of files) {
    const cut = file.path.lastIndexOf("/");
    const folder = cut === -1 ? "" : file.path.slice(0, cut);
    groups.set(folder, [...(groups.get(folder) ?? []), file]);
  }
  // Hermes has no toSorted; these sort copies.
  /* oxlint-disable unicorn/no-array-sort */
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([folder, list]) => ({ folder, files: list.slice().sort((a, b) => (a.path < b.path ? -1 : 1)) }));
  /* oxlint-enable unicorn/no-array-sort */
}

export const fileName = (path: string) => path.split("/").pop() || path;

/** The threads still waiting on someone: unresolved, with at least one comment others can see (shared with desktop). */
export const openThreadsOf = openThreads;

/** What the Reviews row says: open threads first, else the reviewers' verdicts. */
export function reviewsSummary(pr: PullRequestDetail) {
  const open = openThreadsOf(pr).length;
  if (open) return plural(open, "open thread");
  const approved = pr.reviewers.filter((reviewer) => reviewer.state === "APPROVED" && !reviewer.stale);
  const changes = pr.reviewers.find((reviewer) => reviewer.state === "CHANGES_REQUESTED");
  if (changes) return `Changes requested by ${changes.login}`;
  if (approved[0]) return approved.length === 1 ? `Approved by ${approved[0].login}` : `${approved.length} approvals`;
  if (pr.reviewers.some((reviewer) => reviewer.state === "REQUESTED")) return "Review requested";
  return "No reviews yet";
}

export type GuideRow = { action: "start" | "open" | "rewrite" | "writing"; value: string; stale: boolean; error?: string };

/** The Review guide row: start one, keep reading it, rewrite one written before the latest push, or wait for it. */
export function guideRow(result: ReviewGuideResult | null, pr: PullRequestDetail): GuideRow {
  if (!result || !result.ok) return { action: "start", value: "", stale: false, ...(result && !result.ok && { error: result.message }) };
  if (result.writing) return { action: "writing", value: "Writing…", stale: false };
  const guide = result.guide;
  if (!guide) return { action: "start", value: "", stale: false, ...(result.error && { error: result.error }) };
  const stale = guide.headRefOid !== pr.headRefOid;
  const read = result.read.filter((stop) => stop < guide.stops.length).length;
  return { action: "open", value: `${read} of ${guide.stops.length} read`, stale, ...(result.error && { error: result.error }) };
}

/** Where "Continue" lands: the first stop not read yet, else the first. */
export function nextStop(guide: ReviewGuide, read: number[]) {
  const index = guide.stops.findIndex((_stop, at) => !read.includes(at));
  return index === -1 ? 0 : index;
}

// What "Fix in Chat", "Ask in Chat" and "Send to Chat" put in the Chat: enough for its agent to find the place on its own.

const quote = (text: string) =>
  text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

const where = (path: string, line: number | null) => (line ? `${path}:${line}` : path);

export function threadMessage(pr: PullRequestDetail, thread: PullRequestThread) {
  const comments = thread.comments.filter((comment) => !comment.pending).map((comment) => `${comment.author} wrote:\n${quote(comment.body)}`);
  return `Address this review comment on PR #${pr.number} (${pr.url}), on ${where(thread.path, thread.line)}:\n\n${comments.join("\n\n")}\n\nFix it on this branch and push, then tell me what you changed.`;
}

export function threadsMessage(pr: PullRequestDetail, threads: PullRequestThread[]) {
  if (threads.length === 1 && threads[0]) return threadMessage(pr, threads[0]);
  const parts = threads.map((thread, index) => {
    const first = thread.comments.find((comment) => !comment.pending);
    return `${index + 1}. ${where(thread.path, thread.line)} (${first?.author ?? "reviewer"}):\n${quote(first?.body ?? "")}`;
  });
  return `Address the ${threads.length} open review threads on PR #${pr.number} (${pr.url}):\n\n${parts.join("\n\n")}\n\nFix them on this branch and push, then tell me what you changed in each.`;
}

export function checkMessage(pr: PullRequestDetail, check: PullRequestCheck) {
  const name = check.workflow ? `${check.workflow} / ${check.name}` : check.name;
  return `The "${name}" check failed on PR #${pr.number} (${pr.url}).${check.url ? ` Its log: ${check.url}` : ""}\n\nFind out why, fix it on this branch and push.`;
}

export function lineMessage(pr: PullRequestDetail, path: string, line: number, side: "LEFT" | "RIGHT", text: string) {
  const at = side === "LEFT" ? `${path}, old line ${line}` : `${path}:${line}`;
  return `About ${at} in PR #${pr.number}:\n\n${text.trim()}`;
}

/** The merge box's blocker, as a request to the Chat; null when there is nothing for the agent to fix. */
export function blockerMessage(pr: PullRequestDetail, status: MergeStatus) {
  if (status.tone !== "blocked") return null;
  const target = `PR #${pr.number} (${pr.url})`;
  if (status.title === "Conflicts")
    return `${target} conflicts with ${pr.baseRefName}. Merge ${pr.baseRefName} into this branch, resolve the conflicts and push.`;
  if (status.title === "Checks failing") {
    const failing = pr.checks
      .filter((check) => check.outcome === "fail")
      .map((check) => `- ${check.workflow ? `${check.workflow} / ` : ""}${check.name}${check.url ? ` (${check.url})` : ""}`);
    return `These checks fail on ${target}:\n${failing.join("\n")}\n\nFind out why, fix them on this branch and push.`;
  }
  if (status.title === "Behind") return `${target} is behind ${pr.baseRefName}. Update this branch with ${pr.baseRefName} and push.`;
  if (status.title === "Changes requested") {
    const open = openThreadsOf(pr);
    return open.length ? threadsMessage(pr, open) : `A reviewer requested changes on ${target}. Read the review and address it on this branch.`;
  }
  return null;
}

export const askPrefill = (pr: PullRequestDetail) => `About PR #${pr.number}: `;

// Optimistic writes: the sheet shows the change at once and the next read confirms or undoes it.

export function withViewed(pr: PullRequestDetail, path: string, viewed: boolean): PullRequestDetail {
  return { ...pr, files: pr.files.map((file) => (file.path === path ? { ...file, viewed: viewed ? "VIEWED" : "UNVIEWED" } : file)) };
}

export function withResolved(pr: PullRequestDetail, threadId: string, resolved: boolean): PullRequestDetail {
  return { ...pr, threads: pr.threads.map((thread) => (thread.id === threadId ? { ...thread, resolved } : thread)) };
}

/** The line a diff row comments on: added and unchanged lines by their new number, removed ones by their old number. */
export function lineTarget(line: DiffLine): { line: number; side: "LEFT" | "RIGHT" } | null {
  if (line.kind === "remove") return line.oldNumber ? { line: line.oldNumber, side: "LEFT" } : null;
  return line.newNumber ? { line: line.newNumber, side: "RIGHT" } : null;
}

const onLine = (line: DiffLine | undefined, thread: PullRequestThread) =>
  !!line &&
  thread.line !== null &&
  (thread.side === "LEFT" ? line.kind !== "add" && line.oldNumber === thread.line : line.kind !== "remove" && line.newNumber === thread.line);

export type SplitDiffRow =
  | { type: "hunk"; key: string; header: string }
  | { type: "pair"; key: string; left?: DiffLine; right?: DiffLine; leftWords: Range[]; rightWords: Range[] };

/** The patch side by side for a wide screen: each hunk header, then old and new lines paired with their changed words. */
export function splitDiffRows(patch: string): SplitDiffRow[] {
  const rows: SplitDiffRow[] = [];
  parsePatch(patch).forEach((hunk, hunkIndex) => {
    rows.push({ type: "hunk", key: `h${hunkIndex}`, header: hunk.header });
    splitRows(hunk).forEach(({ left, right }, index) => {
      const words = left?.kind === "remove" && right?.kind === "add" ? wordChanges(left.text, right.text) : { old: [], new: [] };
      rows.push({ type: "pair", key: `${hunkIndex}:${index}`, left, right, leftWords: words.old, rightWords: words.new });
    });
  });
  return rows;
}

export type WithThreads<T> = { items: ({ type: "row"; row: T } | { type: "thread"; key: string; thread: PullRequestThread })[]; detached: PullRequestThread[] };

/** A file's rows with each review thread right under the line it is on; threads no line here carries come back apart. */
export function attachThreads<T extends DiffRow | SplitDiffRow>(rows: T[], threads: PullRequestThread[]): WithThreads<T> {
  const placed = new Set<string>();
  const items: WithThreads<T>["items"] = [];
  for (const row of rows) {
    items.push({ type: "row", row });
    for (const thread of threads) {
      if (placed.has(thread.id)) continue;
      const hit = row.type === "line" ? onLine(row.line, thread) : row.type === "pair" ? onLine(row.left, thread) || onLine(row.right, thread) : false;
      if (!hit) continue;
      placed.add(thread.id);
      items.push({ type: "thread", key: `t:${thread.id}`, thread });
    }
  }
  return { items, detached: threads.filter((thread) => !placed.has(thread.id)) };
}

/** The file before and after `path` in the PR's file order, for the diff's previous and next buttons. */
export function neighbours(files: PullRequestFile[], path: string) {
  const index = files.findIndex((file) => file.path === path);
  return { index, previous: index > 0 ? files[index - 1] : undefined, next: index >= 0 && index < files.length - 1 ? files[index + 1] : undefined };
}
