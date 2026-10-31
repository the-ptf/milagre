const { execFile: execute } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { lanes: sharedLanes } = require("../process-lanes.cjs");

const limit = (timeout) => Object.freeze({ timeout, maxBuffer: 16 * 1024 * 1024 });
const LIMITS = Object.freeze({
  READ: limit(10000),
  NETWORK: limit(30000),
  REMOVE: limit(300000),
  COMMIT: limit(300000),
  PUSH: limit(300000),
  WRITE: limit(300000),
});

function outcome(error, stdout = "", stderr = "") {
  return {
    ok: !error,
    code: error ? (typeof error.code === "number" ? error.code : null) : 0,
    missing: error?.code === "ENOENT",
    timedOut: Boolean(error?.killed),
    overflow: error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    stdout: String(stdout ?? ""),
    stderr: String(stderr ?? ""),
    message: error ? String(stderr ?? "").trim() || error.message : "",
  };
}

class GitError extends Error {
  constructor(result) {
    super(result.message);
    Object.assign(this, result);
    this.name = "GitError";
  }
}

// Call sites select the read or write surface explicitly. This is not an API for untrusted raw Git arguments.
function isRead(args) {
  if (args.some((arg) => arg === "--output" || arg.startsWith("--output="))) return false;
  // `git grep -O` hands its matches to a pager or editor. Only options count: a pattern follows -e, paths follow --.
  if (args[0] === "grep") {
    const end = args.indexOf("--");
    const options = args.slice(1, end === -1 ? undefined : end).filter((arg, index, list) => list[index - 1] !== "-e");
    return !options.some((arg) => arg.startsWith("-O") || arg.startsWith("--open-files-in-pager"));
  }
  if (["status", "diff", "rev-parse", "rev-list", "merge-base", "for-each-ref", "ls-files", "check-ignore", "log", "show", "cat-file"].includes(args[0]))
    return true;
  if (args[0] === "worktree") return args[1] === "list";
  if (args[0] === "remote") return args.length === 1 || args[1] === "get-url";
  if (args[0] === "symbolic-ref") return !args.includes("--delete") && !args.includes("-d") && args.slice(1).filter((arg) => !arg.startsWith("-")).length === 1;
  return false;
}

/** Adapt existing promise-based process injection at a module boundary. */
function callbackExec(exec) {
  return (command, args, options, done) => {
    Promise.resolve()
      .then(() => exec(command, args, options))
      .then(
        // oxlint-disable-next-line promise/no-callback-in-promise -- bridges the promise-based exec to the callback API; done is the caller's Node-style callback
        (result) => done(null, result.stdout, result.stderr),
        // oxlint-disable-next-line promise/no-callback-in-promise -- bridges the promise-based exec to the callback API; done is the caller's Node-style callback
        (error) => done(error, error.stdout, error.stderr),
      );
  };
}

