const { GIT_CODES, gitMessage } = require("@milagre/shared/git-codes");
const childProcess = require("node:child_process");
const { createGit } = require("./git/client.cjs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { PATHSPEC, fileLineCount } = require("./diffstat.cjs");
const { kindOf, lanes } = require("./process-lanes.cjs");

// Commit, push and open a PR for a chat's folder, from the "Commit and open PR" dialog. Milagre runs
// git and gh itself, never through a shell: every program gets its arguments as an array, and text
// (the commit message, the PR body) goes in on stdin.

const NO_ORIGIN = gitMessage(GIT_CODES.NO_ORIGIN);
const GH_MISSING = gitMessage(GIT_CODES.GH_MISSING);
const GH_LOGIN = "Run `gh auth login` in a terminal.";
const PUSH_REJECTED_HINT = "The remote branch has commits you don't have. Pull or rebase, then push again.";
const DETACHED = gitMessage(GIT_CODES.DETACHED);
const DETACHED_COMMIT = gitMessage(GIT_CODES.DETACHED_COMMIT);
const NOT_REPO = "This chat's folder isn't a git repository.";
const NOT_TOP = "This folder isn't the top of a git checkout.";
const CONFLICTS = "Some files have unresolved conflicts. Resolve them, then commit.";

const OUTPUT_LIMIT = 6000;
const FILE_LIMIT = 300;
const DIFF_LIMIT = 40_000;
// Hooks may run tests, so commits and pushes get time; reads stay quick.
const GH_TIMEOUT = 60_000;
// The tree of an empty repository, to diff against before the first commit.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const HOOKS = ["pre-commit", "prepare-commit-msg", "commit-msg"];
// Git's own reasons a commit can fail; anything else with a commit hook installed is the hook's.
const GIT_COMMIT_ERRORS =
  /Please tell me who you are|Author identity unknown|nothing to commit|empty commit message|unable to auto-detect email|could not lock|index\.lock/i;
// A signing key that can't sign (gpg, ssh) is not something the agent can fix.
// Narrow on purpose: hook output saying "assigning" or "designing" is still the hook's.
const SIGNING_ERRORS = /gpg failed|failed to sign|signing (failed|key)/i;
// What git leaves behind while a merge, rebase, cherry-pick or revert waits to be finished.
const OPERATIONS = [
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
];
const LOCKFILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "cargo.lock", "poetry.lock", "gemfile.lock", "composer.lock"]);
// Example files are meant to be committed.
const ENV_TEMPLATES = /^\.env\.(example|sample|template)$/;

/** Paths whose contents never go to a model, and that are never committed from the dialog. */
function looksSecret(file) {
  const name = path.posix.basename(String(file)).toLowerCase();
  if (name.startsWith(".env")) return !ENV_TEMPLATES.test(name);
  return /\.(pem|key|p8)$/.test(name) || /^id_(rsa|ed25519)/.test(name) || name.includes("credential") || name.includes("secret");
}

function isLockfile(file) {
  return LOCKFILES.has(path.posix.basename(String(file)).toLowerCase());
}

/** Keeps the end of long output, where tools print what went wrong. */
function capOutput(text, limit = OUTPUT_LIMIT) {
  const trimmed = String(text ?? "").trim();
  return trimmed.length > limit ? `…\n${trimmed.slice(-limit)}` : trimmed;
}

function prNumber(url) {
  const match = /\/pull\/(\d+)/.exec(url ?? "");
  return match ? Number(match[1]) : null;
}

const excludeLiteral = (file) => `:(exclude,literal)${file}`;

/**
 * `gh` is the GitHub CLI to run: a name found on PATH (the app, after the login environment is in) or an
 * absolute path. Tests pass their fake's path, so a gh installed on the machine is never the one run.
 */
