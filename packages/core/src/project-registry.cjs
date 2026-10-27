const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { resolveProject } = require("./project-identity.cjs");
const { createLink, pruneLinks, restoreLink } = require("./project-links.cjs");
const { createProjectGroup, updateProjectGroup, validProjectGroup } = require("./project-groups.cjs");

const DEFAULT_ROOTS = [path.join(os.homedir(), "Developer"), path.join(os.homedir(), ".milagre", "worktrees")];
const SKIP = new Set([".git", "node_modules", ".next", ".cache"]);

async function coordinationProjects(roots) {
  const found = [];
  const pending = [...roots];
  while (pending.length) {
    const directory = pending.pop();
    let children;
    try {
      children = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isDirectory()) continue;
      if (child.name === ".milagre") {
        try {
          if ((await fs.stat(path.join(directory, child.name, "coordination.json"))).isFile()) found.push(directory);
        } catch {}
      } else if (!SKIP.has(child.name) && !child.name.startsWith(".")) {
        pending.push(path.join(directory, child.name));
      }
    }
  }
  return found;
}

async function present(entry) {
  try {
    const identity = await resolveProject(entry.path);
    return identity.id === entry.id && identity.path === entry.path;
  } catch {
    return false;
  }
}

// Whether an entry's folder (its main checkout, or a folder outside Git) or its repository's common Git directory went
// away, found without starting Git: what a list checks between writes, which check every entry with present.
async function gone(entry) {
  const isFolder = (folder) =>
    fs.stat(folder).then(
      (stats) => stats.isDirectory(),
      () => false,
    );
  const [folder, repository] = await Promise.all([
    isFolder(entry.path),
    entry.id === entry.path ||
      fs.stat(entry.id).then(
        () => true,
        () => false,
      ),
  ]);
  return !folder || !repository;
}

function validEntry(entry) {
  return entry && typeof entry.id === "string" && path.isAbsolute(entry.id) && typeof entry.path === "string" && path.isAbsolute(entry.path);
}

