const { isTurnEnd } = require("@milagre/shared/agent-runs");
const { createdPullRequestUrl } = require("@milagre/shared/chats");
const { parsePullRequestUrl } = require("./routines/pull-request-watch.cjs");

/**
 * Babysit PRs: when a Chat's shell step runs `gh pr create` and the switch is on, the Chat gets a `Babysit PR #<n>`
 * Heartbeat (routines.createBabysit). `settings.read()` is the Babysit settings; `routines` has `findPullRequest` and
 * `createBabysit` (routines/runtime-adapter.cjs). observe never throws and returns a promise only for tests to wait on.
 */
function createBabysitWatch({ settings, routines }) {
  // Shell step ids a Chat has started and not completed: step-completed carries no kind (as diff-refresh.cjs does).
  const shellSteps = new Map();

  async function opened(chatId, detail) {
    const url = createdPullRequestUrl(detail);
    const pr = url ? parsePullRequestUrl(url) : null;
    if (!pr) return;
    const current = settings.read();
    if (!current.enabled || routines.findPullRequest(pr.repo, pr.number)) return;
    await routines.createBabysit({ chatId, url, repo: pr.repo, number: pr.number, settings: current });
  }

  return {
    observe(chatId, event) {
      if (event.type === "step-started" && event.step?.kind === "shell") {
        if (!shellSteps.has(chatId)) shellSteps.set(chatId, new Set());
        shellSteps.get(chatId).add(event.step.id);
        return undefined;
      }
      if (isTurnEnd(event)) {
        // A step cut off with its turn never completes; don't keep its id.
        shellSteps.delete(chatId);
        return undefined;
      }
      if (event.type !== "step-completed") return undefined;
      const ids = shellSteps.get(chatId);
      if (!ids?.delete(event.id)) return undefined;
      if (ids.size === 0) shellSteps.delete(chatId);
      if (event.status !== "done" || !/\bgh\s+pr\s+create\b/.test(event.detail ?? "")) return undefined;
      return opened(chatId, event.detail).catch((error) => {
        // Another Run's Heartbeat for the same PR won the race: nothing to say.
        if (!/already being babysat/.test(error.message)) console.warn("[babysit] could not watch the pull request:", error.message);
      });
    },
  };
}

module.exports = { createBabysitWatch };
