import type { MergeMethod, PullRequestDetail, PullRequestThread } from "@milagre/shared/pull-request-review";
import type { DiffLine } from "./diff-parse";

// The PR panel's pure parts: where a GitHub thread sits in the diff, the counts the panel shows, the merge method
// remembered per repository, and the message a thread's "Fix in Chat" sends to the Chat.

/** The Changes panel's modes: a Chat's own changes, or the PR its branch opened. */
export type ChangesMode = "uncommitted" | "committed" | "pr";

export type PrRange = { base: string; head: string };

export function prRange(pr: Pick<PullRequestDetail, "baseRefOid" | "headRefOid"> | null | undefined): PrRange | undefined {
  return pr?.baseRefOid && pr.headRefOid ? { base: pr.baseRefOid, head: pr.headRefOid } : undefined;
}

const NO_THREADS: PullRequestThread[] = [];

/** Each file's threads, the same array for a file whose threads didn't change, so its diff doesn't re-render. */
export function threadsByPath(threads: PullRequestThread[], previous?: Map<string, PullRequestThread[]>) {
  const next = new Map<string, PullRequestThread[]>();
  for (const thread of threads) next.set(thread.path, [...(next.get(thread.path) ?? []), thread]);
  for (const [path, group] of next) {
    const old = previous?.get(path);
    if (old && old.length === group.length && old.every((thread, index) => JSON.stringify(thread) === JSON.stringify(group[index]))) next.set(path, old);
  }
  return next;
}

export const threadsFor = (byPath: Map<string, PullRequestThread[]>, path: string) => byPath.get(path) ?? NO_THREADS;

/** The threads GitHub anchors to a diff line: RIGHT threads to its new line number, LEFT ones to its old. */
export function threadsOnLine(threads: PullRequestThread[], line: DiffLine): PullRequestThread[] {
  if (!threads.length) return NO_THREADS;
  const found = threads.filter(
    (thread) =>
      thread.line !== null &&
      ((thread.side === "RIGHT" && line.kind !== "remove" && line.newNumber === thread.line) ||
        (thread.side === "LEFT" && line.kind !== "add" && line.oldNumber === thread.line)),
  );
  return found.length ? found : NO_THREADS;
}

/** Threads no row of the shown diff carries (outdated, or on lines outside its hunks); they gather under the file. */
export function unplacedThreads(threads: PullRequestThread[], lines: DiffLine[]): PullRequestThread[] {
  return threads.filter((thread) => !lines.some((line) => threadsOnLine([thread], line).length > 0));
}

export const threadState = (thread: PullRequestThread) =>
  thread.comments.every((comment) => comment.pending) ? "pending" : thread.resolved ? "resolved" : thread.outdated ? "outdated" : "open";

export function openThreadCount(threads: PullRequestThread[]) {
  return threads.filter((thread) => threadState(thread) === "open").length;
}

/** "owner/name" from a PR address, or null. */
export function repoOf(url: string): string | null {
  const match = /^https:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(url);
  return match?.[1] ?? null;
}

const METHOD_KEY = "milagre:pr-merge-method";
export const MERGE_METHODS: { value: MergeMethod; label: string; action: string }[] = [
  { value: "squash", label: "Squash", action: "Squash and merge" },
  { value: "merge", label: "Merge commit", action: "Merge" },
  { value: "rebase", label: "Rebase", action: "Rebase and merge" },
];

/** The merge method last used in a repository; squash until one was picked. */
export function readMergeMethod(url: string, storage: Pick<Storage, "getItem"> = localStorage): MergeMethod {
  try {
    const saved = JSON.parse(storage.getItem(METHOD_KEY) ?? "{}")?.[repoOf(url) ?? ""];
    return MERGE_METHODS.some((method) => method.value === saved) ? saved : "squash";
  } catch {
    return "squash";
  }
}

export function saveMergeMethod(url: string, method: MergeMethod, storage: Pick<Storage, "getItem" | "setItem"> = localStorage) {
  const repo = repoOf(url);
  if (!repo) return;
  let saved: Record<string, MergeMethod> = {};
  try {
    saved = JSON.parse(storage.getItem(METHOD_KEY) ?? "{}") ?? {};
  } catch {}
  storage.setItem(METHOD_KEY, JSON.stringify({ ...saved, [repo]: method }));
}

const quote = (text: string) =>
  text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

/** "Fix in Chat" on a review thread: the thread, where it sits, and the ask. */
export function threadFixMessage(pr: Pick<PullRequestDetail, "number">, thread: PullRequestThread): string {
  const where = thread.line ? `${thread.path}:${thread.line}` : thread.path;
  const comments = thread.comments.filter((comment) => !comment.pending).map((comment) => `${comment.author} wrote:\n${quote(comment.body)}`);
  return `Address this review thread on PR #${pr.number}, at ${where}:\n\n${comments.join("\n\n")}\n\nMake the change, push it, and tell me what you did so I can reply and resolve the thread.`;
}

/** A relative age like "2h" for a GitHub timestamp. */
export function age(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
