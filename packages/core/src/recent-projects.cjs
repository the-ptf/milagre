const fs = require("node:fs/promises");
const path = require("node:path");
const { gitTopLevel, requireWorktreeRoot } = require("./editors.cjs");
const { outsideGit } = require("./project-identity.cjs");

// The projects opened lately, for the project menu: <userData>/recent-projects.json holds a list of
// { path, name, openedAt }, most recent first, at most MAX_RECENT long. A folder that no longer exists is
// left out whenever the list is read. Saves run one at a time and replace the file with a rename, so it is
// always a whole list; damaged JSON reads as an empty list, and the next save replaces it.

const MAX_RECENT = 10;

function entryFrom(value) {
  if (!value || typeof value !== "object" || typeof value.path !== "string" || !path.isAbsolute(value.path)) return null;
  const projectPath = path.resolve(value.path);
  return {
    path: projectPath,
    name: typeof value.name === "string" && value.name ? value.name : path.basename(projectPath),
    openedAt: typeof value.openedAt === "string" ? value.openedAt : "",
  };
}

async function isFolder(folder) {
  try {
    return (await fs.stat(folder)).isDirectory();
  } catch {
    return false;
  }
}

function createRecentProjects(file, { now = () => new Date() } = {}) {
  let queue = Promise.resolve();
  let counter = 0;

  // Only a missing file or damaged JSON reads as empty when saving. Any other failure (permissions, a disk
  // error) must not look like "no projects", or the save would wipe the list.
  async function read({ strict }) {
    let text;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT" || !strict) return [];
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      if (error instanceof SyntaxError) return [];
      throw error;
    }
    if (!Array.isArray(parsed)) return [];
    const seen = new Set();
    const entries = [];
    for (const value of parsed) {
      const entry = entryFrom(value);
      if (!entry || seen.has(entry.path)) continue;
      seen.add(entry.path);
      entries.push(entry);
    }
    const present = await Promise.all(entries.map((entry) => isFolder(entry.path)));
    return entries.filter((_entry, index) => present[index]).slice(0, MAX_RECENT);
  }

  function save(change) {
    const next = queue
      .catch(() => {})
      .then(async () => {
        const entries = change(await read({ strict: true })).slice(0, MAX_RECENT);
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.${++counter}.tmp`;
        try {
          await fs.writeFile(temporary, JSON.stringify(entries, null, 2));
          await fs.rename(temporary, file);
        } catch (error) {
          await fs.rm(temporary, { force: true });
          throw error;
        }
        return entries;
      });
    queue = next;
    return next;
  }

  return {
    list: () => read({ strict: false }),
    /** Puts a project at the top (once), as it opens. */
    add(projectPath) {
      const entry = entryFrom({ path: projectPath, openedAt: now().toISOString() });
      if (!entry) return Promise.reject(new Error("An absolute project path is required"));
      return save((entries) => [entry, ...entries.filter((item) => item.path !== entry.path)]);
    },
    /** Takes a project off the list. Its folder is never touched. */
    forget(projectPath) {
      const target = typeof projectPath === "string" && path.isAbsolute(projectPath) ? path.resolve(projectPath) : null;
      return save((entries) => entries.filter((item) => item.path !== target));
    },
  };
}

// Every way a project opens (the folder dialog, launch, a switch) puts it at the top, under the path project:switch
// will accept: the path it was opened by when that is a checkout's top folder, else the top folder of the checkout
// it sits in (Milagre launched from a subfolder), so leaving it never strands it. A folder outside any checkout still
// opens, it just isn't listed. Resolves to the listed path, or null. A failed save never fails the open.
async function rememberProject(store, projectPath, { topLevel = gitTopLevel, plain = plainFolder } = {}) {
  let listed;
  try {
    if (typeof projectPath !== "string" || !path.isAbsolute(projectPath)) return null;
    const real = await fs.realpath(projectPath);
    if (await plain(real)) listed = projectPath;
    else {
      const top = await fs.realpath(await topLevel(real));
      listed = top === real ? projectPath : top;
    }
  } catch {
    return null;
  }
  try {
    await store.add(listed);
    return listed;
  } catch (error) {
    console.warn("Milagre couldn't save the recent projects list:", error.message);
    return null;
  }
}

// A folder outside any Git repository, other than a disk's root, opens as a Project of its own (see project-identity.cjs).
async function plainFolder(folder) {
  try {
    if (typeof folder !== "string" || !path.isAbsolute(folder)) return false;
    const real = await fs.realpath(folder);
    return real !== path.parse(real).root && (await fs.stat(real)).isDirectory() && (await outsideGit(real));
  } catch {
    return false;
  }
}

// project:switch. The renderer is untrusted input: only a project on the list opens, and only while its real path is
// still the top folder of a git checkout, or a folder outside Git.
async function switchTarget(store, requested, { checkRoot = requireWorktreeRoot, plain = plainFolder } = {}) {
  const entry = typeof requested === "string" ? (await store.list()).find((item) => item.path === requested) : undefined;
  if (!entry) throw new Error("That project isn't in the list");
  if (!(await plain(entry.path))) await checkRoot(entry.path);
  return entry.path;
}

/**
 * The project to open at launch: the folder Milagre was started in when it's inside a git repo (a terminal launch),
 * else the most recent project that still opens (a repo, or a folder outside Git). A Dock, Finder or update relaunch
 * starts in "/", which is neither. With nothing to open, the window shows onboarding.
 */
async function launchProject(store, cwd, { topLevel = gitTopLevel, plain = plainFolder } = {}) {
  if (
    cwd !== "/" &&
    (await topLevel(cwd).then(
      () => true,
      () => false,
    ))
  )
    return cwd;
  for (const entry of await store.list()) {
    if (
      (await topLevel(entry.path).then(
        () => true,
        () => false,
      )) ||
      (await plain(entry.path))
    )
      return entry.path;
  }
  return null;
}

module.exports = { MAX_RECENT, createRecentProjects, launchProject, plainFolder, rememberProject, switchTarget };
