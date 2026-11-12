const fs = require("node:fs/promises");
const path = require("node:path");

// Folders a scan never enters: system and media folders in the home, dependency and build output, anything hidden.
const SKIP = new Set([
  "Library",
  "Applications",
  "Pictures",
  "Movies",
  "Music",
  "Public",
  "node_modules",
  "bower_components",
  "vendor",
  "Pods",
  "DerivedData",
  "build",
  "dist",
  "target",
  ".git",
]);
const MAX_DEPTH = 5;
const MAX_FOLDERS = 20000;
const TIME_BUDGET_MS = 2500;
const CACHE_MS = 60_000;
const LIMIT = 40;

/**
 * The Git repositories under a folder (the home, for the phone's project search): a breadth-first walk that stops at
 * each repository, skips hidden, system and dependency folders, and gives up after a depth, a folder count or a time
 * budget so a huge home still answers. Only names and paths are read; nothing is opened inside a repository.
 */
async function scanRepositories(root, { now = Date.now, readdir = fs.readdir, maxDepth = MAX_DEPTH } = {}) {
  const started = now();
  const found = [];
  let queue = [{ folder: root, depth: 0 }];
  let seen = 0;
  while (queue.length && seen < MAX_FOLDERS && now() - started < TIME_BUDGET_MS) {
    const next = [];
    for (const { folder, depth } of queue) {
      if (++seen > MAX_FOLDERS || now() - started >= TIME_BUDGET_MS) break;
      let entries;
      try {
        entries = await readdir(folder, { withFileTypes: true });
      } catch {
        continue;
      }
      if (entries.some((entry) => entry.name === ".git")) {
        found.push({ path: folder, name: path.basename(folder) });
        continue;
      }
      if (depth >= maxDepth) continue;
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
        next.push({ folder: path.join(folder, entry.name), depth: depth + 1 });
      }
    }
    queue = next;
  }
  return found;
}

/** Repositories whose name (or, failing that, path) holds the query: name prefixes first, then shorter paths. */
function rankRepositories(repositories, query, limit = LIMIT) {
  const needle = String(query || "")
    .trim()
    .toLowerCase();
  const score = (repo) => {
    const name = repo.name.toLowerCase();
    if (!needle) return 0;
    if (name === needle) return 0;
    if (name.startsWith(needle)) return 1;
    if (name.includes(needle)) return 2;
    if (repo.path.toLowerCase().includes(needle)) return 3;
    return -1;
  };
  return repositories
    .map((repo) => ({ repo, rank: score(repo) }))
    .filter((item) => item.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.repo.path.length - b.repo.path.length || a.repo.path.localeCompare(b.repo.path))
    .slice(0, limit)
    .map((item) => item.repo);
}

/** A cached scan of `root`: searching while typing reuses one walk for a minute. */
function createProjectFinder(root, { now = Date.now, scan = scanRepositories } = {}) {
  let cache = null;
  return {
    async search(query) {
      if (!cache || now() - cache.at > CACHE_MS) cache = { at: now(), repositories: scan(root) };
      const repositories = await cache.repositories.catch((error) => {
        cache = null;
        throw error;
      });
      return rankRepositories(repositories, query);
    },
  };
}

module.exports = { SKIP, createProjectFinder, rankRepositories, scanRepositories };