function createGit({
  execFile = execute,
  env = process.env,
  platform = process.platform,
  realpath = fs.realpath,
  analysisOnly = false,
  lanes = sharedLanes,
} = {}) {
  // Each run waits for a git slot (process-lanes.cjs) and holds it until the process exits.
  function executeGit(cwd, args, options = {}) {
    if (!LIMITS[options.profile ?? "READ"]) throw new Error(`Unknown Git limit profile: ${options.profile}`);
    return lanes.run("git", () => spawnGit(cwd, args, options));
  }
  function spawnGit(cwd, args, { profile = "READ", input, config = [] } = {}) {
    const limits = LIMITS[profile];
    return new Promise((resolve) => {
      try {
        // Analysis runs in the host, so provider sandboxes cannot protect it from Git's configured helpers.
        const processEnv = analysisOnly ? Object.fromEntries(Object.entries(env).filter(([name]) => !name.toUpperCase().startsWith("GIT_"))) : env;
        const readArgs = analysisOnly && ["diff", "log", "show"].includes(args[0]) ? [args[0], "--no-ext-diff", "--no-textconv", ...args.slice(1)] : args;
        const child = execFile(
          "git",
          [
            "-C",
            cwd,
            ...(analysisOnly ? ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "submodule.recurse=false"] : []),
            ...config.flatMap((value) => ["-c", value]),
            ...readArgs,
          ],
          {
            cwd,
            ...limits,
            encoding: "utf8",
            env: {
              ...processEnv,
              GIT_TERMINAL_PROMPT: "0",
              GIT_SSH_COMMAND: processEnv.GIT_SSH_COMMAND || "ssh -o BatchMode=yes",
            },
          },
          (error, stdout, stderr) => resolve(outcome(error, stdout, stderr)),
        );
        child?.stdin?.on("error", () => {});
        child?.stdin?.end(input ?? "");
      } catch (error) {
        resolve(outcome(error, "", error.stderr));
      }
    });
  }
  async function run(cwd, args, options) {
    if (!isRead(args)) throw new Error(`Git ${args[0]} requires the write surface; this surface is read-only.`);
    if (!analysisOnly) return executeGit(cwd, args, options);
    // Even status/diff can clean worktree files. Read configuration without running filters,
    // then neutralize every configured driver, including required and long-running filters.
    const filters = await executeGit(cwd, ["config", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"]);
    if (!filters.ok && filters.code !== 1) return filters;
    const drivers = new Set(
      filters.stdout
        .split("\0")
        .filter(Boolean)
        .map((key) => key.slice(0, key.lastIndexOf("."))),
    );
    const config = [...drivers].flatMap((driver) => [`${driver}.clean=`, `${driver}.smudge=`, `${driver}.process=`, `${driver}.required=false`]);
    return executeGit(cwd, args, { ...options, config });
  }
  const check = (result) => {
    if (!result.ok) throw new GitError(result);
    return result;
  };
  const checked = async (cwd, args, options) => check(await run(cwd, args, options));
  const text = async (cwd, args, options) => (await checked(cwd, args, options)).stdout;
  const out = async (cwd, args) => {
    const result = await run(cwd, args);
    return result.ok ? result.stdout.trim() : null;
  };
  const commitOf = (cwd, ref) => out(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  const refExists = async (cwd, ref) => (await run(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`])).ok;

  async function resolveBase(cwd, recorded) {
    if (typeof recorded === "string" && recorded && !recorded.startsWith("-") && (await refExists(cwd, recorded))) {
      const full = await out(cwd, ["rev-parse", "--symbolic-full-name", recorded]);
      const named = /^refs\/(?:remotes\/[^/]+|heads)\/(.+)$/.exec(full ?? "");
      if (named && full.startsWith("refs/heads/")) {
        // A local base that is behind its remote, or has diverged from it (a force-pushed main), would count
        // everyone else's merged work as the chat's; compare against the remote unless the local branch is ahead.
        const upstream = (await out(cwd, ["for-each-ref", "--format=%(upstream)", full])) || `refs/remotes/origin/${named[1]}`;
        if (
          upstream.startsWith("refs/remotes/") &&
          (await refExists(cwd, upstream)) &&
          !(await run(cwd, ["merge-base", "--is-ancestor", "--end-of-options", upstream, full])).ok
        )
          return { name: named[1], ref: upstream };
      }
      if (named) return { name: named[1], ref: recorded };
    }
    const remoteHead = await out(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
    const name =
      remoteHead?.replace(/^refs\/remotes\/origin\//, "") ||
      ((await refExists(cwd, "refs/heads/main")) || (await refExists(cwd, "refs/remotes/origin/main"))
        ? "main"
        : (await refExists(cwd, "refs/heads/master")) || (await refExists(cwd, "refs/remotes/origin/master"))
          ? "master"
          : "main");
    for (const ref of [`refs/remotes/origin/${name}`, `refs/heads/${name}`]) if (await refExists(cwd, ref)) return { name, ref };
    return { name, ref: null };
  }

  // The branch the checked-out branch was made from, by its reflog's first entry ("branch: Created from feature"), or
  // null when it was made from HEAD or a bare commit, or the reflog is gone. Worktrees Milagre didn't make (an agent's,
  // one made by hand) record no base, and a branch cut from a feature branch shouldn't be measured against main.
  async function createdFrom(cwd) {
    const branch = await out(cwd, ["symbolic-ref", "--quiet", "HEAD"]);
    if (!branch?.startsWith("refs/heads/")) return null;
    const entries = await out(cwd, ["log", "--walk-reflogs", "--format=%gs", "--end-of-options", branch]);
    const from = /^branch: Created from (.+)$/.exec(entries?.split("\n").at(-1) ?? "")?.[1];
    if (!from || from === "HEAD" || /^[0-9a-f]{7,64}$/i.test(from)) return null;
    // Checked out from its own remote copy ("origin/<branch>" or "refs/remotes/origin/<branch>", e.g. someone's PR
    // branch): that copy is not a base.
    const name = branch.slice("refs/heads/".length);
    return /^(?:refs\/remotes\/)?[^/]+\/(.+)$/.exec(from)?.[1] === name || from === name ? null : from;
  }

  /** The base a chat's changes are measured against: the one Milagre recorded, else the branch it was made from, else the default. */
  async function chatBase(cwd, recorded) {
    return resolveBase(cwd, typeof recorded === "string" && recorded ? recorded : await createdFrom(cwd));
  }

  // `worktree list -z` needs Git 2.36. Older Git rejects the switch, so fall back to newline records and remember which form works.
  let nulSeparated = true;
  async function worktreeBlocks(cwd) {
    if (nulSeparated) {
      const result = await run(cwd, ["worktree", "list", "--porcelain", "-z"]);
      if (result.ok)
        return result.stdout
          .split("\0\0")
          .filter(Boolean)
          .map((block) => block.split("\0"));
      // 129 is Git's usage-error exit code, whatever language its message is in.
      if (result.code !== 129 && !/unknown switch .z.|usage: git worktree/i.test(result.stderr)) throw new GitError(result);
      nulSeparated = false;
    }
    const output = await text(cwd, ["worktree", "list", "--porcelain"]);
    return output
      .split(/\r?\n\r?\n/)
      .map((block) => block.split(/\r?\n/).filter(Boolean))
      .filter((fields) => fields.length);
  }

  async function worktreeList(cwd) {
    const listed = await Promise.all(
      (await worktreeBlocks(cwd)).map(async (fields) => {
        const folder = fields.find((field) => field.startsWith("worktree "))?.slice(9);
        if (!folder) return null;
        const branch = fields
          .find((field) => field.startsWith("branch "))
          ?.slice(7)
          .replace(/^refs\/heads\//, "");
        // Git's spelling can differ from Node's (slashes, drive case or aliases).
        // Resolve existing Windows worktrees through the OS, preserving missing
        // entries for activeWorktrees to filter out as before.
        let nativePath = folder;
        if (platform === "win32") {
          try {
            nativePath = await realpath(folder);
          } catch (error) {
            if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
          }
          nativePath = path.win32.normalize(nativePath);
        }
        return { path: nativePath, name: branch || (platform === "win32" ? path.win32 : path).basename(nativePath) };
      }),
    );
    return listed.filter(Boolean);
  }
  const commonDir = async (cwd) => fs.realpath(path.resolve(cwd, (await text(cwd, ["rev-parse", "--git-common-dir"])).trim()));
  const read = Object.freeze({ run, checked, text, out, commitOf, refExists, resolveBase, createdFrom, chatBase, worktreeList, commonDir });
  const writeRun = (cwd, args, options) => {
    if (analysisOnly) throw new Error("Analysis Git is read-only.");
    return executeGit(cwd, args, { profile: "WRITE", ...options });
  };
  const write = Object.freeze({ run: writeRun, checked: async (cwd, args, options) => check(await writeRun(cwd, args, options)) });
  return Object.freeze({ ...read, read, write });
}

module.exports = { createGit, callbackExec, GitError, LIMITS };
