export const PR_ACTIONS = {
  conflicts: { label: "Resolve conflicts", sentence: "Resolve the conflicts on pull request", skill: "milagre-resolve-conflicts" },
  "changes-requested": { label: "Address review", sentence: "Address the review on pull request", skill: "milagre-address-review" },
  "checks-failed": { label: "Fix CI", sentence: "Fix CI on pull request", skill: "milagre-fix-ci" },
  behind: { label: "Update branch", sentence: "Update the branch of pull request", skill: "milagre-update-branch" },
};

// Any https host, so GitHub Enterprise works; the path must end at the pull request itself.
const PULL_REQUEST_URL = /^https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/(\d+)$/;

/** A renderer's PR action, checked: null unless the action is known and the URL is that pull request's. */
export function pullRequestActionContext(request) {
  if (!request || typeof request !== "object") return null;
  const { action, pr, url } = request;
  if (typeof action !== "string" || !Object.hasOwn(PR_ACTIONS, action)) return null;
  if (!Number.isSafeInteger(pr) || pr <= 0 || typeof url !== "string") return null;
  const match = PULL_REQUEST_URL.exec(url);
  if (!match || Number(match[1]) !== pr) return null;
  return { kind: "pr-action", action, pr, url };
}

export function pullRequestActionBody(context) {
  return `${PR_ACTIONS[context.action].sentence} #${context.pr}`;
}

export function pullRequestActionPrompt(context) {
  return `${pullRequestActionBody(context)} (${context.url}). /${PR_ACTIONS[context.action].skill}`;
}

export function isPullRequestAction(context) {
  return typeof context === "object" && context !== null && context.kind === "pr-action";
}
