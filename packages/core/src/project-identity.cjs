const { createGit, GitError } = require("./git/client.cjs");
const fs = require("node:fs/promises");
const path = require("node:path");
const client = createGit().read;

const listedWorktrees = (cwd) => client.worktreeList(cwd);

async function isDirectory(folder) {
  try {
    return (await fs.stat(folder)).isDirectory();
  } catch {
    return false;
  }
}

// A folder outside any Git repository is a Project too. It has one Worktree, the folder itself, so its Chats work
// there directly. Any other Git failure stays a failure: a broken repository is not a plain folder.
async function outsideGit(folder) {
  const result = await client.run(folder, ["rev-parse", "--show-toplevel"]);
  return !result.ok && result.code === 128 && /not a git repository/i.test(result.stderr);
}

async function activeWorktrees(projectPath) {
  if (await outsideGit(projectPath)) return (await isDirectory(projectPath)) ? [{ path: projectPath, name: path.basename(projectPath), plain: true }] : [];
  const listed = await listedWorktrees(projectPath);
  const present = await Promise.all(listed.map((worktree) => isDirectory(worktree.path)));
  return listed.filter((_worktree, index) => present[index]);
}

// Git's common directory is shared by the main checkout and all linked worktrees. The first entry in
// `git worktree list` is the main checkout, where Milagre keeps the Project's coordination state.
// A folder outside Git is its own Project, identified by its real path, with `git: false`.
async function resolveProject(openedPath) {
  if (typeof openedPath !== "string" || !path.isAbsolute(openedPath)) throw new Error("Choose a folder.");
  const opened = await fs.realpath(openedPath);
  if (!(await isDirectory(opened))) throw new Error(`${path.basename(opened)} isn't a folder.`);
  const toplevel = await client.run(opened, ["rev-parse", "--show-toplevel"]);
  if (!toplevel.ok) {
    if (toplevel.code === 128 && /not a git repository/i.test(toplevel.stderr)) {
      if (opened === path.parse(opened).root) throw new Error("Choose a folder, not the whole disk.");
      return { id: opened, path: opened, name: path.basename(opened), git: false };
    }
    throw new GitError(toplevel);
  }
  const top = await fs.realpath(toplevel.stdout.trim());
  const commonDir = await client.commonDir(top);
  const main = (await listedWorktrees(top))[0]?.path;
  if (!main || !(await isDirectory(main))) throw new Error("The Project's main checkout is missing.");
  const projectPath = await fs.realpath(main);
  return { id: commonDir, path: projectPath, name: path.basename(projectPath), git: true };
}

module.exports = { activeWorktrees, outsideGit, resolveProject };
