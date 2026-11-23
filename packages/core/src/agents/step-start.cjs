const { mergesCheckedOutBranch } = require("@milagre/shared/chats");
const { createGit } = require("../git/client.cjs");

/** The branch checked out in a folder, or null. */
const checkedOutBranch = (cwd) =>
  createGit()
    .read.out(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    .catch(() => null);

/**
 * A step as the host keeps it when it starts: a shell or setup command also as its input (when short enough to show),
 * and a `gh pr merge` of the checked-out branch with that branch's name in `folder` now, before --delete-branch switches
 * away, so the Chat keeps the PR it merged (pullRequestRefs reads `branch` on the saved step).
 * @param {import("@milagre/shared/model").ChatStep} step
 * @param {{ startedAt: number; folder?: string; readBranch?: (cwd: string) => Promise<string | null> }} options
 */
async function startedStep(step, { startedAt, folder, readBranch = checkedOutBranch }) {
  const shell = ["shell", "setup"].includes(step.kind) && step.detail?.startsWith("$ ") && step.detail.endsWith("\n");
  const command = shell ? step.detail.slice(2, -1) : undefined;
  const input = command && command.length <= 4000 ? command : step.input;
  const branch = command && folder && mergesCheckedOutBranch(command) ? await readBranch(folder) : null;
  return { ...step, ...(input ? { input } : {}), ...(branch ? { branch } : {}), startedAt };
}

module.exports = { startedStep, checkedOutBranch };
