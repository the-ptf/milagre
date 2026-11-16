const { createGit } = require("./git/client.cjs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { copyFilesToWorktree } = require("./worktree-files.cjs");
const { branchSlug: slugify, validBranchName, formatPolicyBranch } = require("@milagre/shared/branch-policy");
const { outsideGit } = require("./project-identity.cjs");

const client = createGit();
const git = client.read.checked;

const DEFAULT_WORKTREE_ROOT = path.join(os.homedir(), ".milagre", "worktrees");

// The commit a new worktree starts from. A local branch that only trails its upstream (a `main` behind
// `origin/main`) starts from the freshly fetched upstream; one with commits of its own, one without an
// upstream, or one whose remote can't be reached starts from itself. `fetched` says the upstream was just fetched
async function resolveStartRef(projectPath, baseBranch, { fetched = false } = {}) {
  let upstream = [];
  try {
    const { stdout } = await git(projectPath, [
      "for-each-ref",
      "--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream:short)",
      `refs/heads/${baseBranch}`,
    ]);
    upstream = stdout.trim().split("\0");
  } catch {}
  const [remote, remoteRef, trackingRef] = upstream;
  // "." is an upstream that is itself a local branch: nothing to fetch.
  if (!remote || remote === "." || !remoteRef || !trackingRef) return baseBranch;
  if (!fetched)
    try {
      await client.write.checked(projectPath, ["fetch", "--quiet", remote, `+${remoteRef}:refs/remotes/${trackingRef}`], { profile: "NETWORK" });
    } catch {
      // Offline: the last fetched upstream is still newer than nothing.
    }
  try {
    await git(projectPath, ["merge-base", "--is-ancestor", "--end-of-options", baseBranch, trackingRef]);
    return trackingRef;
  } catch {
    return baseBranch;
  }
}

async function listBranches(projectPath) {
  try {
    const { stdout } = await git(projectPath, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"]);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function checkBase(projectPath, baseBranch) {
  const valid = typeof baseBranch === "string" && baseBranch !== "" && !baseBranch.startsWith("-") && !/[\0\n]/.test(baseBranch);
  if (!valid || !(await client.read.refExists(projectPath, baseBranch)))
    throw new Error(`The base branch ${JSON.stringify(String(baseBranch))} is missing from this project.`);
}

const newSuffix = () => Math.random().toString(36).slice(2, 6);

async function issueBranch({ projectPath, issue, suffix }) {
  let branch = issue.branchName;
  if (!validBranchName(branch)) branch = [issue.key.toLowerCase(), slugify(issue.title)].filter(Boolean).join("-");
  const taken =
    (await client.read.refExists(projectPath, `refs/heads/${branch}`)) || (await client.read.refExists(projectPath, `refs/remotes/origin/${branch}`));
  if (taken) branch = `${branch}-${suffix}`;
  return branch;
}

async function createWorktree({
  projectPath,
  baseBranch,
  prompt = "",
  branch: named,
  root = DEFAULT_WORKTREE_ROOT,
  suffix = newSuffix(),
  copyPatterns,
  copyLimits,
  fetched = false,
  beforeCreate,
  trackBase = false,
  folderSlug,
}) {
  if (await outsideGit(projectPath))
    throw new Error(`${path.basename(projectPath)} has no Git, so its Chats work in the folder itself. Set up Git to give a Chat its own Worktree.`);
  await checkBase(projectPath, baseBranch);
  if (named !== undefined && !validBranchName(named)) throw new Error(`${JSON.stringify(String(named))} is not a valid branch name.`);
  const name = `${folderSlug || (named ? slugify(named.split("/").pop()) : slugify(prompt)) || "chat"}-${suffix}`;
  const branch = named ?? `milagre/${name}`;
  const worktreePath = path.join(root, path.basename(projectPath), name);
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  const start = await resolveStartRef(projectPath, baseBranch, { fetched });
  beforeCreate?.();
  await client.write.checked(projectPath, ["worktree", "add", trackBase ? "--track" : "--no-track", "-b", branch, "--end-of-options", worktreePath, start]);
  const copy = await copyFilesToWorktree({ projectPath, worktreePath, setting: copyPatterns, limits: copyLimits });
  return { branch, path: worktreePath, base: start, ...(copy.copied.length || copy.notes.length ? { copy } : {}) };
}

async function renameWorktreeBranch({ worktreePath, branch, slug, policy, suffix: originalSuffix, ticket = "" }) {
  const suffix = originalSuffix ?? branch.match(/-([a-z0-9]+)$/)?.[1];
  const name = slugify(slug);
  if (!suffix || !name) return null;
  const renamed = policy ? formatPolicyBranch(policy, { slug: name, ticket, suffix }) : `milagre/${name}-${suffix}`;
  if (renamed === branch) return null;
  try {
    if (await branchPushed(worktreePath, branch)) return null;
    if (await client.read.refExists(worktreePath, `refs/remotes/origin/${renamed}`)) return null;
    await client.write.checked(worktreePath, ["branch", "-m", branch, renamed]);
    return renamed;
  } catch {
    return null;
  }
}

// Whether a branch has been pushed: an upstream is set, or a copy of it exists on origin. Renaming such a branch
async function branchPushed(worktreePath, branch) {
  const upstream = await client.read.checked(worktreePath, ["rev-parse", "--abbrev-ref", "--quiet", `${branch}@{u}`]).then(
    () => true,
    () => false,
  );
  return upstream || (await client.read.refExists(worktreePath, `refs/remotes/origin/${branch}`));
}

async function moveWorktreeBranch({ worktreePath, from, to }) {
  await client.write.checked(worktreePath, ["branch", "-m", from, to]);
  return to;
}

module.exports = {
  DEFAULT_WORKTREE_ROOT,
  branchPushed,
  createWorktree,
  issueBranch,
  listBranches,
  moveWorktreeBranch,
  newSuffix,
  renameWorktreeBranch,
  slugify,
};
