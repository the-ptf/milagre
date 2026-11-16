const { createGit, GitError } = require("./git/client.cjs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { isFolderChatsHome, folderChatWorktrees } = require("./chats-home-folders.cjs");
const client = createGit().read;

const listedWorktrees = (cwd) => client.worktreeList(cwd);

async function isDirectory(folder) {
  try {
    return (await fs.stat(folder)).isDirectory();
  } catch {
    return false;
  }
}

async function outsideGit(folder) {
  const result = await client.run(folder, ["rev-parse", "--show-toplevel"]);
  return isPlainResult(folder, result);
}

async function isPlainResult(folder, result) {
  if (result.ok) return false;
  if (!result.missing) return result.code === 128 && /not a git repository/i.test(result.stderr);
  for (let current = path.resolve(folder); ; current = path.dirname(current)) {
    try {
      await fs.lstat(path.join(current, ".git"));
      return false;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
    if (path.dirname(current) === current) return true;
  }
}

async function activeWorktrees(projectPath) {
  if (await isFolderChatsHome(projectPath)) return folderChatWorktrees(projectPath);
  if (await outsideGit(projectPath)) return (await isDirectory(projectPath)) ? [{ path: projectPath, name: path.basename(projectPath), plain: true }] : [];
  return present(await listedWorktrees(projectPath));
}

async function present(listed) {
  const found = await Promise.all(listed.map((worktree) => isDirectory(worktree.path)));
  return listed.filter((_worktree, index) => found[index]);
}

async function mainCheckoutWorktrees(projectPath) {
  const listed = await listedWorktrees(projectPath).catch(() => null);
  const main = listed?.[0]?.path;
  if (!main || (await fs.realpath(main).catch(() => null)) !== projectPath) return null;
  return present(listed);
}

// `git worktree list` is the main checkout, where Milagre keeps the Project's coordination state.
// `listed`: what `git worktree list` gave on the way (null outside Git).
async function identify(openedPath) {
  if (typeof openedPath !== "string" || !path.isAbsolute(openedPath)) throw new Error("Choose a folder.");
  const opened = await fs.realpath(openedPath);
  if (!(await isDirectory(opened))) throw new Error(`${path.basename(opened)} isn't a folder.`);
  if (await isFolderChatsHome(opened))
    return { identity: { id: opened, path: opened, name: path.basename(opened), git: false }, listed: await folderChatWorktrees(opened) };
  const toplevel = await client.run(opened, ["rev-parse", "--show-toplevel"]);
  if (!toplevel.ok) {
    if (await isPlainResult(opened, toplevel)) {
      if (opened === path.parse(opened).root) throw new Error("Choose a folder, not the whole disk.");
      return { identity: { id: opened, path: opened, name: path.basename(opened), git: false }, listed: null };
    }
    throw new GitError(toplevel);
  }
  const top = await fs.realpath(toplevel.stdout.trim());
  const commonDir = await client.commonDir(top);
  const listed = await listedWorktrees(top);
  const main = listed[0]?.path;
  if (!main || !(await isDirectory(main))) throw new Error("The Project's main checkout is missing.");
  const projectPath = await fs.realpath(main);
  return { identity: { id: commonDir, path: projectPath, name: path.basename(projectPath), git: true }, listed };
}

async function resolveProject(openedPath) {
  return (await identify(openedPath)).identity;
}

/**
 * resolveProject's identity, and the Worktrees activeWorktrees would read from the same `git worktree list` (it lists
 * every checkout of the repository from any of them): an open needs both, and the list is its slowest Git call.
 */
async function inspectProject(openedPath) {
  const { identity, listed } = await identify(openedPath);
  return { identity, worktrees: listed ? await present(listed) : [{ path: identity.path, name: identity.name, plain: true }] };
}

module.exports = { activeWorktrees, inspectProject, mainCheckoutWorktrees, outsideGit, resolveProject };
