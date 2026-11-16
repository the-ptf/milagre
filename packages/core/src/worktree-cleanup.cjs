const { createGit, callbackExec, LIMITS } = require("./git/client.cjs");
const fs = require("node:fs/promises");
const path = require("node:path");
const defaultClient = createGit();
const { text: git, commitOf } = defaultClient.read;

const GIT_TIMEOUT_MS = LIMITS.READ.timeout;
const REMOVE_TIMEOUT_MS = LIMITS.REMOVE.timeout;

const { WORKTREE_CHANGED: CHANGED_AFTER_CHECK } = require("@milagre/shared/git-codes").GIT_CODES;

/**
 * What archiving a chat would lose from its worktree. `uncommitted` counts `git status` entries (untracked
 * included, ignored files such as a copied .env not); `unpushed` counts commits on neither the branch's
 * upstream nor `base` (just `base` when there is no upstream). On a detached HEAD it counts the commits no
 * branch, remote or `base` reaches, and the worktree is never removable by the safe path. `head` is the
 * commit it is at. Throws when git can't tell.
 */
async function worktreeStatus(worktreePath, base) {
  const porcelain = await git(worktreePath, ["status", "--porcelain", "--untracked-files=all"]);
  const uncommitted = porcelain.split("\n").filter(Boolean).length;
  const head = await commitOf(worktreePath, "HEAD");
  if (!head) throw new Error("This worktree has no commits to check.");
  const name = (await git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  const branch = name === "HEAD" ? null : name;
  const baseCommit = base ? await commitOf(worktreePath, base) : null;
  if (!baseCommit) throw new Error("This worktree's base can't be found, so its commits can't be checked.");
  const reach = [baseCommit];
  let unpushed;
  if (branch) {
    const upstream = await commitOf(worktreePath, "@{upstream}");
    if (upstream) reach.push(upstream);
    unpushed = Number((await git(worktreePath, ["rev-list", "--count", head, "--not", ...reach, "--"])).trim());
  } else {
    unpushed = Number((await git(worktreePath, ["rev-list", "--count", head, "--not", "--branches", "--remotes", ...reach, "--"])).trim());
  }
  return { uncommitted, unpushed, branch, head, removable: branch !== null && uncommitted === 0 && unpushed === 0 };
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

const sameStatus = (now, seen) => Boolean(seen) && now.head === seen.head && now.uncommitted <= seen.uncommitted && now.unpushed <= seen.unpushed;

async function removeWorktree({ path: worktreePath, root, projectPath, base, seen, force = false, closeSession, exec }) {
  const client = exec ? createGit({ execFile: callbackExec(exec) }) : defaultClient;
  const g = client.read.text;
  const realRoot = await fs.realpath(root).catch(() => null);
  const real = await fs.realpath(worktreePath);
  if (!realRoot || !isInside(realRoot, real)) throw new Error(`${worktreePath} is outside Milagre's worktree folder.`);
  const listing = await client.worktreeList(real);
  const main = listing[0]?.path;
  if (!main) throw new Error(`${worktreePath} is not a git worktree.`);
  const realMain = await fs.realpath(main);
  if (realMain === real) throw new Error(`${worktreePath} is the main checkout.`);
  const top = (await g(real, ["rev-parse", "--show-toplevel"])).trim();
  if ((await fs.realpath(top)) !== real) throw new Error(`${worktreePath} is not the top of a worktree.`);
  if (!projectPath) throw new Error("No project was given, so the worktree is kept.");
  const realProject = await fs.realpath(projectPath);
  if (realProject === real) throw new Error(`${worktreePath} is the project folder.`);
  if ((await client.commonDir(real)) !== (await client.commonDir(realProject))) throw new Error(`${worktreePath} belongs to another repository.`);

  await closeSession?.();
  const now = await worktreeStatus(real, base);
  if (force ? !sameStatus(now, seen) : !now.removable) throw new Error(`${CHANGED_AFTER_CHECK}: ${worktreePath} changed after it was checked.`);

  await client.write.checked(realMain, ["worktree", "remove", ...(force ? ["--force"] : []), real], { profile: "REMOVE" });

  let branchDeleted = false;
  if (now.branch?.startsWith("milagre/")) {
    try {
      await client.write.checked(realMain, ["branch", force ? "-D" : "-d", now.branch], { profile: "REMOVE" });
      branchDeleted = true;
    } catch {}
  }
  return { removed: true, branch: now.branch, branchDeleted };
}

module.exports = { CHANGED_AFTER_CHECK, GIT_TIMEOUT_MS, REMOVE_TIMEOUT_MS, removeWorktree, worktreeStatus };
