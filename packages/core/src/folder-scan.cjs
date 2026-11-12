const fs = require("node:fs/promises");
const path = require("node:path");
const { SKIP, scanRepositories } = require("./project-finder.cjs");

// Add Project's folder check (project:scan-children): the repositories inside a folder that isn't one, which it then adds
// as Projects with a Named Link that groups them. Only folder names are read, as the remote folder picker (fs:list-dirs)
// reads them; nothing runs inside a repository and nothing is saved.

const MAX_CHILDREN = 200;
// How deep under a child folder that isn't a repository the scan looks for repositories (client/api, client/web).
const NESTED_DEPTH = 2;

async function hasGit(folder) {
  try {
    await fs.stat(path.join(folder, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Each repository directly in a folder, each repository a level or two down in a child folder that isn't one, and each
 * other child folder. Hidden, system and dependency folders are skipped. Repositories start checked (`chosen`).
 * @param {string} folder
 * @returns {Promise<Omit<import("@milagre/shared/project-list").FolderScan, "detect">>}
 */
async function scanFolder(folder, { readdir = fs.readdir } = {}) {
  if (typeof folder !== "string" || !path.isAbsolute(folder)) throw new Error("An absolute folder path is required");
  // Real paths, as a Project opens under (a folder reached through a symlink, /tmp on macOS, is listed by its target).
  const root = await fs.realpath(path.resolve(folder)).catch(() => path.resolve(folder));
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    throw new Error("Milagre can't read that folder.");
  }
  const found = [];
  const folders = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIP.has(entry.name))
    .map((entry) => path.join(root, entry.name))
    .toSorted((a, b) => a.localeCompare(b));
  for (const child of folders) {
    if (found.length >= MAX_CHILDREN) break;
    if (await hasGit(child)) {
      found.push({ path: child, git: true });
      continue;
    }
    const nested = await scanRepositories(child, { readdir, maxDepth: NESTED_DEPTH });
    if (nested.length) found.push(...nested.map((repo) => ({ path: repo.path, git: true })).toSorted((a, b) => a.path.localeCompare(b.path)));
    else found.push({ path: child, git: false });
  }
  return {
    folder: root,
    git: await hasGit(root),
    children: found
      .slice(0, MAX_CHILDREN)
      .map((child) => ({ path: child.path, name: path.basename(child.path), relative: path.relative(root, child.path), git: child.git, chosen: child.git })),
  };
}

module.exports = { MAX_CHILDREN, scanFolder };
