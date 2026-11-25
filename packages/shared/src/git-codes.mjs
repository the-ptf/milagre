export const GIT_CODES = Object.freeze({
  NO_ORIGIN: "NO_ORIGIN",
  DETACHED: "DETACHED",
  DETACHED_COMMIT: "DETACHED_COMMIT",
  GH_MISSING: "GH_MISSING",
  WORKTREE_CHANGED: "WORKTREE_CHANGED",
});
const GH_INSTALL = Object.freeze({ darwin: "`brew install gh`", win32: "`winget install --id GitHub.cli`" });
/** How to install the GitHub CLI on `platform`, for a message that names what it's needed for. */
export const ghInstallHint = (platform) => GH_INSTALL[platform] ?? "cli.github.com";
const ghMissing = (platform) => `Install the GitHub CLI (${ghInstallHint(platform)}) to open PRs.`;
export const GIT_MESSAGES = Object.freeze({
  NO_ORIGIN: "This repo has no origin remote.",
  DETACHED: "Check out a branch to push.",
  DETACHED_COMMIT: "Check out a branch to commit.",
  GH_MISSING: ghMissing("darwin"),
  WORKTREE_CHANGED: "It changed after you checked, so the chat and its worktree stay.",
});
/** The message for a code; `platform` is the host's, for the steps that differ by platform (installing gh). */
export const gitMessage = (code, platform) => (code === GIT_CODES.GH_MISSING && platform ? ghMissing(platform) : GIT_MESSAGES[code]);
