const fs = require("node:fs/promises");
const path = require("node:path");
const { gitTopLevel, requireWorktreeRoot } = require("./editors.cjs");
const { outsideGit } = require("./project-identity.cjs");

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
        const current = await read({ strict: true });
        const changed = change(current);
        if (changed === current) return current;
        const entries = changed.slice(0, MAX_RECENT);
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
    add(projectPath) {
      const entry = entryFrom({ path: projectPath, openedAt: now().toISOString() });
      if (!entry) return Promise.reject(new Error("An absolute project path is required"));
      return save((entries) => (entries[0]?.path === entry.path ? entries : [entry, ...entries.filter((item) => item.path !== entry.path)]));
    },
    forget(projectPath) {
      const target = typeof projectPath === "string" && path.isAbsolute(projectPath) ? path.resolve(projectPath) : null;
      return save((entries) => entries.filter((item) => item.path !== target));
    },
  };
}

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

async function plainFolder(folder) {
  try {
    if (typeof folder !== "string" || !path.isAbsolute(folder)) return false;
    const real = await fs.realpath(folder);
    return real !== path.parse(real).root && (await fs.stat(real)).isDirectory() && (await outsideGit(real));
  } catch {
    return false;
  }
}

async function switchTarget(store, requested, { checkRoot = requireWorktreeRoot, plain = plainFolder } = {}) {
  const entry = typeof requested === "string" ? (await store.list()).find((item) => item.path === requested) : undefined;
  if (!entry) throw new Error("That project isn't in the list");
  if (!(await plain(entry.path))) await checkRoot(entry.path);
  return entry.path;
}

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
