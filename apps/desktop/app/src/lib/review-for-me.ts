import { mentionsPullRequestUrl as mentionsPullRequest } from "@milagre/shared/pr-review";
export { reviewForMePrompt as reviewPrompt, mentionsPullRequestUrl as mentionsPullRequest } from "@milagre/shared/pr-review";

/** The PR URLs an Orchestrator task is still working on, from the board's cards. */
export function reviewingUrls(cards: readonly { column: string; task: { prompt: string } }[], urls: readonly string[]): Set<string> {
  const running = cards.filter((card) => card.column === "running");
  return new Set(urls.filter((url) => running.some((card) => mentionsPullRequest(card.task.prompt, url))));
}
