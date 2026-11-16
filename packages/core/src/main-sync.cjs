const fs = require("node:fs/promises");
const path = require("node:path");
const { createGit } = require("./git/client.cjs");

const IN_PROGRESS = [
  ["MERGE_HEAD", "merge"],
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["BISECT_LOG", "bisect"],
];

const short = (commit) => commit.slice(0, 7);
const firstLine = (text) =>
  String(text ?? "")
    .trim()
    .split("\n")[0]
    .replace(/^(error|fatal): /, "");

function fetchFailure(remote, result) {
  if (/permission denied|authentication failed|could not read username|terminal prompts disabled/i.test(result.message)) return firstLine(result.message);
  if (
    result.timedOut ||
    /could not resolve host|could not read from remote|unable to access|connection|does not appear to be a git repository/i.test(result.message)
  )
    return `Could not reach ${remote}`;
  return firstLine(result.message) || `Could not fetch from ${remote}`;
}

async function operationInProgress(client, checkout) {
  const gitDir = await client.read.out(checkout, ["rev-parse", "--absolute-git-dir"]);
  if (!gitDir) return null;
  for (const [file, name] of IN_PROGRESS) {
    if (
      await fs.access(path.join(gitDir, file)).then(
        () => true,
        () => false,
      )
    )
      return name;
  }
  return null;
}

async function syncMainBranch(projectPath, { branch: sourceBranch, client = createGit(), now = Date.now } = {}) {
  let branch = "main";
  const result = (outcome, extra = {}) => ({ at: now(), outcome, branch, ...extra });
  try {
    branch = sourceBranch ?? (await client.read.resolveBase(projectPath)).name;
    if (typeof branch !== "string" || !branch || branch.startsWith("-") || /[\0\n*?[~^:]/.test(branch))
      return result("skipped", { message: "No local source branch" });
    const local = `refs/heads/${branch}`;
    const before = await client.read.commitOf(projectPath, local);
    if (!before) return result("skipped", { message: `No local ${branch} branch` });
    const upstream = await client.read.out(projectPath, ["for-each-ref", "--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream:short)", local]);
    const [remote, remoteRef, tracking] = (upstream ?? "").split("\0");
    // "." is an upstream that is itself a local branch: there is no remote to follow.
    if (!remote || remote === "." || !remoteRef || !tracking) return result("skipped", { message: `${branch} has no remote branch` });
    const fetched = await client.write.run(projectPath, ["fetch", "--quiet", remote, `+${remoteRef}:refs/remotes/${tracking}`], { profile: "NETWORK" });
    if (!fetched.ok) return result("failed", { message: fetchFailure(remote, fetched) });
    const after = await client.read.commitOf(projectPath, `refs/remotes/${tracking}`);
    if (!after) return result("failed", { message: `Could not read ${tracking}` });
    if (after === before) return result("up-to-date", { commit: short(before) });
    const behind = await client.read.run(projectPath, ["merge-base", "--is-ancestor", "--end-of-options", before, after]);
    if (!behind.ok) return result("skipped", { message: `${branch} has commits that aren't on ${remote}`, commit: short(before) });

    const checkout = await client.read.out(projectPath, ["for-each-ref", "--format=%(worktreepath)", local]);
    if (checkout === null) return result("failed", { message: `Could not tell where ${branch} is checked out`, commit: short(before) });
    if (!checkout) {
      const moved = await client.write.run(projectPath, ["fetch", "--quiet", ".", `refs/remotes/${tracking}:${local}`]);
      if (moved.ok) return result("updated", { commit: short(after) });
      const message = /refusing to fetch into/i.test(moved.message) ? `${branch} is in the middle of a rebase or bisect` : `${branch} moved during sync`;
      return result("skipped", { message, commit: short(before) });
    }
    const realOf = (folder) => fs.realpath(folder).catch(() => path.resolve(folder));
    const where = (await realOf(checkout)) === (await realOf(projectPath)) ? "The main checkout" : path.basename(checkout);
    if (
      !(await fs.access(checkout).then(
        () => true,
        () => false,
      ))
    )
      return result("skipped", { message: `${where} is missing. Run git worktree prune to forget it`, commit: short(before) });
    const busy = await operationInProgress(client, checkout);
    if (busy) return result("skipped", { message: `${where} is in the middle of a ${busy}`, commit: short(before) });
    const status = await client.read.run(checkout, ["status", "--porcelain=v1", "--untracked-files=no"]);
    if (!status.ok) return result("failed", { message: firstLine(status.message) || `Could not read ${where}` });
    if (status.stdout.trim()) {
      const message = where === "The main checkout" ? "The main checkout has uncommitted changes" : `${where} has uncommitted changes on ${branch}`;
      return result("skipped", { message, commit: short(before) });
    }
    const head = await client.read.out(checkout, ["symbolic-ref", "--quiet", "HEAD"]);
    if (head !== local) return result("skipped", { message: `${where} is no longer on ${branch}`, commit: short(before) });
    const merged = await client.write.run(checkout, ["merge", "--ff-only", "--quiet", after]);
    if (!merged.ok) return result("skipped", { message: firstLine(merged.message) || `Could not fast-forward ${branch}`, commit: short(before) });
    return result("updated", { commit: short(after) });
  } catch (error) {
    return result("failed", { message: firstLine(error?.message) || "Sync failed" });
  }
}

module.exports = { syncMainBranch };