function createGitActions({ execFile = childProcess.execFile, env = process.env, gh = "gh" } = {}) {
  // No prompt may wait on a terminal nobody sees: git and ssh fail instead of asking for credentials.
  const baseEnv = () => ({
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes",
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
  });

  /** Runs a program and settles with its outcome; it never throws. A git or gh run waits for its slot (process-lanes.cjs). */
  function run(command, args, options) {
    const kind = kindOf(command);
    return kind ? lanes.run(kind, () => spawn(command, args, options)) : spawn(command, args, options);
  }
  function spawn(command, args, { cwd, input, timeout = GH_TIMEOUT } = {}) {
    return new Promise((resolve) => {
      let child;
      try {
        child = execFile(command, args, { cwd, env: baseEnv(), encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout }, (error, stdout, stderr) => {
          resolve({
            ok: !error,
            code: error ? (typeof error.code === "number" ? error.code : null) : 0,
            missing: error?.code === "ENOENT",
            timedOut: Boolean(error?.killed),
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
          });
        });
      } catch (error) {
        resolve({ ok: false, code: null, missing: error.code === "ENOENT", timedOut: false, stdout: "", stderr: error.message });
        return;
      }
      child.stdin?.on("error", () => {});
      child.stdin?.end(input ?? "");
    });
  }

  const client = createGit({ execFile, env });
  const { run: git, out: gitOut, refExists, chatBase } = client.read;
  const write = client.write.run;
  const gitList = async (cwd, args) => {
    const result = await git(cwd, args);
    return result.ok ? result.stdout.split("\0").filter(Boolean) : [];
  };

  /**
   * The folder must be the top of a checkout: a chat's worktree or project, never a folder inside
   * one, so a commit can't land in an enclosing repository.
   */
  async function checkTop(cwd) {
    const top = await gitOut(cwd, ["rev-parse", "--show-toplevel"]);
    if (!top) return { ok: false, message: NOT_REPO };
    const [realTop, realCwd] = await Promise.all([fs.realpath(top).catch(() => top), fs.realpath(cwd).catch(() => cwd)]);
    return realTop === realCwd ? { ok: true } : { ok: false, message: NOT_TOP };
  }

  async function currentBranch(cwd) {
    return gitOut(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  }

  async function remotes(cwd) {
    return ((await gitOut(cwd, ["remote"])) ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async function hasOrigin(cwd) {
    return (await git(cwd, ["remote", "get-url", "origin"])).ok;
  }

  async function gitPathExists(cwd, name) {
    const found = await gitOut(cwd, ["rev-parse", "--git-path", name]);
    if (!found) return false;
    try {
      await fs.access(path.resolve(cwd, found));
      return true;
    } catch {
      return false;
    }
  }

  /** Why nothing may be committed now: a merge, rebase, cherry-pick or revert to finish, or conflicts. */
  async function operationInProgress(cwd) {
    for (const [name, operation] of OPERATIONS) {
      if (await gitPathExists(cwd, name)) return `A ${operation} is in progress. Finish or abort it, then commit.`;
    }
    const unmerged = await gitOut(cwd, ["ls-files", "-u"]);
    return unmerged ? CONFLICTS : null;
  }

  async function countCommits(cwd, args) {
    const count = await gitOut(cwd, ["rev-list", "--count", ...args]);
    return count && /^\d+$/.test(count) ? Number(count) : 0;
  }

  /** Commits on HEAD the remote doesn't have: ahead of the upstream, or of every origin branch. */
  async function unpushedCount(cwd) {
    if (!(await refExists(cwd, "HEAD"))) return 0;
    if (await refExists(cwd, "@{upstream}")) return countCommits(cwd, ["@{upstream}..HEAD"]);
    return countCommits(cwd, ["HEAD", "--not", "--remotes=origin"]);
  }

  /** Staged, unstaged and untracked files with their line counts, in git's byte order. */
  async function changedFiles(cwd) {
    const status = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", ...PATHSPEC]);
    if (!status.ok) return [];
    const entries = status.stdout
      .split("\0")
      .filter(Boolean)
      .slice(0, FILE_LIMIT)
      .map((entry) => ({ code: entry.slice(0, 2), path: entry.slice(3) }));
    const head = (await refExists(cwd, "HEAD")) ? "HEAD" : EMPTY_TREE;
    const counts = new Map();
    for (const record of await gitList(cwd, ["diff", "--numstat", "-z", "--no-renames", head, ...PATHSPEC])) {
      const [added, removed, file] = record.split("\t");
      if (file) counts.set(file, { added: /^\d+$/.test(added) ? Number(added) : 0, removed: /^\d+$/.test(removed) ? Number(removed) : 0 });
    }
    const files = [];
    for (const { code, path: file } of entries) {
      const untracked = code === "??";
      const status = untracked || code.includes("A") ? "added" : code.includes("D") ? "deleted" : "modified";
      const lines = untracked ? { added: await fileLineCount(path.join(cwd, file)), removed: 0 } : (counts.get(file) ?? { added: 0, removed: 0 });
      files.push({ path: file, status, ...lines, untracked });
    }
    return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  function isAuthFailure(result) {
    return result.code === 4 || /gh auth login|not logged in|authentication required/i.test(result.stderr);
  }

  /**
   * The current branch's PR and whether gh can open one: `{ ghReady, ghMessage, pr }`. No branch is
   * named, so gh looks up the branch it would push (fork-aware), and a numeric branch name isn't
   * read as a PR number.
   */
  async function findPr(cwd) {
    const result = await run(gh, ["pr", "view", "--json", "url,state"], { cwd, timeout: GH_TIMEOUT });
    if (result.missing) return { ghReady: false, ghMessage: GH_MISSING, ghCode: GIT_CODES.GH_MISSING, pr: null };
    if (!result.ok && isAuthFailure(result)) return { ghReady: false, ghMessage: GH_LOGIN, pr: null };
    if (!result.ok && /no (open )?pull requests? found/i.test(result.stderr)) return { ghReady: true, ghMessage: null, pr: null };
    if (!result.ok) return { ghReady: false, ghMessage: capOutput(result.stderr || result.stdout, 600) || "gh couldn't look up this branch's PR.", pr: null };
    try {
      const view = JSON.parse(result.stdout);
      const open = String(view.state).toUpperCase() === "OPEN" && view.url;
      return { ghReady: true, ghMessage: null, pr: open ? { number: prNumber(view.url), url: view.url, state: "OPEN" } : null };
    } catch {
      return { ghReady: true, ghMessage: null, pr: null };
    }
  }

  /** The repository gh opens PRs against when there are several remotes, or null when none is set. */
  async function ghDefaultRepo(cwd) {
    const result = await run(gh, ["repo", "set-default", "--view"], { cwd, timeout: GH_TIMEOUT });
    const repo = result.ok ? result.stdout.trim().split("\n")[0]?.trim() : "";
    return repo && /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null;
  }

  /** What the dialog shows about a chat's folder; `{ isRepo: false, message }` when it can't be used. */
  async function readChanges({ cwd, base }) {
    const top = await checkTop(cwd);
    if (!top.ok) return { isRepo: false, message: top.message };
    const [branch, files, remoteNames, unpushed, resolved, blocked] = await Promise.all([
      currentBranch(cwd),
      changedFiles(cwd),
      remotes(cwd),
      unpushedCount(cwd),
      chatBase(cwd, base),
      operationInProgress(cwd),
    ]);
    const origin = remoteNames.includes("origin");
    const onBase = branch === resolved.name;
    const ahead = resolved.ref ? await countCommits(cwd, [`${resolved.ref}..HEAD`]) : 0;
    // gh is only asked when a PR could come of it.
    const gh = origin && branch && !onBase ? await findPr(cwd) : { ghReady: false, ghMessage: null, pr: null };
    const prRepo = gh.ghReady && remoteNames.length > 1 ? await ghDefaultRepo(cwd) : null;
    return {
      isRepo: true,
      branch,
      base: resolved.name,
      files: files.map(({ path: file, status, added, removed }) => ({ path: file, status, added, removed, ...(looksSecret(file) ? { secret: true } : {}) })),
      hasChanges: files.length > 0,
      unpushed,
      ahead,
      hasOrigin: origin,
      remotes: remoteNames.length,
      prRepo,
      onBase,
      commitBlocked: blocked,
      ...gh,
    };
  }

  // A failing commit is the hook's doing when a commit hook is installed and git gave none of its own reasons.
  async function hookFailed(cwd, output) {
    if (GIT_COMMIT_ERRORS.test(output)) return false;
    for (const hook of HOOKS) {
      const hookPath = await gitOut(cwd, ["rev-parse", "--git-path", `hooks/${hook}`]);
      if (!hookPath) continue;
      try {
        await fs.access(path.resolve(cwd, hookPath), fs.constants.X_OK);
        return true;
      } catch {}
    }
    return false;
  }

  /**
   * `git add -A`, then `git commit -F -` with the message on stdin. Hooks run; nothing is skipped. It
   * refuses mid-merge (or rebase, cherry-pick, revert), on a detached HEAD, and when a secret-looking
   * file would be committed, putting the index back as it was.
   */
  async function commit({ cwd, message }) {
    const top = await checkTop(cwd);
    if (!top.ok) return { ok: false, kind: "error", message: top.message };
    const text = String(message ?? "").trim();
    if (!text) return { ok: false, kind: "error", message: "Write a commit message first." };
    // A rebase also detaches HEAD; its own reason says more.
    const blocked = await operationInProgress(cwd);
    if (blocked) return { ok: false, kind: "blocked", message: blocked };
    if (!(await currentBranch(cwd))) return { ok: false, kind: "blocked", message: DETACHED_COMMIT, code: GIT_CODES.DETACHED_COMMIT };
    const hasHead = await refExists(cwd, "HEAD");
    // The index as the user left it, to go back to if the commit is refused.
    const before = (await write(cwd, ["write-tree"])).stdout.trim() || null;
    const added = await write(cwd, ["add", "-A", ...PATHSPEC], { profile: "COMMIT" });
    if (!added.ok) return { ok: false, kind: "error", message: capOutput(added.stderr || added.stdout) };
    // A .milagre path staged earlier (by an agent, say) isn't the chat's work either.
    await write(cwd, hasHead ? ["reset", "-q", "--", ".milagre"] : ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ".milagre"]);
    // Without rename detection a `git mv x .env` is an added .env, not a rename that slips past the filter.
    const secrets = (await gitList(cwd, ["diff", "--cached", "--name-only", "-z", "--no-renames", "--diff-filter=AM"])).filter(looksSecret);
    if (secrets.length) {
      if (before) {
        await write(cwd, ["read-tree", before]);
        await write(cwd, ["update-index", "-q", "--refresh"]);
      }
      return {
        ok: false,
        kind: "secrets",
        message: `These look like secrets and would be committed: ${secrets.join(", ")}. Add them to .gitignore, or commit them yourself if you mean to.`,
      };
    }
    if ((await git(cwd, ["diff", "--cached", "--quiet"])).ok) return { ok: false, kind: "nothing", message: "There's nothing to commit." };
    const committed = await write(cwd, ["commit", "-F", "-"], { input: `${text}\n`, profile: "COMMIT" });
    if (!committed.ok) {
      const output = capOutput([committed.stdout, committed.stderr].filter((part) => part.trim()).join("\n"));
      if (committed.timedOut) return { ok: false, kind: "error", message: "The commit took too long and was stopped.", output };
      if (SIGNING_ERRORS.test(output)) return { ok: false, kind: "signing", message: output };
      if (await hookFailed(cwd, output)) return { ok: false, kind: "hook", message: "The commit failed in a git hook.", output };
      return { ok: false, kind: "error", message: output || "The commit failed." };
    }
    const [sha, shortSha] = await Promise.all([gitOut(cwd, ["rev-parse", "HEAD"]), gitOut(cwd, ["rev-parse", "--short", "HEAD"])]);
    return { ok: true, sha, shortSha };
  }

  /**
   * Pushes the current branch to the same name on origin and sets it as the upstream. Never forced: the
   * refspec is spelled out, so a branch named "+x" can't turn into a force push.
   */
  async function push({ cwd }) {
    const top = await checkTop(cwd);
    if (!top.ok) return { ok: false, kind: "error", message: top.message };
    if (!(await hasOrigin(cwd))) return { ok: false, kind: "no-origin", message: NO_ORIGIN, code: GIT_CODES.NO_ORIGIN };
    const branch = await currentBranch(cwd);
    if (!branch) return { ok: false, kind: "error", message: DETACHED, code: GIT_CODES.DETACHED };
    const result = await write(cwd, ["push", "-u", "origin", `refs/heads/${branch}:refs/heads/${branch}`], { profile: "PUSH" });
    if (result.ok) return { ok: true, branch, remote: "origin" };
    const output = capOutput(result.stderr || result.stdout);
    if (/\[rejected\]|non-fast-forward|fetch first|\(stale info\)/i.test(output))
      return { ok: false, kind: "rejected", message: output, hint: PUSH_REJECTED_HINT };
    return { ok: false, kind: "error", message: result.timedOut ? "The push took too long and was stopped." : output || "The push failed." };
  }

  /** `gh pr create` into the base, with the body on stdin. gh works out the head, forks included. */
  async function openPr({ cwd, base, title, body }) {
    const top = await checkTop(cwd);
    if (!top.ok) return { ok: false, kind: "error", message: top.message };
    if (!(await hasOrigin(cwd))) return { ok: false, kind: "no-origin", message: NO_ORIGIN, code: GIT_CODES.NO_ORIGIN };
    const branch = await currentBranch(cwd);
    if (!branch) return { ok: false, kind: "error", message: DETACHED, code: GIT_CODES.DETACHED };
    const resolved = await chatBase(cwd, base);
    if (branch === resolved.name) return { ok: false, kind: "on-base", message: `You're on ${resolved.name}. Open a PR from a worktree branch.` };
    const prTitle = String(title ?? "").trim();
    if (!prTitle) return { ok: false, kind: "error", message: "Add a PR title first." };
    const result = await run(gh, ["pr", "create", `--base=${resolved.name}`, `--title=${prTitle}`, "--body-file", "-"], {
      cwd,
      input: String(body ?? ""),
      timeout: GH_TIMEOUT,
    });
    if (result.missing) return { ok: false, kind: "gh-missing", message: GH_MISSING, code: GIT_CODES.GH_MISSING };
    if (!result.ok && isAuthFailure(result)) return { ok: false, kind: "gh-auth", message: GH_LOGIN };
    if (!result.ok) return { ok: false, kind: "error", message: capOutput(result.stderr || result.stdout) || "gh couldn't open the PR." };
    const url = result.stdout.match(/https?:\/\/\S+\/pull\/\d+/g)?.at(-1);
    if (!url) return { ok: false, kind: "error", message: capOutput(result.stdout) || "gh didn't print the PR's link." };
    return { ok: true, url, number: prNumber(url) };
  }

  /** At most `limit` bytes of an untracked file, as a new-file diff; null for anything but a text file. */
  async function newFileDiff(cwd, file, limit) {
    const fullPath = path.join(cwd, file);
    try {
      const stat = await fs.lstat(fullPath);
      if (!stat.isFile()) return null;
      const handle = await fs.open(fullPath, "r");
      try {
        const length = Math.max(0, Math.min(stat.size, limit));
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, 0);
        if (buffer.includes(0)) return null;
        const lines = buffer.toString("utf8").split("\n");
        if (lines.at(-1) === "") lines.pop();
        const cut = stat.size > length ? `\n[${file} is cut off here.]` : "";
        return `diff --git a/${file} b/${file}\nnew file\n--- /dev/null\n+++ b/${file}\n${lines.map((line) => `+${line}`).join("\n")}${cut}\n`;
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  }

  /**
   * What the commit message and PR text are written from: a `git diff --stat`, the uncommitted diff
   * (or, with nothing to commit, the branch's diff against its base), the branch's commits and the
   * repo's recent subjects. Secret-looking files and lockfiles are named, never shown.
   */
  async function readTextContext({ cwd, base }) {
    const top = await checkTop(cwd);
    if (!top.ok) throw new Error(top.message);
    const [branch, resolved, files] = await Promise.all([currentBranch(cwd), chatBase(cwd, base), changedFiles(cwd)]);
    const hasChanges = files.length > 0;
    const hasHead = await refExists(cwd, "HEAD");
    const range = hasChanges ? [hasHead ? "HEAD" : EMPTY_TREE] : resolved.ref ? [`${resolved.ref}...HEAD`] : null;
    const paths = hasChanges ? files.map((file) => file.path) : range ? await gitList(cwd, ["diff", "--name-only", "-z", ...range, ...PATHSPEC]) : [];
    const omitted = paths
      .filter((file) => looksSecret(file) || isLockfile(file))
      .map((file) => ({ path: file, reason: looksSecret(file) ? "secret" : "lockfile" }));
    const hidden = new Set(omitted.map((item) => item.path));
    let diff = "";
    let stat = "";
    if (range) {
      diff = (await git(cwd, ["diff", "--no-color", "--no-ext-diff", ...range, ...PATHSPEC, ...[...hidden].map(excludeLiteral)])).stdout;
      stat = ((await gitOut(cwd, ["diff", "--stat=120", "--no-color", ...range, ...PATHSPEC])) ?? "").trim();
    }
    if (hasChanges) {
      const untracked = files.filter((file) => file.untracked);
      if (untracked.length) stat = [stat, ...untracked.map((file) => ` ${file.path} (new file, ${file.added} lines)`)].filter(Boolean).join("\n");
      for (const file of untracked) {
        if (hidden.has(file.path)) continue;
        const remaining = DIFF_LIMIT - diff.length;
        if (remaining <= 0) break;
        // A quarter of what's left each, so one big file can't crowd out the rest.
        diff += (await newFileDiff(cwd, file.path, Math.floor(remaining / 4))) ?? "";
      }
    }
    const lines = async (args) =>
      ((await gitOut(cwd, args)) ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    const [recentSubjects, branchCommits] = await Promise.all([
      hasHead ? lines(["log", "-n", "15", "--format=%s"]) : [],
      hasHead && resolved.ref && branch !== resolved.name ? lines(["log", "-n", "20", "--format=%s", `${resolved.ref}..HEAD`]) : [],
    ]);
    return { diff, stat, omitted, recentSubjects, branchCommits, branch, base: resolved.name, hasChanges };
  }

  return { readChanges, commit, push, openPr, readTextContext, checkTop };
}

module.exports = {
  CONFLICTS,
  DETACHED,
  DETACHED_COMMIT,
  GH_LOGIN,
  GH_MISSING,
  NOT_REPO,
  NOT_TOP,
  NO_ORIGIN,
  createGitActions,
  looksSecret,
};
