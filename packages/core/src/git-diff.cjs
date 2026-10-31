const { createHash } = require("node:crypto");
const { createGit } = require("./git/client.cjs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { PATHSPEC } = require("./diffstat.cjs");

// What a chat's folder changed, file by file, for the Changes panel and the diff view. Read-only: git
// runs without a shell, every argument an array element, and nothing here writes to the repository.

const NOT_REPO = "This chat's folder isn't a git repository.";
const FILE_LIMIT = 1000;
const PATCH_LIMIT = 1024 * 1024;
// Untracked files are counted one git call each; a few at a time, so a fresh node_modules can't fork hundreds of processes.
const UNTRACKED_CONCURRENCY = 8;
// The tree of an empty repository, to diff against before the first commit.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const STATUSES = { A: "added", D: "deleted", R: "renamed" };

/** Paths come from git's own list, so anything absolute or climbing out of the folder is not one of ours. */
function checkPath(file) {
  if (typeof file !== "string" || !file || file.includes("\0") || path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
    throw new Error("The file must be a path inside the chat's folder.");
  }
  return file;
}

function createGitDiff(options = {}) {
  const { run, checked, out: gitOut, refExists, resolveBase, createdFrom, chatBase } = createGit(options).read;

  const commitStats = new Map();
  const catalogs = new Map();
  const now = options.now ?? Date.now;
  const cacheTime = 30000;

  // One shared read per folder/branch, bounded in size and age, including concurrent polls.
  async function catalog(cwd, branch) {
    const key = JSON.stringify([cwd, branch]);
    const saved = catalogs.get(key);
    if (saved && saved.expires > now()) return saved.read;
    if (!saved && catalogs.size >= 64) catalogs.delete(catalogs.keys().next().value);
    const entry = { expires: now() + cacheTime };
    entry.read = Promise.all([checked(cwd, ["for-each-ref", "--format=%(refname)", "refs/heads/", "refs/remotes/"]), createdFrom(cwd)])
      .then(([refs, source]) => {
        const branches = refs.stdout
          .trim()
          .split("\n")
          .filter((ref) => ref && !ref.endsWith("/HEAD"))
          .map((ref) => ({ ref, name: ref.replace(/^refs\/(heads|remotes)\//, "") }));
        return { branches, source, version: createHash("sha256").update(JSON.stringify(branches)).digest("hex") };
      })
      .catch((error) => {
        if (catalogs.get(key) === entry) catalogs.delete(key);
        throw error;
      });
    catalogs.set(key, entry);
    return entry.read;
  }

  /**
   * The refs `git diff` compares for a mode, or null when there is nothing to compare: uncommitted work
   * is against HEAD (the empty tree before the first commit); committed work is merge-base..HEAD.
   */
  async function refsFor(cwd, base, mode, range, commit) {
    if (commit != null) {
      if (mode !== "committed" || typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) throw new Error("A full commit SHA is required.");
      await checked(cwd, ["rev-parse", "--verify", `${commit}^{commit}`]);
      const parents = (await checked(cwd, ["rev-list", "--parents", "-n", "1", commit, "--"])).stdout.trim().split(/\s+/);
      return { name: commit, parent: parents[1] || null, refs: [parents[1] || EMPTY_TREE, commit] };
    }
    // A PR's commits, as GitHub diffs them: merge-base(base, head)..head. The caller checked both are commit ids.
    if (mode === "range") {
      if (!/^[0-9a-f]{40}$/.test(range?.base ?? "") || !/^[0-9a-f]{40}$/.test(range?.head ?? "")) return { name: null, refs: null };
      const mergeBase = await gitOut(cwd, ["merge-base", range.base, range.head]);
      return { name: null, refs: mergeBase ? [mergeBase, range.head] : null };
    }
    const hasHead = await refExists(cwd, "HEAD");
    if (mode !== "committed") return { name: null, refs: [hasHead ? "HEAD" : EMPTY_TREE] };
    const resolved = await chatBase(cwd, base);
    if (!resolved.ref) return { name: null, refs: null };
    const mergeBase = hasHead ? await gitOut(cwd, ["merge-base", resolved.ref, "HEAD"]) : null;
    return { name: resolved.name, refs: mergeBase ? [mergeBase, "HEAD"] : null };
  }

  /** `--name-status -z` and `--numstat -z` both list a rename as old then new; walk their tokens. */
  function parseNameStatus(output) {
    const tokens = output.split("\0");
    const entries = [];
    for (let i = 0; i < tokens.length - 1;) {
      const code = tokens[i++];
      if (!code) continue;
      if (code[0] === "R") {
        const oldPath = tokens[i++];
        entries.push({ status: "renamed", oldPath, path: tokens[i++] });
      } else if (code[0] === "C") {
        // A copy is a new file here; its source is untouched.
        i++;
        entries.push({ status: "added", path: tokens[i++] });
      } else {
        entries.push({ status: STATUSES[code[0]] ?? "modified", path: tokens[i++] });
      }
    }
    return entries;
  }

  function parseNumstat(output) {
    const tokens = output.split("\0");
    const counts = new Map();
    for (let i = 0; i < tokens.length;) {
      const record = tokens[i++];
      if (!record) continue;
      const [added, removed, file] = record.split("\t");
      const binary = added === "-" && removed === "-";
      const entry = { added: binary ? 0 : Number(added) || 0, removed: binary ? 0 : Number(removed) || 0, binary };
      // A rename has an empty path here, then the old and the new path as separate tokens.
      if (file === "") {
        i++;
        counts.set(tokens[i++], entry);
      } else {
        counts.set(file, entry);
      }
    }
    return counts;
  }

  async function untrackedFile(cwd, file) {
    // --no-index exits 1 when the files differ, which is the usual case here.
    const result = await run(cwd, ["diff", "--no-index", "--numstat", "--", "/dev/null", file]);
    const [added, removed] = result.stdout.split("\t");
    const binary = added === "-" && removed === "-";
    return { path: file, status: "added", added: binary ? 0 : Number(added) || 0, removed: 0, binary, untracked: true };
  }

  async function listDiffFiles({ cwd, base, mode, range, commit } = {}) {
    if (!(await run(cwd, ["rev-parse", "--is-inside-work-tree"])).ok) return { isRepo: false, message: NOT_REPO };
    const { name, refs, parent } = await refsFor(cwd, base, mode, range, commit);
    if (!refs) {
      // A base that resolves but meets HEAD nowhere is not the same as having no base.
      return name ? { isRepo: true, base: name, files: [], message: `This branch shares no history with ${name}.` } : { isRepo: true, base: null, files: [] };
    }
    const [status, numstat] = await Promise.all([
      checked(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "-M", ...refs, ...PATHSPEC]),
      checked(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "-M", ...refs, ...PATHSPEC]),
    ]);
    const counts = parseNumstat(numstat.stdout);
    const files = parseNameStatus(status.stdout).map((entry) => ({ ...entry, ...(counts.get(entry.path) ?? { added: 0, removed: 0, binary: false }) }));
    let truncated = files.length > FILE_LIMIT;
    if (mode !== "committed" && mode !== "range") {
      const listed = await run(cwd, ["ls-files", "--others", "--exclude-standard", "-z", ...PATHSPEC]);
      const candidates = listed.stdout.split("\0").filter(Boolean);
      const available = Math.max(0, FILE_LIMIT - files.length);
      truncated ||= candidates.length > available;
      const untracked = candidates.slice(0, available);
      for (let i = 0; i < untracked.length; i += UNTRACKED_CONCURRENCY) {
        files.push(...(await Promise.all(untracked.slice(i, i + UNTRACKED_CONCURRENCY).map((file) => untrackedFile(cwd, file)))));
      }
    }
    return {
      isRepo: true,
      base: name,
      ...(commit != null ? { commit, commitParent: parent } : {}),
      ...(truncated ? { truncated: true } : {}),
      files: files.slice(0, FILE_LIMIT),
    };
  }

  /** The file is one git lists as untracked (not ignored, not under .milagre) and really lives inside the folder, not behind a symlink. */
  async function isUntrackedInside(cwd, file) {
    const listed = await run(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--", `:(literal)${file}`, ...PATHSPEC]);
    if (!listed.ok || !listed.stdout.split("\0").includes(file)) return false;
    try {
      const [root, real] = await Promise.all([fs.realpath(cwd), fs.realpath(path.join(cwd, file))]);
      return real === root || real.startsWith(root + path.sep);
    } catch {
      return false;
    }
  }

  async function readDiffFile({ cwd, base, mode, range, commit, path: file, oldPath, untracked } = {}) {
    checkPath(file);
    if (oldPath !== undefined && oldPath !== null) checkPath(oldPath);
    let result;
    if (commit == null && untracked && mode !== "committed" && mode !== "range") {
      if (!(await isUntrackedInside(cwd, file))) return { patch: "", binary: false, tooLarge: false };
      result = await run(cwd, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-index", "-U3", "--", "/dev/null", file]);
      if (result.overflow) return { patch: "", binary: false, tooLarge: true };
      // Exit code 1 means "differs"; only a missing file or a crash is a failure.
      if (!result.ok && result.code !== 1) return { patch: "", binary: false, tooLarge: false };
    } else {
      const { refs } = await refsFor(cwd, base, mode, range, commit);
      if (!refs) return { patch: "", binary: false, tooLarge: false };
      const specs = [`:(literal)${file}`, ...(oldPath && oldPath !== file ? [`:(literal)${oldPath}`] : [])];
      result = await run(cwd, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "-U3", ...refs, "--", ...specs]);
      if (result.overflow) return { patch: "", binary: false, tooLarge: true };
      if (!result.ok) return { patch: "", binary: false, tooLarge: false };
    }
    if (result.stdout.length > PATCH_LIMIT) return { patch: "", binary: false, tooLarge: true };
    const binary = /^(Binary files .* differ|GIT binary patch)$/m.test(result.stdout);
    return { patch: binary ? "" : result.stdout, binary, tooLarge: false };
  }

  /** Bounded, read-only history for the same comparison the file tree uses. */
  async function history({ cwd, base, recordedBase, branchesVersion, limit = 30 } = {}) {
    if (!(await run(cwd, ["rev-parse", "--is-inside-work-tree"])).ok) return { isRepo: false, message: NOT_REPO };
    const [branch, head] = await Promise.all([gitOut(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]), gitOut(cwd, ["rev-parse", "--verify", "HEAD"])]);
    const { branches, source, version } = await catalog(cwd, branch);
    // Resolve the creation source once, rather than walking its reflog for each base.
    const [automatic, projectDefault, baseExists] = await Promise.all([
      resolveBase(cwd, recordedBase || source),
      resolveBase(cwd),
      base ? refExists(cwd, base) : true,
    ]);
    const resolved = base && base !== (recordedBase || source) ? await resolveBase(cwd, base) : automatic;
    const recorded = !!recordedBase && (await refExists(cwd, recordedBase));
    const suggestionSource = recorded ? recordedBase : source;
    const suggested =
      suggestionSource && (await refExists(cwd, suggestionSource)) ? await gitOut(cwd, ["rev-parse", "--symbolic-full-name", suggestionSource]) : null;
    const result = {
      isRepo: true,
      branch,
      head,
      base: resolved.name,
      comparisonRef: resolved.ref,
      ...(branchesVersion === version ? {} : { branches }),
      branchesVersion: version,
      baseMissing: !baseExists,
      automatic: {
        ...automatic,
        reason: recorded ? "the recorded base" : !recordedBase && source && suggested ? "the branch it was created from" : "the project default",
      },
      projectDefault,
      suggested,
      commits: [],
      hasMore: false,
      total: 0,
    };
    if (!head) return result;
    if (!resolved.ref) return { ...result, message: "No comparison branch available." };
    const mergeBase = await gitOut(cwd, ["merge-base", resolved.ref, "HEAD"]);
    if (!mergeBase) return { ...result, message: `This branch shares no history with ${resolved.name}.` };
    result.total = Number(await gitOut(cwd, ["rev-list", "--count", `${mergeBase}..HEAD`, "--"])) || 0;
    if (limit === 0) return result;
    const count = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 300)) : 30;
    const log = await checked(cwd, ["log", "-z", `--max-count=${count + 1}`, "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%B", `${mergeBase}..HEAD`, "--"]);
    const fields = log.stdout.split("\0");
    const commits = [];
    for (let i = 0; i + 5 < fields.length; i += 6) {
      const [sha, parents, author, email, date, message] = fields.slice(i, i + 6);
      commits.push({ sha, parent: parents.split(" ")[0], author, email, date, message: message.trim() });
    }
    const detailed = [];
    for (let i = 0; i < Math.min(commits.length, count); i += 4) {
      detailed.push(
        ...(await Promise.all(
          commits.slice(i, Math.min(i + 4, count)).map(async ({ parent, ...commit }) => {
            const key = `${cwd}\0${commit.sha}`;
            const cached = commitStats.get(key);
            if (cached && (!cached.retryAt || cached.retryAt > now())) return { ...commit, ...cached.totals };
            // Compare the first parent explicitly, including merges, without requiring Git 2.31 --diff-merges.
            let stat;
            try {
              stat = await checked(cwd, [
                ...(parent ? ["diff"] : ["show", "--format="]),
                "--no-ext-diff",
                "--no-textconv",
                "--numstat",
                "-z",
                "-M",
                ...(parent ? [parent, commit.sha] : [commit.sha]),
                ...PATHSPEC,
              ]);
            } catch (error) {
              if (!error.timedOut && !error.overflow) throw error;
              const totals = { files: null, added: null, removed: null, statsUnavailable: error.overflow ? "tooLarge" : "timeout" };
              if (commitStats.size >= 600) commitStats.delete(commitStats.keys().next().value);
              commitStats.set(key, { totals, retryAt: now() + cacheTime });
              return { ...commit, ...totals };
            }
            const files = [...parseNumstat(stat.stdout).values()];
            const totals = {
              files: files.length,
              added: files.reduce((sum, file) => sum + file.added, 0),
              removed: files.reduce((sum, file) => sum + file.removed, 0),
            };
            if (commitStats.size >= 600) commitStats.delete(commitStats.keys().next().value);
            commitStats.set(key, { totals });
            return { ...commit, ...totals };
          }),
        )),
      );
    }
    return { ...result, commits: detailed, hasMore: commits.length > count };
  }

  return { listDiffFiles, readDiffFile, history };
}

module.exports = { createGitDiff };
