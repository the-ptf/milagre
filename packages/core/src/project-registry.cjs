const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { resolveProject } = require("./project-identity.cjs");
const { createLink, pruneLinks, restoreLink } = require("./project-links.cjs");
const { createProjectGroup, deleteProjectGroup, updateProjectGroup, validProjectGroup } = require("./project-groups.cjs");

const registryRoots = (home) => [path.join(home, "Developer"), path.join(home, ".milagre", "worktrees")];
const DEFAULT_ROOTS = registryRoots(os.homedir());
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

async function identityStamp(entry) {
  if (entry.git === false || entry.id === entry.path) return null;
  const dotGit = path.join(entry.path, ".git");
  const [real, folder, gitDir, gitReal, config, worktreeConfig, commonDir] = await Promise.all([
    fs.realpath(entry.path).catch(() => null),
    fs.lstat(entry.path).catch(() => null),
    fs.lstat(dotGit).catch(() => null),
    fs.realpath(dotGit).catch(() => null),
    fs.readFile(path.join(entry.id, "config"), "utf8").catch(() => null),
    fs.lstat(path.join(entry.id, "config.worktree")).catch(() => null),
    fs.lstat(path.join(entry.id, "commondir")).catch(() => null),
  ]);
  const uid = process.geteuid?.();
  if (!real || !folder?.isDirectory() || !gitDir?.isDirectory() || gitReal !== entry.id || commonDir || config === null) return null;
  if (uid === undefined || folder.uid !== uid || gitDir.uid !== uid || /^\s*\[include/im.test(config)) return null;
  const configHash = createHash("sha256").update(config).digest("hex");
  return [real, folder.ino, gitDir.ino, configHash, worktreeConfig ? `${worktreeConfig.ino}:${worktreeConfig.mtimeMs}:${worktreeConfig.size}` : "-"].join("|");
}

function createIdentityCheck(resolve) {
  const confirmed = new Map();
  return async (entry) => {
    const key = `${entry.id}\0${entry.path}`;
    const stamp = await identityStamp(entry);
    if (stamp !== null && confirmed.get(key) === stamp) return true;
    confirmed.delete(key);
    let identity;
    try {
      identity = await resolve(entry.path);
    } catch {
      return false;
    }
    const present = identity.id === entry.id && identity.path === entry.path;
    if (present && stamp !== null) confirmed.set(key, stamp);
    return present;
  };
}

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

function createProjectRegistry(file, { roots = DEFAULT_ROOTS, now = () => new Date(), resolve = resolveProject } = {}) {
  const present = createIdentityCheck(resolve);
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
          (link) =>
            link.sharedChat || (projects.some((project) => project.id === link.a?.project_id) && projects.some((project) => project.id === link.b?.project_id)),
        );
        const result = await change(current);
        if (JSON.stringify(result) !== JSON.stringify(previous)) await write(result);
        return result.projects;
      });
    queue = next;
    return next;
  }

  return {
    createWorktreeGroup: async (linkId) => {
      let group;
      await update(async (data) => {
        const link = data.links.find((item) => item.id === linkId);
        if (!link?.a.worktree_path || !link.b.worktree_path) throw new Error("Choose a Link between two Worktrees.");
        const projectIds = [...new Set([link.a.project_id, link.b.project_id])];
        if (projectIds.length !== 2) throw new Error("Choose Worktrees from different Projects.");
        group = {
          id: require("node:crypto").randomUUID(),
          canvasLinkId: linkId,
          projectIds,
          name: [link.a, link.b].map((end) => path.basename(end.worktree_path)).join(" + "),
          createdAt: now().toISOString(),
        };
        data.projectGroups = [...(data.projectGroups ?? []), group];
        data.links = data.links.map((item) => (item.id === linkId ? { ...item, sharedChat: { linkId: group.id, sessionId: 1 } } : item));
        return data;
      });
      return group;
    },
    setLinkChat: (id, sharedChat) =>
      update(async (data) => {
        const link = data.links.find((item) => item.id === id);
        if (!link) throw new Error("Link does not exist.");
        const { sharedChat: _previous, ...rest } = link;
        data.links = data.links.map((item) => (item.id === id ? { ...rest, ...(sharedChat ? { sharedChat } : {}) } : item));
        return data;
      }),
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
    deleteProjectGroup: async (id) => {
      await update(async (data) => {
        data.projectGroups = deleteProjectGroup(data.projectGroups ?? [], id);
        return data;
      });
    },
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
          await write({ ...data, projects, links: data.links.filter((link) => link.sharedChat || (kept(link.a?.project_id) && kept(link.b?.project_id))) });
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
    restoreLink: (link, active) =>
      update(async (data) => {
        data.links.push(restoreLink(data.links, link, data.projects, active));
        return data;
      }),
    removeLink: (id) =>
      update(async (data) => {
        if (!data.links.some((link) => link.id === id) && !data.projectGroups?.some((group) => group.canvasLinkId === id))
          throw new Error("Link does not exist.");
        data.links = data.links.filter((link) => link.id !== id);
        return data;
      }),
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

module.exports = { coordinationProjects, createProjectRegistry, registryRoots };
