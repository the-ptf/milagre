const fs = require("node:fs/promises");
const path = require("node:path");
const { SKIP, scanRepositories } = require("./project-finder.cjs");
const { resolveProject } = require("./project-identity.cjs");

// A Parent Project is a folder (usually outside Git) whose Sub-projects are the repositories and folders inside it. It is
// a Project of its own, on the recent list like any other; its Sub-projects are kept in project-settings.json under it
// and listed right after it (withSubprojects), so they never count against the recent list's length. createProjectTree
// is the one owner of that relation: the runtime asks it, and never reads the settings' subprojects itself.

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

async function isFolder(folder) {
  try {
    return (await fs.stat(folder)).isDirectory();
  } catch {
    return false;
  }
}

// A folder by its real path, as a Project opens under it (one reached through a symlink, /tmp on macOS, by its target).
const realFolder = (folder) => fs.realpath(path.resolve(folder)).catch(() => path.resolve(folder));

/**
 * What a folder could hold as Sub-projects: each repository directly in it, each repository a level or two down in a
 * child folder that isn't one, and each other child folder (which opens outside Git). Hidden, system and dependency
 * folders are skipped. Only names are read; nothing runs inside a repository. `chosen` lists the Sub-projects the
 * folder has already: those start checked, and one the scan no longer finds is offered too. With none, every
 * repository starts checked and plain folders don't.
 * @param {string} folder
 * @param {{ chosen?: string[], readdir?: typeof fs.readdir }} [options]
 * @returns {Promise<import("@milagre/shared/project-list").SubprojectScan>}
 */
async function scanSubprojects(folder, { chosen = [], readdir = fs.readdir } = {}) {
  if (typeof folder !== "string" || !path.isAbsolute(folder)) throw new Error("An absolute folder path is required");
  const root = await realFolder(folder);
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
  const offered = [
    ...found.slice(0, MAX_CHILDREN),
    ...chosen.filter((child) => !found.some((item) => item.path === child)).map((child) => ({ path: child, git: true })),
  ];
  const checked = (child) => (chosen.length ? chosen.includes(child.path) : child.git);
  return {
    folder: root,
    git: await hasGit(root),
    children: offered.map((child) => ({
      path: child.path,
      name: path.basename(child.path),
      relative: path.relative(root, child.path),
      git: child.git,
      chosen: checked(child),
    })),
  };
}

/**
 * A chosen list of Sub-projects made safe to save: real absolute folders inside the parent (never the parent itself),
 * each once, in the order given.
 */
async function cleanSubprojects(parent, paths) {
  if (!Array.isArray(paths)) throw new Error("Choose the Sub-projects as a list of folders.");
  if (paths.some((value) => typeof value !== "string" || !path.isAbsolute(value))) throw new Error("Each Sub-project must be an absolute folder path.");
  const root = path.resolve(parent);
  const kept = [];
  for (const child of await Promise.all(paths.map(realFolder))) {
    const relative = path.relative(root, child);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("A Sub-project must be a folder inside its Parent Project.");
    if (!kept.includes(child)) kept.push(child);
  }
  if (kept.length > MAX_CHILDREN) throw new Error(`A Parent Project holds at most ${MAX_CHILDREN} Sub-projects.`);
  return kept;
}

/**
 * The recent list with each Parent Project's Sub-projects right after it, each carrying `parent`. A Sub-project that is
 * also recent on its own shows under its parent only. A Sub-project whose folder went away is left out.
 * @param {{ path: string, name: string, openedAt: string }[]} recent
 * @param {Map<string, string[]>} subprojects parent path to its Sub-project paths
 */
async function withSubprojects(recent, subprojects, { exists = isFolder } = {}) {
  const listedParents = recent.filter((entry) => subprojects.get(entry.path)?.length);
  if (!listedParents.length) return recent;
  // One level only: a listed Parent Project stays at the top even when another lists it as a Sub-project.
  const parentPaths = new Set(listedParents.map((entry) => entry.path));
  const nested = new Set(listedParents.flatMap((entry) => subprojects.get(entry.path)).filter((child) => !parentPaths.has(child)));
  const present = new Map(await Promise.all([...nested].map(async (child) => [child, await exists(child)])));
  const out = [];
  const seen = new Set();
  for (const entry of recent) {
    // Shown under its parent, which may come later in the list.
    if (seen.has(entry.path) || nested.has(entry.path)) continue;
    seen.add(entry.path);
    out.push(entry);
    if (!parentPaths.has(entry.path)) continue;
    for (const child of subprojects.get(entry.path)) {
      if (seen.has(child) || !nested.has(child) || !present.get(child)) continue;
      seen.add(child);
      out.push({ path: child, name: path.basename(child), openedAt: entry.openedAt, parent: entry.path });
    }
  }
  return out;
}

