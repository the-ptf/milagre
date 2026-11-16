const fs = require("node:fs/promises");
const path = require("node:path");
const { z } = require("zod");
const { createGit } = require("./git/client.cjs");

const MAX_OUTPUT = 40_000;
const MAX_FILE = 2 * 1024 * 1024;
const cap = (text) => (text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n... truncated` : text);
const under = (root, file) => {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

function createAdvisorReads({ roots, referenceRoots = [], git = createGit({ analysisOnly: true }).read }) {
  const owned = new Set(roots);
  const allowed = new Set([...roots, ...referenceRoots]);
  async function resolve(root, file = ".") {
    if (!allowed.has(root)) throw new Error("That root is not available to this advisor.");
    if (!file || file.startsWith("-") || path.isAbsolute(file) || file.includes("\0")) throw new Error("Give a relative path inside an advisor root.");
    const actualRoot = await fs.realpath(root);
    const requested = path.resolve(actualRoot, file);
    if (!under(actualRoot, requested)) throw new Error("That path is outside the advisor root.");
    const actual = await fs.realpath(requested);
    if (!under(actualRoot, actual)) throw new Error("That path is outside the advisor root.");
    return { root: actualRoot, file: actual };
  }
  async function files(root, directory = ".") {
    const resolved = await resolve(root, directory);
    const found = [];
    let visited = 0;
    async function walk(current) {
      if (++visited > 1000 || found.length >= 1000) return;
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if ([".git", "node_modules"].includes(entry.name) || entry.isSymbolicLink()) continue;
        const file = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile()) found.push(path.relative(resolved.root, file));
        if (found.length >= 1000) break;
      }
    }
    await walk(resolved.file);
    return found;
  }
  const rootInput = z.string().refine((value) => allowed.has(value), "Choose a root supplied to this advisor.");
  const relativeInput = z.string().min(1).max(4096);
  const definition = (name, description, input, run) => ({ name, description, input, run, strict: true, readOnly: true });
  return [
    definition(
      "advisor_read_file",
      "Read numbered lines of a file inside an advisor root. Available roots: " + [...allowed].join(", "),
      {
        root: rootInput,
        path: relativeInput,
        start: z.number().int().min(1).optional(),
        end: z.number().int().min(1).optional(),
      },
      async ({ root, path: relative, start = 1, end }) => {
        const resolved = await resolve(root, relative);
        const stat = await fs.stat(resolved.file);
        if (!stat.isFile() || stat.size > MAX_FILE) throw new Error("Read a file smaller than 2 MB.");
        const lines = (await fs.readFile(resolved.file, "utf8")).split("\n");
        return cap(
          lines
            .slice(start - 1, end)
            .map((line, index) => `${start + index}\t${line}`)
            .join("\n"),
        );
      },
    ),
    definition(
      "advisor_list_files",
      "List up to 1,000 files inside an advisor root; ignores symlinks, .git and node_modules.",
      {
        root: rootInput,
        path: relativeInput.optional(),
      },
      async ({ root, path: relative }) => cap((await files(root, relative)).join("\n") || "No files."),
    ),
    definition(
      "advisor_search_files",
      "Search files for literal text, returning at most 200 matching lines. Optional glob selects file names.",
      {
        root: rootInput,
        query: z.string().min(1).max(1000),
        glob: z.string().min(1).max(256).optional(),
      },
      async ({ root, query, glob }) => {
        const matches = [];
        const pattern =
          glob &&
          new RegExp(
            "^" +
              glob
                .split("*")
                .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
                .join(".*") +
              "$",
          );
        for (const relative of await files(root)) {
          if (pattern && !pattern.test(relative)) continue;
          const resolved = await resolve(root, relative);
          if ((await fs.stat(resolved.file)).size > MAX_FILE) continue;
          const content = await fs.readFile(resolved.file, "utf8");
          if (content.includes("\0")) continue;
          for (const [index, line] of content.split("\n").entries()) {
            if (line.includes(query)) matches.push(`${relative}:${index + 1}:${line}`);
            if (matches.length >= 200) return cap(matches.join("\n"));
          }
        }
        return cap(matches.join("\n") || "No matches.");
      },
    ),
    definition(
      "advisor_git",
      "Read Git status, diff or log of an owned Worktree. No arbitrary commands or options.",
      {
        root: rootInput,
        operation: z.enum(["status", "diff", "log"]),
        staged: z.boolean().optional(),
        path: relativeInput.optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      async ({ root, operation, staged, path: relative, limit = 20 }) => {
        if (!owned.has(root)) throw new Error("Git reads require an owned Worktree root.");
        if (relative) await resolve(root, relative);
        const args =
          operation === "status"
            ? ["status", "--short", "--branch"]
            : operation === "diff"
              ? ["diff", "--no-color", ...(staged ? ["--cached"] : []), "--", ...(relative ? [relative] : [])]
              : ["log", "--oneline", "--decorate", "-n", String(limit), "--", ...(relative ? [relative] : [])];
        return cap((await git.text(await fs.realpath(root), args)).trim() || `git ${operation}: nothing to show.`);
      },
    ),
  ];
}

module.exports = { createAdvisorReads };
