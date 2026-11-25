const fs = require("node:fs/promises");
const path = require("node:path");
const jsonc = require("jsonc-parser");
const { SKIP, scanRepositories } = require("./project-finder.cjs");

const MAX_CHILDREN = 200;
const NESTED_DEPTH = 2;

async function hasGit(folder) {
  try {
    await fs.stat(path.join(folder, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function workspaceFolders(root, entries, readFile) {
  const file = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".code-workspace"))
    .map((entry) => entry.name)
    .toSorted()[0];
  if (!file) return null;
  const parsed = jsonc.parse(await readFile(path.join(root, file), "utf8").catch(() => ""), [], { allowTrailingComma: true });
  const folders = Array.isArray(parsed?.folders) ? parsed.folders : [];
  const paths = folders.filter((entry) => typeof entry?.path === "string").map((entry) => path.resolve(root, entry.path));
  const real = await Promise.all(paths.map((folder) => fs.realpath(folder).catch(() => null)));
  return { name: path.basename(file, ".code-workspace"), folders: real.filter((folder) => folder && folder !== root) };
}

/**
 * @param {string} folder
 * @returns {Promise<Omit<import("@milagre/shared/project-list").FolderScan, "detect">>}
 */
async function scanFolder(folder, { readdir = fs.readdir, readFile = fs.readFile } = {}) {
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
  const workspace = await workspaceFolders(root, entries, readFile);
  const inside = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIP.has(entry.name))
    .map((entry) => path.join(root, entry.name))
    .toSorted((a, b) => a.localeCompare(b));
  const folders = [...new Set([...inside, ...(workspace?.folders ?? [])])];
  for (const child of folders) {
    if (found.length >= MAX_CHILDREN) break;
    if (found.some((item) => item.path === child)) continue;
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
    name: workspace?.name || path.basename(root),
    ...(workspace ? { workspace: true } : {}),
    git: await hasGit(root),
    children: found
      .slice(0, MAX_CHILDREN)
      .map((child) => ({ path: child.path, name: path.basename(child.path), relative: path.relative(root, child.path), git: child.git, chosen: child.git })),
  };
}

module.exports = { MAX_CHILDREN, scanFolder };
