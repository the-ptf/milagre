const { createGit } = require("./git/client.cjs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { outsideGit } = require("./project-identity.cjs");
const git = createGit().read;

// A Project folder outside Git has no ls-files: its files are walked instead, skipping dependency and hidden folders,
// up to a limit so a huge folder can't stall the @ menu.
const SKIPPED = new Set(["node_modules", "dist", "build", "target", "vendor", "Pods", "DerivedData"]);
async function walkFiles(root, limit = 20000) {
  const files = [];
  const pending = [""];
  while (pending.length && files.length < limit) {
    const relative = pending.shift();
    let entries;
    try {
      entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.isDirectory()) continue;
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) pending.push(file);
      } else if (entry.isFile()) files.push(file);
    }
  }
  return files.slice(0, limit);
}

// Milagre's own metadata folder (Chat storage, the runtime lock) is never a Project file to mention or dictate: outside
// Git the walk skips it as a hidden folder, and in a repository that doesn't ignore it ls-files lists it as untracked.
// A new Chats home has nothing else, so its @ menu would offer only the lock.
const isMetadata = (file) => file === ".milagre" || file.startsWith(".milagre/");

function createFileSearch({ now = Date.now, ttl = 5000 } = {}) {
  const cache = new Map();
  const search = async (root, query = "", limit = 30) => {
    if (typeof root !== "string" || !path.isAbsolute(root) || typeof query !== "string") throw new Error("Choose a worktree to search.");
    const files = await search.list(root);
    const q = query.toLowerCase().slice(0, 256);
    const score = (file) => {
      const name = path.basename(file).toLowerCase();
      return name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : 3;
    };
    return files
      .filter((file) => file.toLowerCase().includes(q))
      .sort((a, b) => score(a) - score(b) || path.basename(a).length - path.basename(b).length || a.localeCompare(b))
      .slice(0, Math.min(50, Math.max(1, Number.isFinite(limit) ? limit : 30)));
  };
  /** Every file of the folder, as the search reads them (cached for `ttl`). */
  search.list = (root) => {
    let entry = cache.get(root);
    if (!entry || now() - entry.at > ttl) {
      const promise = outsideGit(root).then((plain) =>
        plain
          ? walkFiles(root)
          : git
              .checked(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
              .then(({ stdout }) => [...new Set(stdout.split("\0").filter((file) => file && !isMetadata(file)))]),
      );
      entry = { at: now(), promise };
      cache.set(root, entry);
      if (cache.size > 8) cache.delete(cache.keys().next().value);
      promise.catch(() => {
        if (cache.get(root) === entry) cache.delete(root);
      });
    }
    return entry.promise;
  };
  return search;
}
module.exports = { createFileSearch };
