const { createGit } = require("./git/client.cjs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { copyFilesToWorktree } = require("./worktree-files.cjs");
const { outsideGit } = require("./project-identity.cjs");

const client = createGit();
const git = client.read.checked;

// Worktrees live outside the project so they never show up as untracked files in it.
const DEFAULT_WORKTREE_ROOT = path.join(os.homedir(), ".milagre", "worktrees");

// The commit a new worktree starts from. A local branch that only trails its upstream (a `main` behind
// `origin/main`) starts from the freshly fetched upstream; one with commits of its own, one without an
// upstream, or one whose remote can't be reached starts from itself. `fetched` says the upstream was just fetched
// (a main branch sync ran), so the Worktree doesn't wait on the network a second time.
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

function slugify(text) {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 5)
    .join("-")
    .slice(0, 40)
    .replace(/-+$/, "");
}

// The base comes from a client (a phone, a window): it must name an existing commit and can never be read as an option.
async function checkBase(projectPath, baseBranch) {
  const valid = typeof baseBranch === "string" && baseBranch !== "" && !baseBranch.startsWith("-") && !/[\0\n]/.test(baseBranch);
  if (!valid || !(await client.read.refExists(projectPath, baseBranch)))
    throw new Error(`The base branch ${JSON.stringify(String(baseBranch))} is missing from this project.`);
}

const newSuffix = () => Math.random().toString(36).slice(2, 6);

// The rules `git check-ref-format --branch` applies, mirrored here because the read surface of the git client doesn't
// allow that command. A name starting with "-" can never be read as an option; git refuses the rest on `worktree add`.
function validBranchName(branch) {
  if (typeof branch !== "string" || branch === "" || branch.startsWith("-") || branch === "@" || branch.includes("@{")) return false;
  if (branch === "HEAD" || branch.startsWith("refs/")) return false;
  if ([...branch].some((char) => char.charCodeAt(0) < 0x21 || char.charCodeAt(0) === 0x7f || " ~^:?*[\\".includes(char))) return false;
  if (branch.includes("..")) return false;
  if (branch.startsWith("/") || branch.endsWith("/") || branch.endsWith(".") || branch.includes("//")) return false;
  return branch.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

// The branch a worktree started from a Linear issue gets: the issue's own branch name, or its key and title when git
// refuses that, plus the suffix when the name is already a branch. The caller gives the same suffix to the folder.
async function issueBranch({ projectPath, issue, suffix }) {
  let branch = issue.branchName;
  if (!validBranchName(branch)) branch = [issue.key.toLowerCase(), slugify(issue.title)].filter(Boolean).join("-");
  // A teammate's remote-tracking branch counts as taken too: a local copy of it would shadow their work.
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
}) {
  if (await outsideGit(projectPath))
    throw new Error(`${path.basename(projectPath)} has no Git, so its Chats work in the folder itself. Set up Git to give a Chat its own Worktree.`);
  await checkBase(projectPath, baseBranch);
  // A named branch (from issueBranch) keeps its name; its folder takes the last segment of that name.
  if (named !== undefined && !validBranchName(named)) throw new Error(`${JSON.stringify(String(named))} is not a valid branch name.`);
  const name = named ? `${slugify(named.split("/").pop()) || "chat"}-${suffix}` : `${slugify(prompt) || "chat"}-${suffix}`;
  const branch = named ?? `milagre/${name}`;
  const worktreePath = path.join(root, path.basename(projectPath), name);
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });
  const start = await resolveStartRef(projectPath, baseBranch, { fetched });
  beforeCreate?.();
  // --no-track: the chat's branch must not push to, or pull from, the branch it started on.
  await client.write.checked(projectPath, ["worktree", "add", "--no-track", "-b", branch, "--end-of-options", worktreePath, start]);
  // Ignored files the project needs (env files) come along; a failed copy never fails the worktree.
  const copy = await copyFilesToWorktree({ projectPath, worktreePath, setting: copyPatterns, limits: copyLimits });
  // `base` is what the chat's changes are measured against (see diffstat.cjs).
  return { branch, path: worktreePath, base: start, ...(copy.copied.length || copy.notes.length ? { copy } : {}) };
}

// Gives a chat's branch the name picked for it once the chat is already running (see worktree-name.cjs).
// The folder keeps its first name: moving it would pull it out from under the agent. Resolves to the new
// branch, or null when there is nothing to rename or git refuses (the branch is gone, or the name is taken).
async function renameWorktreeBranch({ worktreePath, branch, slug }) {
  const suffix = branch.match(/-([a-z0-9]+)$/)?.[1];
  const name = slugify(slug);
  if (!suffix || !name) return null;
  const renamed = `milagre/${name}-${suffix}`;
  if (renamed === branch) return null;
  try {
    await client.write.checked(worktreePath, ["branch", "-m", branch, renamed]);
    return renamed;
  } catch {
    return null;
  }
}

// Whether a branch has been pushed: an upstream is set, or a copy of it exists on origin. Renaming such a branch
// would split it from its remote, so the caller leaves it alone.
async function branchPushed(worktreePath, branch) {
  const upstream = await client.read.checked(worktreePath, ["rev-parse", "--abbrev-ref", "--quiet", `${branch}@{u}`]).then(
    () => true,
    () => false,
  );
  return upstream || (await client.read.refExists(worktreePath, `refs/remotes/origin/${branch}`));
}

// Gives a worktree's branch an explicit name, e.g. the branch a Linear issue names (see issueBranch). The folder keeps
// its name. Git's refusal (the branch moved, or the name is taken) throws.
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
