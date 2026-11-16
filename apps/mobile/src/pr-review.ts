import { parsePatch, type DiffLine } from "@milagre/shared/diff-parse";
import { splitRows, wordChanges, type Range } from "@milagre/shared/diff-layout";
import { openThreads } from "@milagre/shared/pull-request-review";
import { quoteMarkdown } from "@milagre/shared/prompt-parts";
import type { MergeMethod, PullRequestComment, PullRequestDetail, PullRequestFile, PullRequestThread } from "@milagre/shared/pull-request-review";
import type { DiffRow } from "./diff-rows";

// What the PR sheet (phone) and the PR panel (iPad) work out from a PR, kept out of the components so it is tested.

export const MERGE_METHODS: { value: MergeMethod; title: string }[] = [
  { value: "squash", title: "Squash and merge" },
  { value: "merge", title: "Create a merge commit" },
  { value: "rebase", title: "Rebase and merge" },
];

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function middleTruncate(text: string, max = 30) {
  if (text.length <= max) return text;
  const keep = max - 1;
  return `${text.slice(0, Math.ceil(keep / 2))}…${text.slice(text.length - Math.floor(keep / 2))}`;
}

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

export function filesByFolder(files: PullRequestFile[]): { folder: string; files: PullRequestFile[] }[] {
  const groups = new Map<string, PullRequestFile[]>();
  for (const file of files) {
    const cut = file.path.lastIndexOf("/");
    const folder = cut === -1 ? "" : file.path.slice(0, cut);
    groups.set(folder, [...(groups.get(folder) ?? []), file]);
  }
  // Hermes has no toSorted; these sort copies.
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([folder, list]) => ({ folder, files: list.slice().sort((a, b) => (a.path < b.path ? -1 : 1)) }));
}

export const fileName = (path: string) => path.split("/").pop() || path;

export const openThreadsOf = openThreads;

export const repoOf = (url: string) => /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url)?.[1] ?? "";

export function notInPrLine(files: number, commits: number) {
  const parts = [files && plural(files, "file"), commits && plural(commits, "commit")].filter(Boolean);
  return parts.length ? `${parts.join(" and ")} not in the PR yet` : "";
}

export function agoLabel(iso: string, now = Date.now()) {
  const value = ago(iso, now);
  return value === "now" ? "just now" : value ? `${value} ago` : "";
}

export function commentItems(pr: PullRequestDetail, newestFirst: boolean) {
  type Item = { type: "comment"; at: string; comment: PullRequestComment } | { type: "thread"; at: string; thread: PullRequestThread };
  const items: Item[] = [
    ...pr.comments.map((comment) => ({ type: "comment" as const, at: comment.createdAt, comment })),
    ...pr.threads.filter((thread) => !thread.resolved).map((thread) => ({ type: "thread" as const, at: thread.comments[0]?.createdAt ?? "", thread })),
  ];
  // Hermes has no toSorted; this sorts the copy above.
  items.sort((a, b) => (newestFirst ? Date.parse(b.at) - Date.parse(a.at) : Date.parse(a.at) - Date.parse(b.at)) || 0);
  return { items, resolved: pr.threads.filter((thread) => thread.resolved) };
}

export function lineMessage(pr: PullRequestDetail, path: string, line: number, side: "LEFT" | "RIGHT", text: string) {
  const at = side === "LEFT" ? `${path}, old line ${line}` : `${path}:${line}`;
  return `About ${at} in PR #${pr.number}:\n\n${text.trim()}`;
}

export const askPrefill = (pr: PullRequestDetail) => `About PR #${pr.number}: `;

export function threadFixMessage(pr: Pick<PullRequestDetail, "number">, thread: PullRequestThread) {
  const where = thread.line ? `${thread.path}:${thread.line}` : thread.path;
  const comments = thread.comments.filter((comment) => !comment.pending).map((comment) => `${comment.author} wrote:\n${quoteMarkdown(comment.body)}`);
  return `Address this review thread on PR #${pr.number}, at ${where}:\n\n${comments.join("\n\n")}\n\nMake the change, push it, and tell me what you did so I can reply and resolve the thread.`;
}

export function withLabels(pr: PullRequestDetail, add: string[], remove: string[], known: { name: string; color: string }[]): PullRequestDetail {
  const kept = pr.labels.filter((label) => !remove.includes(label.name) && !add.includes(label.name));
  const added = add.map((name) => ({ name, color: known.find((label) => label.name === name)?.color ?? "888888" }));
  return { ...pr, labels: [...kept, ...added] };
}

export function withReviewers(pr: PullRequestDetail, add: string[], remove: string[]): PullRequestDetail {
  const kept = pr.reviewers.filter((reviewer) => !remove.includes(reviewer.login) && !add.includes(reviewer.login));
  return { ...pr, reviewers: [...kept, ...add.map((login) => ({ login, state: "REQUESTED" as const }))] };
}

export function withResolved(pr: PullRequestDetail, threadId: string, resolved: boolean): PullRequestDetail {
  return { ...pr, threads: pr.threads.map((thread) => (thread.id === threadId ? { ...thread, resolved } : thread)) };
}

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

export function neighbours(files: PullRequestFile[], path: string) {
  const index = files.findIndex((file) => file.path === path);
  return { index, previous: index > 0 ? files[index - 1] : undefined, next: index >= 0 && index < files.length - 1 ? files[index + 1] : undefined };
}
