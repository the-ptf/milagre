import type { PullRequestListItem } from "@milagre/shared/pull-request-list";

type Reviewed = Pick<PullRequestListItem, "url" | "repo" | "number" | "title">;

/** What "Review for me" asks the Orchestrator: a read-only review in a fresh Worktree. */
export function reviewPrompt({ url, repo, number, title }: Reviewed): string {
  return `Review pull request ${url} (${repo}#${number}: ${title}). Check out its head in a fresh Worktree, read the diff in context, and report findings with file, line, severity (high/medium/low) and a suggested fix. Don't push, comment on GitHub, approve or merge.`;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a task's prompt names this PR's URL, and not a longer one that starts with it (#12 inside #123). */
export function mentionsPullRequest(prompt: string, url: string): boolean {
  return Boolean(url) && new RegExp(`${escape(url)}(?![0-9A-Za-z/])`).test(prompt);
}

/** The PR URLs an Orchestrator task is still working on, from the board's cards. */
export function reviewingUrls(cards: readonly { column: string; task: { prompt: string } }[], urls: readonly string[]): Set<string> {
  const running = cards.filter((card) => card.column === "running");
  return new Set(urls.filter((url) => running.some((card) => mentionsPullRequest(card.task.prompt, url))));
}
