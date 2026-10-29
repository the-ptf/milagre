const { createGit, GitError } = require("./git/client.cjs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const git = createGit().read;

// Files a new worktree gets from the project's main checkout, after Conductor's "Files to copy":
// untracked files that git ignores and that match the project's patterns (.gitignore syntax).
const DEFAULT_PATTERNS = [".env*"];
// Dependency and build folders are left out of the walk and the copy: an unanchored pattern such as the default
// `.env*` would otherwise pick up a dependency's own files (node_modules/bottleneck/.env).
const EXCLUDED_FOLDERS = [
  "node_modules",
  ".git",
  ".milagre",
  "vendor/bundle",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  "dist",
  "build",
  "target",
  ".turbo",
  ".cache",
  "Pods",
  ".gradle",
  ".expo",
  ".dart_tool",
  "coverage",
];

/**
 * The folders to skip for these patterns. A folder comes back in when an anchored pattern (one with a slash
 * before its end, like `dist/config.json` or `**\/node_modules/pkg/.env`) names it, so it can still be asked for.
 * Unanchored patterns never lift an exclusion.
 */
function excludedFolders(patterns) {
  const anchored = patterns
    .map((line) => line.trim())
    // A negated pattern only takes files out, so it never asks for a folder.
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("!"))
    .map((line) => line.replace(/^\//, ""))
    .filter((line) => line.replace(/\/+$/, "").includes("/") || /^[^/]+\/$/.test(line));
  return EXCLUDED_FOLDERS.filter((folder) => !anchored.some((line) => line === `${folder}/` || line.startsWith(`${folder}/`) || line.includes(`/${folder}/`)));
}

/** Whether the real location of `directory` (or of its nearest existing ancestor) is inside `realRoot`. */
async function staysInside(realRoot, directory) {
  let current = directory;
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return real === realRoot || real.startsWith(`${realRoot}${path.sep}`);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") return false;
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }
}

const COPY_LIMITS = { maxFiles: 500, maxBytes: 100 * 1024 * 1024 };

function patternLines(text) {
  return text.split(/\r?\n/);
}

/** Which patterns apply: .worktreeinclude at the repo root, else the project's setting, else the default. */
async function resolvePatterns(projectPath, setting) {
  let worktreeInclude = null;
  try {
    worktreeInclude = await fs.readFile(path.join(projectPath, ".worktreeinclude"), "utf8");
  } catch {}
  if (worktreeInclude !== null) return { source: "worktreeinclude", patterns: patternLines(worktreeInclude), worktreeInclude };
  const custom = (setting ?? []).map((line) => line.trim()).filter(Boolean);
  if (custom.length > 0) return { source: "setting", patterns: custom, worktreeInclude: null };
  return { source: "default", patterns: DEFAULT_PATTERNS, worktreeInclude: null };
}

// check-ignore exits 1 when no path is ignored; the shared runner still preserves its output.
async function gitWithInput(cwd, args, input) {
  const result = await git.run(cwd, args, { input });
  if (!result.ok && result.code !== 1) throw new GitError(result);
  return result.stdout;
}

/** The regular files in `projectPath` that the patterns pick and git ignores, as { path, size }, sorted. */
async function findFilesToCopy(projectPath, patterns) {
  if (patterns.every((line) => !line.trim() || line.trim().startsWith("#"))) return [];
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-copy-"));
  let candidates;
  try {
    const patternFile = path.join(scratch, "patterns");
    await fs.writeFile(patternFile, `${patterns.join("\n")}\n`);
    const skipped = excludedFolders(patterns).map((folder) => `:(exclude,glob)**/${folder}/**`);
    const { stdout } = await git.checked(projectPath, ["ls-files", "-z", "--others", "--ignored", `--exclude-from=${patternFile}`, "--", ".", ...skipped]);
    candidates = stdout.split("\0").filter(Boolean);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
  if (candidates.length === 0) return [];
  const ignored = (await gitWithInput(projectPath, ["check-ignore", "-z", "--stdin", "--no-index"], `${candidates.join("\0")}\0`)).split("\0").filter(Boolean);
  const files = [];
  for (const relative of [...new Set(ignored)].sort()) {
    try {
      const stat = await fs.lstat(path.join(projectPath, relative));
      if (stat.isFile()) files.push({ path: relative, size: stat.size });
    } catch {}
  }
  return files;
}

/** What the effective patterns match right now, for the Settings preview. `setting` may be an unsaved draft. */
async function previewFilesToCopy(projectPath, setting) {
  const resolved = await resolvePatterns(projectPath, setting);
  let matches = [];
  try {
    matches = (await findFilesToCopy(projectPath, resolved.patterns)).map((file) => file.path);
  } catch {}
  return { source: resolved.source, worktreeInclude: resolved.worktreeInclude, matches };
}

/** Copies the matching files into a new worktree. Never throws: what went wrong comes back as notes. */
async function copyFilesToWorktree({ projectPath, worktreePath, setting, limits = {} }) {
  const { maxFiles, maxBytes } = { ...COPY_LIMITS, ...limits };
  const copied = [];
  const notes = [];
  try {
    const resolved = await resolvePatterns(projectPath, setting);
    const files = await findFilesToCopy(projectPath, resolved.patterns);
    let bytes = 0;
    for (const file of files) {
      if (copied.length >= maxFiles || bytes + file.size > maxBytes) {
        notes.push(
          copied.length >= maxFiles ? `Stopped copying at the ${maxFiles} file cap.` : `Stopped copying at the ${Math.round(maxBytes / (1024 * 1024))} MB cap.`,
        );
        break;
      }
      const target = path.join(worktreePath, file.path);
      if (path.relative(worktreePath, target).startsWith("..")) continue;
      try {
        // A folder the base branch tracks as a symlink must not lead the copy out of the worktree.
        const realWorktree = await fs.realpath(worktreePath);
        if (!(await staysInside(realWorktree, path.dirname(target)))) {
          notes.push(`Skipped ${file.path}: its folder leads outside the worktree.`);
          continue;
        }
        await fs.mkdir(path.dirname(target), { recursive: true });
        if (!(await staysInside(realWorktree, path.dirname(target)))) {
          notes.push(`Skipped ${file.path}: its folder leads outside the worktree.`);
          continue;
        }
        // Never overwrite: a file the worktree already has came from git.
        await fs.copyFile(path.join(projectPath, file.path), target, fs.constants.COPYFILE_EXCL);
        copied.push(file.path);
        bytes += file.size;
      } catch (error) {
        if (error.code !== "EEXIST") notes.push(`Couldn't copy ${file.path}: ${error.message}`);
      }
    }
  } catch (error) {
    notes.push(`Couldn't copy files: ${error.message}`);
  }
  return { copied, notes };
}

module.exports = {
  COPY_LIMITS,
  DEFAULT_PATTERNS,
  EXCLUDED_FOLDERS,
  excludedFolders,
  copyFilesToWorktree,
  findFilesToCopy,
  previewFilesToCopy,
  resolvePatterns,
};