/**
 * The Parent/Sub-project relation, kept in the project settings. `open` opens a Sub-project in the background (so it is
 * registered for the canvas and Links, and its Chats can be read); `assertRegistrable` refuses Milagre's own folders.
 */
function createProjectTree({ settings, open, assertRegistrable, remember }) {
  async function parentOf(projectPath) {
    for (const [parent, children] of await settings.subprojects()) if (children.includes(projectPath)) return parent;
    return null;
  }
  return {
    parentOf,
    /**
     * Each Project of a family (a Parent Project and its Sub-projects) to the others in it, by path: a Chat in one reads,
     * starts Chats in and delegates to the others' Worktrees without a Link.
     */
    async families() {
      const map = new Map();
      for (const [parent, children] of await settings.subprojects()) {
        const members = [parent, ...children];
        for (const member of members) map.set(member, [...new Set([...(map.get(member) ?? []), ...members.filter((other) => other !== member)])]);
      }
      return map;
    },
    /** Every Sub-project's Parent Project, by path. */
    async parents() {
      const map = new Map();
      for (const [parent, children] of await settings.subprojects()) for (const child of children) map.set(child, parent);
      return map;
    },
    /** The recent list with every Sub-project after its parent (withSubprojects). */
    list: async (recent) => withSubprojects(recent, await settings.subprojects()),
    /** project:scan-children: a folder's candidates, its current Sub-projects checked, and whether detection is on. */
    async scan(folder) {
      const root = await realFolder(folder);
      const [subprojects, { detectSubprojects }] = await Promise.all([settings.subprojects(), settings.getDetectSubprojects()]);
      return { ...(await scanSubprojects(root, { chosen: subprojects.get(root) ?? [] })), detect: detectSubprojects };
    },
    /**
     * Makes `parent` the Parent Project of the folders chosen inside it (an empty list makes it ordinary again). Every
     * folder is checked and resolved before anything changes: a folder inside a repository stands for that repository's
     * top folder, and one that is a Parent Project or another's Sub-project already is refused. They then open together,
     * and the list is saved once. A Sub-project left unchecked goes back on the recent list as a Project of its own.
     */
    async set(parent, paths) {
      if (await parentOf(parent)) throw new Error("A Sub-project can't hold Sub-projects of its own.");
      const chosen = await cleanSubprojects(parent, paths);
      chosen.forEach(assertRegistrable);
      const tops = await Promise.all(chosen.map(async (child) => (await resolveProject(child)).path));
      const kept = await cleanSubprojects(
        parent,
        tops.filter((top) => top !== parent),
      );
      const current = await settings.subprojects();
      for (const child of kept) {
        if (current.get(child)?.length) throw new Error(`${path.basename(child)} is a Parent Project already.`);
        const owner = [...current].find(([other, children]) => other !== parent && children.includes(child))?.[0];
        if (owner) throw new Error(`${path.basename(child)} is a Sub-project of ${path.basename(owner)} already.`);
      }
      await Promise.all(kept.map(open));
      await settings.setSubprojects(parent, kept);
      for (const dropped of (current.get(parent) ?? []).filter((child) => !kept.includes(child))) await remember(dropped);
    },
    /** A Project leaving the list: a Sub-project leaves its parent's list, and a Parent Project's Sub-projects go with it. */
    async remove(projectPath) {
      const current = await settings.subprojects();
      if (current.has(projectPath)) await settings.setSubprojects(projectPath, []);
      const parent = [...current].find(([, children]) => children.includes(projectPath))?.[0];
      if (parent)
        await settings.setSubprojects(
          parent,
          current.get(parent).filter((child) => child !== projectPath),
        );
    },
  };
}

module.exports = { MAX_CHILDREN, cleanSubprojects, createProjectTree, scanSubprojects, withSubprojects };