function createProjectRegistry(file, { roots = DEFAULT_ROOTS, now = () => new Date() } = {}) {
  let queue = Promise.resolve();
  let counter = 0;

  async function read() {
    let data;
    try {
      data = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return { scanned: false, projects: [], links: [], worktreePositions: {} };
      throw error;
    }
    if (!data || !Array.isArray(data.projects)) return { scanned: false, projects: [], links: [], worktreePositions: {} };
    const seen = new Set();
    const projects = data.projects.filter((entry) => {
      if (!validEntry(entry) || seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    });
    return {
      scanned: data.scanned === true,
      projects,
      links: Array.isArray(data.links) ? data.links : [],
      projectGroups: Array.isArray(data.projectGroups) ? data.projectGroups.filter(validProjectGroup) : [],
      worktreePositions: data.worktreePositions && typeof data.worktreePositions === "object" ? data.worktreePositions : {},
    };
  }

  async function write(data) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${++counter}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(data, null, 2));
      await fs.rename(temporary, file);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  }

  function update(change) {
    const next = queue
      .catch(() => {})
      .then(async () => {
        const previous = await read();
        const projects = (await Promise.all(previous.projects.map(async (entry) => ((await present(entry)) ? { ...entry } : null)))).filter(Boolean);
        const current = { ...previous, projects, worktreePositions: structuredClone(previous.worktreePositions) };
        current.links = current.links.filter(
          (link) => projects.some((project) => project.id === link.a?.project_id) && projects.some((project) => project.id === link.b?.project_id),
        );
        const result = await change(current);
        if (JSON.stringify(result) !== JSON.stringify(previous)) await write(result);
        return result.projects;
      });
    queue = next;
    return next;
  }

  return {
    listProjectGroups: async () => {
      await queue.catch(() => {});
      return (await read()).projectGroups ?? [];
    },
    createProjectGroup: async (request) => {
      let created;
      await update(async (data) => {
        data.projectGroups ??= [];
        created = createProjectGroup(data.projectGroups, data.projects, request, now);
        data.projectGroups = [...data.projectGroups, created];
        return data;
      });
      return created;
    },
    updateProjectGroup: async (request) => {
      let updated;
      await update(async (data) => {
        data.projectGroups ??= [];
        updated = updateProjectGroup(data.projectGroups, data.projects, request);
        data.projectGroups = data.projectGroups.map((group) => (group.id === updated.id ? updated : group));
        return data;
      });
      return updated;
    },
    // The sidebar, the canvas and every Project open ask for it. The first list scans for coordination files (the marker
    // is persisted even if the scan finds nothing), and every write checks each entry with Git (present). Between them a
    // list is the file as it is, unless an entry's folder went away: that list goes through a write, which drops it.
    list: async () => {
      await queue.catch(() => {});
      const data = await read();
      if (data.scanned && !(await Promise.all(data.projects.map(gone))).some(Boolean)) return data.projects;
      return update(async (current) => {
        if (current.scanned) return current;
        for (const folder of await coordinationProjects(roots)) {
          let identity;
          try {
            identity = await resolveProject(folder);
          } catch {
            continue;
          }
          if (!current.projects.some((entry) => entry.id === identity.id)) {
            current.projects.push({ ...identity, position: null, openedAt: now().toISOString() });
          }
        }
        current.scanned = true;
        return current;
      });
    },
    // Every open puts its Project first. One first already, as it was, leaves the file as it is: only its openedAt would
    // change. Any other moves up without checking every entry with Git, which each switch between Projects would pay:
    // an entry whose folder went away is dropped, as a list drops it, and so is the same folder under another identity
    // (a plain folder that became a repository). Every other write checks them all.
    add: (identity) => {
      const next = queue
        .catch(() => {})
        .then(async () => {
          const data = await read();
          const top = data.projects[0];
          if (top && Object.keys(identity).every((key) => top[key] === identity[key])) return data.projects;
          const missing = await Promise.all(data.projects.map(gone));
          const previous = data.projects.find((entry) => entry.id === identity.id);
          const projects = [
            { ...identity, position: previous?.position ?? null, openedAt: now().toISOString() },
            ...data.projects.filter((entry, index) => !missing[index] && entry.id !== identity.id && entry.path !== identity.path),
          ];
          const kept = (id) => projects.some((project) => project.id === id);
          await write({ ...data, projects, links: data.links.filter((link) => kept(link.a?.project_id) && kept(link.b?.project_id)) });
          return projects;
        });
      queue = next;
      return next;
    },
    setPosition: (id, position) =>
      update(async (data) => {
        if (typeof id !== "string" || !position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error("Invalid Project position.");
        const entry = data.projects.find((project) => project.id === id);
        if (!entry) throw new Error("Project is not in the registry.");
        entry.position = { x: position.x, y: position.y };
        return data;
      }),
    // The file as it is, after the writes asked for before it (a refused one, an invalid position, leaves it as it was).
    snapshot: async () => {
      await queue.catch(() => {});
      const data = await read();
      return { projects: data.projects, links: data.links, projectGroups: data.projectGroups ?? [], worktreePositions: data.worktreePositions };
    },
    setWorktreePosition: (id, worktreePath, position) =>
      update(async (data) => {
        if (
          !data.projects.some((project) => project.id === id) ||
          typeof worktreePath !== "string" ||
          !path.isAbsolute(worktreePath) ||
          !position ||
          !Number.isFinite(position.x) ||
          !Number.isFinite(position.y)
        )
          throw new Error("Invalid Worktree position.");
        data.worktreePositions[id] ??= {};
        data.worktreePositions[id][worktreePath] = { x: position.x, y: position.y };
        return data;
      }),
    addLink: (a, b, active) =>
      update(async (data) => {
        data.links.push(createLink(data.links, a, b, data.projects, active, now));
        return data;
      }),
    /** Undo of a removal: the same Link, id and all, so what was saved against it (Always allow) holds again. */
    restoreLink: (link, active) =>
      update(async (data) => {
        data.links.push(restoreLink(data.links, link, data.projects, active));
        return data;
      }),
    removeLink: (id) =>
      update(async (data) => {
        if (!data.links.some((link) => link.id === id)) throw new Error("Link does not exist.");
        data.links = data.links.filter((link) => link.id !== id);
        return data;
      }),
    /** Drops Links whose endpoints went away; resolves with the dropped ones. */
    pruneLinks: async (active) => {
      let removed = [];
      await update(async (data) => {
        const kept = pruneLinks(data.links, data.projects, active);
        removed = data.links.filter((link) => !kept.includes(link));
        data.links = kept;
        for (const [id, positions] of Object.entries(data.worktreePositions)) {
          if (!data.projects.some((project) => project.id === id)) {
            delete data.worktreePositions[id];
            continue;
          }
          for (const worktreePath of Object.keys(positions)) if (!active[id]?.includes(worktreePath)) delete positions[worktreePath];
        }
        return data;
      });
      return removed;
    },
  };
}

module.exports = { coordinationProjects, createProjectRegistry };
